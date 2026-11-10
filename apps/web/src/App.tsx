import { Screen } from '@astro-soul/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api, FieldError } from './api';
import { ErrorState } from './components/ErrorState';
import { useRequest } from './hooks/useRequest';
import { CONSENT_VERSION, ru } from './i18n/ru';
import { EMPTY_DRAFT, toChartRequest, type BirthDraft, type BirthStep } from './lib/birth';
import { BirthDateScreen } from './screens/BirthDateScreen';
import { BirthPlaceScreen } from './screens/BirthPlaceScreen';
import { BirthTimeScreen } from './screens/BirthTimeScreen';
import { BootScreen } from './screens/BootScreen';
import { ChartScreen } from './screens/chart/ChartScreen';
import { ConsentScreen, type LegalDocument } from './screens/ConsentScreen';
import { DocumentScreen } from './screens/DocumentScreen';
import { WelcomeScreen } from './screens/welcome/WelcomeScreen';
import type { Telegram } from './telegram';

export interface AppProps {
  api: Api;
  telegram: Telegram;
  /** API origin without a trailing slash; '' = this page's origin. */
  apiBaseUrl: string;
  /** The current moment, the reference for the 18+ check. Tests pin it; the app reads the device clock once at start. */
  today?: Date;
}

/** Signs the user in (`GET /me` validates initData) before any screen is shown. */
export function App({ api, telegram, apiBaseUrl, today }: AppProps) {
  const loadMe = useCallback((signal: AbortSignal) => api.getMe(signal), [api]);
  const me = useRequest(loadMe);

  useEffect(() => {
    // The first frame is drawn: Telegram may swap its placeholder for the app.
    telegram.ready();
  }, [telegram]);

  if (me.status === 'loading') return <BootScreen />;
  if (me.status === 'error') {
    return (
      <Screen>
        <ErrorState error={me.error} telegram={telegram} onRetry={me.retry} />
      </Screen>
    );
  }
  return (
    <Onboarding
      api={api}
      telegram={telegram}
      apiBaseUrl={apiBaseUrl}
      today={today}
      // The contract gives no way to load an existing chart (no chart_id in Me),
      // so a returning user re-enters the data; POST /charts is idempotent by input.
      returning={me.data.has_chart === true}
    />
  );
}

type Route = 'welcome' | 'consent' | LegalDocument | BirthStep | 'chart';

/** The screens that collect the chart request, in the order the user passes them. */
const FORM_ROUTES = ['consent', 'birthDate', 'birthTime', 'birthPlace'] as const;

/** Which screen collects each field of `POST /charts`, by the name the server reports the field under. */
const FIELD_ROUTES = {
  consent: 'consent',
  birth_date: 'birthDate',
  time_precision: 'birthTime',
  birth_time: 'birthTime',
  birth_place: 'birthPlace',
} as const satisfies Record<string, (typeof FORM_ROUTES)[number]>;

type ChartField = keyof typeof FIELD_ROUTES;
/** The server's text for every field it rejected in the last chart request. */
type ServerErrors = ReadonlyMap<ChartField, string>;

const NO_SERVER_ERRORS: ServerErrors = new Map();

function isChartField(field: string): field is ChartField {
  return Object.prototype.hasOwnProperty.call(FIELD_ROUTES, field);
}

/**
 * Where the user fixes what the server rejected: its texts by field, and the stack
 * that ends at the earliest screen owning one of them, so the user walks forward
 * through the rest. Null when no screen owns any of the fields.
 */
function routeRejection(errors: readonly FieldError[]): { messages: ServerErrors; stack: readonly Route[] } | null {
  const messages = new Map<ChartField, string>();
  let earliest: number = FORM_ROUTES.length;
  for (const { field, message } of errors) {
    // The list is in the order of the server's checks: the first text about a field is the one to show.
    if (!isChartField(field) || messages.has(field)) continue;
    messages.set(field, message);
    earliest = Math.min(earliest, FORM_ROUTES.indexOf(FIELD_ROUTES[field]));
  }
  if (messages.size === 0) return null;
  return { messages, stack: ['welcome', ...FORM_ROUTES.slice(0, earliest + 1)] };
}

interface OnboardingProps extends AppProps {
  returning: boolean;
}

/**
 * The screens up to the chart as an in-memory stack. No router: Telegram owns the
 * URL (launch parameters live in the hash) and birth data must not end up in it.
 */
