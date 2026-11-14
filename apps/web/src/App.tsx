import { Button, InfoIcon, Screen, StateView } from '@astro-soul/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyticsStep, Track } from './analytics';
import type { Api, ChartCreateRequest, ChartResult, FieldError, Me, Report } from './api';
import { ErrorState } from './components/ErrorState';
import { useRequest } from './hooks/useRequest';
import { CONSENT_VERSION, ru } from './i18n/ru';
import { EMPTY_DRAFT, toChartRequest, type BirthDraft, type BirthStep } from './lib/birth';
import type { IdempotencyKeys } from './lib/idempotency';
import { grants, REPORT_PLAN, type PaywallPlan } from './lib/plans';
import type { TermsReload } from './lib/termsReload';
import { BirthDateScreen } from './screens/BirthDateScreen';
import { BirthPlaceScreen } from './screens/BirthPlaceScreen';
import { BirthTimeScreen } from './screens/BirthTimeScreen';
import { BootScreen } from './screens/BootScreen';
import { ChartScreen, type OpenChart } from './screens/chart/ChartScreen';
import { ConsentScreen, type LegalDocument } from './screens/ConsentScreen';
import { DocumentScreen } from './screens/DocumentScreen';
import { PaywallScreen } from './screens/paywall/PaywallScreen';
import { ReportScreen } from './screens/report/ReportScreen';
import { DeletedScreen } from './screens/settings/DeletedScreen';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { WelcomeScreen } from './screens/welcome/WelcomeScreen';
import type { Telegram } from './telegram';

export interface AppProps {
  api: Api;
  telegram: Telegram;
  /** API origin without a trailing slash; '' = this page's origin. */
  apiBaseUrl: string;
  /** Username of the bot for the link in a shared message, without `@`; '' = no link. */
  botUsername?: string;
  /** Where the support button leads; '' = no contact yet, the button says so. */
  supportLink?: string;
  /** The idempotency keys of report orders, kept across a reload of the page. */
  keys: IdempotencyKeys;
  /** Reports product events (`POST /events`). Keep the reference stable. */
  track: Track;
  /** Restarts the app for newer legal texts, and tells a start after such a restart from an ordinary one. */
  termsReload: TermsReload;
  /** The current moment, the reference for the 18+ check. Tests pin it; the app reads the device clock once at start. */
  today?: Date;
}

/**
 * Where this build stands with the version of its legal texts (`CONSENT_VERSION`):
 *  - `current`: nothing is known against it;
 *  - `renewed`: the server refused the texts of the build that ran a moment ago, the
 *    app restarted itself, and this build has other texts. The user confirms them;
 *  - `outdated`: the server refused the texts, and this build has the very same ones.
 *    No chart can be built with it;
 *  - `reloading`: the restart is under way.
 */
type TermsState = 'current' | 'renewed' | 'outdated' | 'reloading';

function termsAtStart(refusedVersion: string | null): TermsState {
  if (refusedVersion === null) return 'current';
  return refusedVersion === CONSENT_VERSION ? 'outdated' : 'renewed';
}

