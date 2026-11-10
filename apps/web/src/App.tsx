import { Screen } from '@astro-soul/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from './api';
import { ErrorState } from './components/ErrorState';
import { useRequest } from './hooks/useRequest';
import { ru } from './i18n/ru';
import { EMPTY_DRAFT, toChartRequest, type BirthDraft, type BirthStep } from './lib/birth';
import { BirthDateScreen } from './screens/BirthDateScreen';
import { BirthPlaceScreen } from './screens/BirthPlaceScreen';
import { BirthTimeScreen } from './screens/BirthTimeScreen';
import { BootScreen } from './screens/BootScreen';
import { ChartScreen } from './screens/chart/ChartScreen';
import { WelcomeScreen } from './screens/welcome/WelcomeScreen';
import type { Telegram } from './telegram';

export interface AppProps {
  api: Api;
  telegram: Telegram;
  /** API origin without a trailing slash; '' = this page's origin. */
  apiBaseUrl: string;
  /** The current day. Tests pin it; the app reads the device clock once at start. */
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

type Route = 'welcome' | BirthStep | 'chart';

interface OnboardingProps extends AppProps {
  returning: boolean;
}

/**
 * Screens 1–5 as an in-memory stack. No router: Telegram owns the URL (launch
 * parameters live in the hash) and birth data must not end up in it.
 */
function Onboarding({ api, telegram, apiBaseUrl, today: pinnedToday, returning }: OnboardingProps) {
  const [today] = useState(() => pinnedToday ?? new Date());
  const [stack, setStack] = useState<readonly Route[]>(['welcome']);
  const [draft, setDraft] = useState<BirthDraft>(EMPTY_DRAFT);
  const route = stack[stack.length - 1] ?? 'welcome';
  const canGoBack = stack.length > 1;

  const open = (next: Route) => {
    setStack((current) => [...current, next]);
  };
  const goBack = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);
  const update = (changes: Partial<BirthDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };

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
        timeApproximate={draft.timeMode === 'approx'}
        back={back}
        onEdit={() => {
          setStack(['welcome', 'birthDate']);
        }}
      />
    );
  }

  switch (route) {
    case 'welcome':
      return (
        <WelcomeScreen
          returning={returning}
          onStart={() => {
            open('birthDate');
          }}
        />
      );
    case 'birthDate':
      return (
        <BirthDateScreen
          value={draft.date}
          today={today}
          back={back}
          onChange={(date) => {
            update({ date });
          }}
          onNext={() => {
            open('birthTime');
          }}
        />
      );
    case 'birthTime':
      return (
        <BirthTimeScreen
          mode={draft.timeMode}
          time={draft.time}
          back={back}
          onModeChange={(timeMode) => {
            update({ timeMode });
          }}
          onTimeChange={(time) => {
            update({ time });
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
          back={back}
          onChange={(placeQuery, place) => {
            update({ placeQuery, place });
          }}
          onNext={() => {
            open('chart');
          }}
        />
      );
  }
}