function Onboarding({ api, telegram, apiBaseUrl, today: pinnedToday, returning }: OnboardingProps) {
  const [today] = useState(() => pinnedToday ?? new Date());
  const [stack, setStack] = useState<readonly Route[]>(['welcome']);
  const [draft, setDraft] = useState<BirthDraft>(EMPTY_DRAFT);
  const [serverErrors, setServerErrors] = useState(NO_SERVER_ERRORS);
  const route = stack[stack.length - 1] ?? 'welcome';
  const canGoBack = stack.length > 1;

  const open = (next: Route) => {
    setStack((current) => [...current, next]);
  };
  const goBack = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);
  /** Stores what the user changed. The server's verdict on the fields behind it was about the old value: drop it. */
  const update = (changes: Partial<BirthDraft>, ...fields: ChartField[]) => {
    setDraft((current) => ({ ...current, ...changes }));
    setServerErrors((current) => {
      if (!fields.some((field) => current.has(field))) return current;
      const next = new Map(current);
      for (const field of fields) next.delete(field);
      return next;
    });
  };
  const handleRejected = useCallback((errors: readonly FieldError[]) => {
    const rejection = routeRejection(errors);
    // Fields no screen collects: the chart screen stays and shows the error itself.
    if (rejection === null) return;
    setServerErrors(rejection.messages);
    setStack(rejection.stack);
  }, []);

  useEffect(() => {
    telegram.setBackHandler(canGoBack ? goBack : null);
    return () => {
      telegram.setBackHandler(null);
    };
  }, [telegram, canGoBack, goBack]);

  // Clients without the native button (old Telegram, a plain browser) get one inside the page.
  const back = canGoBack && !telegram.hasNativeBackButton ? { label: ru.common.back, onClick: goBack } : undefined;
  const request = useMemo(() => toChartRequest(draft, today), [draft, today]);

  if (route === 'chart' && request !== null) {
    return (
      <ChartScreen
        api={api}
        telegram={telegram}
        request={request}
        apiBaseUrl={apiBaseUrl}
        back={back}
        onEdit={() => {
          setStack(['welcome', 'consent', 'birthDate']);
        }}
        onRejected={handleRejected}
      />
    );
  }

  switch (route) {
    case 'welcome':
      return (
        <WelcomeScreen
          returning={returning}
          onStart={() => {
            open('consent');
          }}
        />
      );
    case 'consent':
      return (
        <ConsentScreen
          accepted={draft.consentVersion !== null}
          serverError={serverErrors.get('consent')}
          back={back}
          onChange={(accepted) => {
            // The version recorded is the one of the text on screen at the moment of the tap.
            update({ consentVersion: accepted ? CONSENT_VERSION : null }, 'consent');
          }}
          onOpenDocument={open}
          onNext={() => {
            open('birthDate');
          }}
        />
      );
    case 'privacy':
    case 'terms':
      return <DocumentScreen name={route} back={back} />;
    case 'birthDate':
      return (
        <BirthDateScreen
          value={draft.date}
          today={today}
          serverError={serverErrors.get('birth_date')}
          back={back}
          onChange={(date) => {
            update({ date }, 'birth_date');
          }}
          onNext={() => {
            open('birthTime');
          }}
        />
      );
    case 'birthTime':
      return (
        <BirthTimeScreen
          mode={draft.timePrecision}
          time={draft.time}
          precisionError={serverErrors.get('time_precision')}
          timeError={serverErrors.get('birth_time')}
          back={back}
          onModeChange={(timePrecision) => {
            // The option decides whether a time is sent at all, so it answers for both fields.
            update({ timePrecision }, 'time_precision', 'birth_time');
          }}
          onTimeChange={(time) => {
            update({ time }, 'birth_time');
          }}
          onNext={() => {
            open('birthPlace');
          }}
        />
      );
    default:
      // 'birthPlace', and 'chart' without a complete draft (not reachable through the UI).
      return (
        <BirthPlaceScreen
          api={api}
          telegram={telegram}
          query={draft.placeQuery}
          place={draft.place}
          serverError={serverErrors.get('birth_place')}
          back={back}
          onChange={(placeQuery, place) => {
            update({ placeQuery, place }, 'birth_place');
          }}
          onNext={() => {
            // A new request gets a new verdict on every field.
            setServerErrors(NO_SERVER_ERRORS);
            open('chart');
          }}
        />
      );
  }
}