/** Signs the user in (`GET /me` validates initData) before any screen is shown. */
export function App({ api, telegram, apiBaseUrl, botUsername = '', supportLink = '', keys, track, termsReload, today }: AppProps) {
  const loadMe = useCallback((signal: AbortSignal) => api.getMe(signal), [api]);
  const me = useRequest(loadMe);
  const [terms, setTerms] = useState(() => termsAtStart(termsReload.refusedVersion));
  // The server has deleted everything about the user: nothing the app holds is true any more.
  const [deleted, setDeleted] = useState(false);
  const handleDeleted = useCallback(() => {
    setDeleted(true);
  }, []);

  useEffect(() => {
    // The first frame is drawn: Telegram may swap its placeholder for the app.
    telegram.ready();
  }, [telegram]);

  // Once per start. A ref, not the effect alone: a development build runs every effect twice.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('app_open');
  }, [track]);

  /**
   * The server refused the consent version of this build, so its legal texts are not the
   * current ones. They are part of the bundle: newer ones come only with a reload.
   */
  const handleConsentRefused = useCallback(() => {
    // The next start has to know why it happened. If that cannot be kept, a silent
    // restart would look like a crash: say what is going on and leave the reload to the user.
    if (!termsReload.remember(CONSENT_VERSION)) {
      setTerms('outdated');
      return;
    }
    setTerms('reloading');
    termsReload.reload();
  }, [termsReload]);

  if (deleted) return <DeletedScreen telegram={telegram} />;
  if (terms === 'outdated') {
    return (
      <Screen>
        <StateView role="alert" icon={<InfoIcon />} title={ru.termsUpdate.outdatedTitle} text={ru.termsUpdate.outdatedText}>
          <Button
            onClick={() => {
              // Asked for by the user, so it goes ahead even when the reason cannot be kept for the next start.
              termsReload.remember(CONSENT_VERSION);
              setTerms('reloading');
              termsReload.reload();
            }}
          >
            {ru.termsUpdate.reload}
          </Button>
          {telegram.isTelegram && (
            <Button
              variant="secondary"
              onClick={() => {
                telegram.close();
              }}
            >
              {ru.common.close}
            </Button>
          )}
        </StateView>
      </Screen>
    );
  }
  if (terms === 'reloading' || me.status === 'loading') return <BootScreen />;
  if (me.status === 'error') {
    return (
      <Screen>
        <ErrorState error={me.error} telegram={telegram} onRetry={me.retry} />
      </Screen>
    );
  }
  return (
    <Screens
      api={api}
      telegram={telegram}
      apiBaseUrl={apiBaseUrl}
      botUsername={botUsername}
      supportLink={supportLink}
      keys={keys}
      track={track}
      today={today}
      me={me.data}
      termsRenewed={terms === 'renewed'}
      onConsentRefused={handleConsentRefused}
      onDeleted={handleDeleted}
    />
  );
}

/**
 * `current` is the chart the user already has, opened from the server; `chart` is the one
 * built from the form. `paywall`, `report` and `settings` open over either.
 */
type Route = 'welcome' | 'consent' | LegalDocument | BirthStep | 'chart' | 'current' | 'paywall' | 'report' | 'settings';
/** Where the stack starts: at the user's chart, or at the welcome screen while there is none. */
type Home = Extract<Route, 'welcome' | 'current'>;

/** The screens under the names the product events call them. */
const STEP_OF: Record<Route, AnalyticsStep> = {
  welcome: 'welcome',
  consent: 'consent',
  privacy: 'privacy',
  terms: 'terms',
  birthDate: 'birth_date',
  birthTime: 'birth_time',
  birthPlace: 'birth_place',
  chart: 'chart',
  current: 'chart',
  paywall: 'paywall',
  report: 'report',
  settings: 'settings',
};

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

/**
 * The field the server names when it refuses the version of the consent, not the consent
 * itself. No screen can fix it: the texts the user agreed to are no longer the current ones.
 */
const CONSENT_VERSION_FIELD = 'consent.version';

type ChartField = keyof typeof FIELD_ROUTES;
/** The server's text for every field it rejected in the last chart request. */
type ServerErrors = ReadonlyMap<ChartField, string>;

const NO_SERVER_ERRORS: ServerErrors = new Map();

function isChartField(field: string): field is ChartField {
  return Object.prototype.hasOwnProperty.call(FIELD_ROUTES, field);
}

/**
 * Where the user fixes what the server rejected: its texts by field, and the screens of
 * the form up to the earliest one owning one of them, so the user walks forward
 * through the rest. Null when no screen owns any of the fields.
 */
function routeRejection(errors: readonly FieldError[]): { messages: ServerErrors; routes: readonly Route[] } | null {
  const messages = new Map<ChartField, string>();
  let earliest: number = FORM_ROUTES.length;
  for (const { field, message } of errors) {
    // The list is in the order of the server's checks: the first text about a field is the one to show.
    if (!isChartField(field) || messages.has(field)) continue;
    messages.set(field, message);
    earliest = Math.min(earliest, FORM_ROUTES.indexOf(FIELD_ROUTES[field]));
  }
  if (messages.size === 0) return null;
  return { messages, routes: FORM_ROUTES.slice(0, earliest + 1) };
}

interface ScreensProps extends Omit<AppProps, 'termsReload' | 'botUsername' | 'supportLink'> {
  botUsername: string;
  supportLink: string;
  /** Who the user is, as the server said when the app started. */
  me: Me;
  /** This start follows a restart for newer legal texts: it opens on the consent screen, which says so. */
  termsRenewed: boolean;
  /** The server refused the consent version. Keep the reference stable. */
  onConsentRefused: () => void;
  /** The server has deleted everything about the user. */
  onDeleted: () => void;
}

/** What the paywall was opened for. */
interface PaywallEntry {
  /** The plan already chosen for the user, e.g. by the button under the teaser. */
  plan: PaywallPlan | null;
  /** The full report is on offer: the paywall was opened for it. */
  offersReport: boolean;
  /** The server refused to order a report and that is why the paywall is open. */
  reportRequired: boolean;
}

/** How the report screen was entered. */
interface ReportEntry {
  /** The report to open; null when there is none known. */
  reportId: string | null;
  /** The tap that led to the screen asked for the report: it is ordered at once. */
  orderAtOnce: boolean;
  /** The report was bought a moment ago, in this visit. */
  justPaid: boolean;
}

/** The charts the chart screen has shown, so that coming back to it asks the server nothing. */
interface ShownCharts {
  /** The user's chart, opened from the server. */
  current: ChartResult | null;
  /** The chart built from the form, and the request it answers. */
  built: { request: ChartCreateRequest; result: ChartResult } | null;
}

/**
 * The screens as an in-memory stack. No router: Telegram owns the URL (launch
 * parameters live in the hash) and birth data must not end up in it.
 */
function Screens({
  api,
  telegram,
  apiBaseUrl,
  botUsername,
  supportLink,
  keys,
  track,
  today: pinnedToday,
  me: meAtStart,
  termsRenewed,
  onConsentRefused,
  onDeleted,
}: ScreensProps) {
  const [today] = useState(() => pinnedToday ?? new Date());
  // What the server last said about the user. Access is read from here and from nowhere else.
  const [me, setMe] = useState(meAtStart);
  // The report the app knows of: the one `Me` names, then whichever the report screen meets.
  const [reportId, setReportId] = useState<string | null>(meAtStart.latest_report_id ?? null);
  // And the server's last word about it, so the chart screen can show it at once and ask again behind it.
  const [knownReport, setKnownReport] = useState<Report | null>(null);
  // A plan Telegram called paid in this visit and the server has not granted yet. Until it does,
  // no screen offers to pay for it again. The ref is for the moment the answer comes, the state for the screens.
  const [awaitedPlan, setAwaitedPlan] = useState<PaywallPlan | null>(null);
  const awaited = useRef<PaywallPlan | null>(null);
  const awaitPayment = useCallback((plan: PaywallPlan) => {
    awaited.current = plan;
    setAwaitedPlan(plan);
  }, []);
  const refreshMe = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await api.getMe(signal);
      setMe(fresh);
      if (typeof fresh.latest_report_id === 'string') setReportId(fresh.latest_report_id);
      const plan = awaited.current;
      if (plan !== null && grants(fresh, plan)) {
        // The one confirmation of a payment there is, counted here once, whichever screen asked the server.
        awaited.current = null;
        setAwaitedPlan(null);
        track('payment_succeeded', { plan_code: plan });
      }
      return fresh;
    },
    [api, track],
  );
  // Either field says it. Whether the chart is really there is the answer of `GET /charts/current`.
  const [home, setHome] = useState<Home>(meAtStart.has_chart || typeof meAtStart.chart_id === 'string' ? 'current' : 'welcome');
  const [stack, setStack] = useState<readonly Route[]>(() => (termsRenewed ? [home, 'consent'] : [home]));
  const [draft, setDraft] = useState<BirthDraft>(EMPTY_DRAFT);
  const [serverErrors, setServerErrors] = useState(NO_SERVER_ERRORS);
  // Said until the user agrees to the new texts; after that it is no longer news.
  const [termsNotice, setTermsNotice] = useState(termsRenewed);
  const [shownCharts, setShownCharts] = useState<ShownCharts>({ current: null, built: null });
  const chartScroll = useRef(0);
  // The chart the paywall and the report screen were opened from.
  const [openChart, setOpenChart] = useState<OpenChart | null>(null);
  const [paywall, setPaywall] = useState<PaywallEntry>({ plan: null, offersReport: false, reportRequired: false });
  const [reportEntry, setReportEntry] = useState<ReportEntry>({ reportId: null, orderAtOnce: false, justPaid: false });
  const route = stack[stack.length - 1] ?? home;
  const canGoBack = stack.length > 1;

  // What is on screen, for the handlers that must keep their identity across screens.
  const shown = useRef({ route, canGoBack });
  useEffect(() => {
    shown.current = { route, canGoBack };
  });

  // One event per screen opened. The ref keeps a development build, which runs effects twice, from counting it twice.
  const viewed = useRef<Route | null>(null);
  useEffect(() => {
    if (viewed.current === route) return;
    viewed.current = route;
    track('screen_view', { step: STEP_OF[route] });
    if (route === 'consent') track('consent_view');
    if (route === 'paywall') track('paywall_view');
  }, [route, track]);

  const open = (next: Route) => {
    setStack((current) => [...current, next]);
  };
  /** Puts `next` in place of the screen on top: the back button then leads past the replaced one. */
  const replace = (next: Route) => {
    setStack((current) => [...current.slice(0, -1), next]);
  };
  const goBack = useCallback(() => {
    // Reported here, not in the updater below: React may run an updater more than once.
    if (shown.current.canGoBack) track('step_back', { step: STEP_OF[shown.current.route] });
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, [track]);
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
  const handleRejected = useCallback(
    (errors: readonly FieldError[]) => {
      // Before any other field: with outdated texts there is nothing to correct on the screens of this build.
      if (errors.some(({ field }) => field === CONSENT_VERSION_FIELD)) {
        onConsentRefused();
        return;
      }
      const rejection = routeRejection(errors);
      // Fields no screen collects: the chart screen stays and shows the error itself.
      if (rejection === null) return;
      setServerErrors(rejection.messages);
      setStack([home, ...rejection.routes]);
    },
    [onConsentRefused, home],
  );
  /** `Me` promised a chart and the server has none: from here on the user is a new one. */
  const handleMissing = useCallback(() => {
    setHome('welcome');
    setStack(['welcome']);
  }, []);
  const openSettings = () => {
    open('settings');
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

  // A chart that came from the server is kept, so the way back to the chart screen costs no request.
  const rememberCurrent = useCallback((result: ChartResult) => {
    chartScroll.current = 0;
    setShownCharts((shown) => ({ ...shown, current: result }));
  }, []);
  const rememberBuilt = useCallback(
    (result: ChartResult) => {
      chartScroll.current = 0;
      // The user's chart on the server may be this one now: the one kept from before is no longer vouched for.
      if (request !== null) setShownCharts({ current: null, built: { request, result } });
    },
    [request],
  );

  if (route === 'current' || (route === 'chart' && request !== null)) {
    const cached = route === 'current' ? shownCharts.current : shownCharts.built?.request === request ? shownCharts.built.result : null;
    return (
      <ChartScreen
        // A screen of its own per chart: the one from the server and the one from the form share nothing.
        key={route}
        api={api}
        telegram={telegram}
        request={route === 'current' ? null : request}
        apiBaseUrl={apiBaseUrl}
        botUsername={botUsername}
        track={track}
        back={back}
        onEdit={() => {
          track('step_back', { step: STEP_OF.chart });
          // The form starts over: from the date while the consent given in this session stands, from the consent otherwise.
          setStack(draft.consentVersion === null ? [home, 'consent'] : [home, 'consent', 'birthDate']);
        }}
        onRejected={handleRejected}
        onMissing={handleMissing}
        cached={cached}
        onLoaded={route === 'current' ? rememberCurrent : rememberBuilt}
        scroll={chartScroll}
        onOpenSettings={openSettings}
        report={{
          fullReport: me.entitlements.full_report,
          reportId,
          known: knownReport,
          onKnown: setKnownReport,
          paymentPending: awaitedPlan === REPORT_PLAN,
          onCheckPayment: refreshMe,
          onBuy: (chart) => {
            setOpenChart(chart);
            setPaywall({ plan: REPORT_PLAN, offersReport: true, reportRequired: false });
            open('paywall');
          },
          onOrder: (chart) => {
            setOpenChart(chart);
            setReportEntry({ reportId: null, orderAtOnce: true, justPaid: false });
            open('report');
          },
          onOpen: (chart, known) => {
            setOpenChart(chart);
            setReportEntry({ reportId: known, orderAtOnce: false, justPaid: false });
            open('report');
          },
        }}
      />
    );
  }

  // The chart a report can be about: the one the user came from, else the one `Me` names.
  const reportChart = openChart ?? (typeof me.chart_id === 'string' ? { chartId: me.chart_id, share: null } : null);

  switch (route) {
    case 'welcome':
      return (
        <WelcomeScreen
          onStart={() => {
            open('consent');
          }}
          onOpenTerms={() => {
            open('terms');
          }}
          onOpenSettings={openSettings}
        />
      );
    case 'paywall':
      return (
        <PaywallScreen
          api={api}
          telegram={telegram}
          me={me}
          refreshMe={refreshMe}
          reportChartId={paywall.offersReport ? (reportChart?.chartId ?? null) : null}
          initialPlan={paywall.plan}
          reportRequired={paywall.reportRequired}
          awaiting={awaitedPlan}
          onAwaiting={awaitPayment}
          track={track}
          back={back}
          onOpenTerms={() => {
            open('terms');
          }}
          onReportPaid={() => {
            // Paid for, by the server's word. The user asked for the report with the purchase: it is ordered at once.
            setReportEntry({ reportId: null, orderAtOnce: true, justPaid: true });
            replace('report');
          }}
          onOpenReport={
            reportChart === null
              ? undefined
              : () => {
                  setReportEntry({ reportId, orderAtOnce: false, justPaid: false });
                  replace('report');
                }
          }
          onClose={goBack}
        />
      );
    case 'report':
      // Not reachable without a chart; if it ever is, the screen under this one is the place to be.
      if (reportChart === null) return <BootScreen />;
      return (
        <ReportScreen
          api={api}
          telegram={telegram}
          keys={keys}
          chartId={reportChart.chartId}
          reportId={reportEntry.reportId}
          orderAtOnce={reportEntry.orderAtOnce}
          justPaid={reportEntry.justPaid}
          apiBaseUrl={apiBaseUrl}
          supportLink={supportLink}
          share={reportChart.share}
          track={track}
          back={back}
          onPaymentRequired={(explain) => {
            setPaywall({ plan: REPORT_PLAN, offersReport: true, reportRequired: explain });
            replace('paywall');
          }}
          onReportId={setReportId}
          onReport={setKnownReport}
        />
      );
    case 'settings':
      return (
        <SettingsScreen
          api={api}
          telegram={telegram}
          refreshMe={refreshMe}
          supportLink={supportLink}
          track={track}
          back={back}
          onOpenDocument={open}
          onSubscribe={() => {
            setPaywall({ plan: null, offersReport: false, reportRequired: false });
            open('paywall');
          }}
          onDeleted={onDeleted}
        />
      );
    case 'consent':
      return (
        <ConsentScreen
          accepted={draft.consentVersion !== null}
          serverError={serverErrors.get('consent')}
          renewed={termsNotice}
          back={back}
          onChange={(accepted) => {
            // The version recorded is the one of the text on screen at the moment of the tap.
            update({ consentVersion: accepted ? CONSENT_VERSION : null }, 'consent');
          }}
          onOpenDocument={open}
          onNext={() => {
            track('consent_accepted', { version: CONSENT_VERSION });
            setTermsNotice(false);
            open('birthDate');
          }}
          onDecline={() => {
            // «Not now» takes the tick back and leaves nothing behind: the next visit starts from a clean form.
            track('step_back', { step: STEP_OF.consent });
            setDraft(EMPTY_DRAFT);
            setServerErrors(NO_SERVER_ERRORS);
            setStack([home]);
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
          track={track}
          back={back}
          onChange={(date) => {
            update({ date }, 'birth_date');
          }}
          onNext={() => {
            track('birth_date_done');
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
          track={track}
          back={back}
          onModeChange={(timePrecision) => {
            // The option decides whether a time is sent at all, so it answers for both fields.
            update({ timePrecision }, 'time_precision', 'birth_time');
          }}
          onTimeChange={(time) => {
            update({ time }, 'birth_time');
          }}
          onNext={() => {
            track('birth_time_done');
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
          track={track}
          query={draft.placeQuery}
          place={draft.place}
          serverError={serverErrors.get('birth_place')}
          back={back}
          onChange={(placeQuery, place) => {
            update({ placeQuery, place }, 'birth_place');
          }}
          onNext={() => {
            track('birth_place_done');
            // A new request gets a new verdict on every field.
            setServerErrors(NO_SERVER_ERRORS);
            open('chart');
          }}
        />
      );
  }
}
