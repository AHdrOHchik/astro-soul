import { Button, InfoIcon, Screen, StateView } from '@astro-soul/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AnalyticsStep, Track } from './analytics';
import type { Api, ChartCreateRequest, ChartResult, FieldError, Forecast, ForecastDay, Me, OrderablePlanCode, PlanKind, Question, Report } from './api';
import { ErrorState } from './components/ErrorState';
import { useRequest } from './hooks/useRequest';
import { CONSENT_VERSION, ru } from './i18n/ru';
import { EMPTY_DRAFT, toChartRequest, type BirthDraft, type BirthStep } from './lib/birth';
import type { IdempotencyKeys } from './lib/idempotency';
import { grants, hasReportFor } from './lib/plans';
import type { TermsReload } from './lib/termsReload';
import { BottomTabs, type MainTab } from './components/BottomTabs';
import { DailyForecastScreen } from './screens/DailyForecastScreen';
import { QuestionsScreen } from './screens/QuestionsScreen';
import type { CompatibilityHistoryCache } from './screens/compatibility/CompatibilityHistory';
import type { HistoryPageCache } from './lib/history-pagination';
import { BirthDateScreen } from './screens/BirthDateScreen';
import { BirthPlaceScreen } from './screens/BirthPlaceScreen';
import { BirthTimeScreen } from './screens/BirthTimeScreen';
import { BootScreen } from './screens/BootScreen';
import { ChartScreen, type OpenChart } from './screens/chart/ChartScreen';
import { ConsentScreen, type LegalDocument } from './screens/ConsentScreen';
import { CompatibilityScreen } from './screens/compatibility/CompatibilityScreen';
import { DocumentScreen } from './screens/DocumentScreen';
import { ForecastScreen } from './screens/forecast/ForecastScreen';
import type { KnownForecast } from './screens/forecast/useForecast';
import { AccessCodeScreen } from './screens/access-code/AccessCodeScreen';
import { AccessCodeBanner } from './components/AccessCodeBanner';
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
  /** Where the support button leads; '' = no contact yet, the button says so. */
  supportLink?: string;
  /**
   * Whether this build sells subscriptions (`VITE_SUBSCRIPTIONS`); it does not unless told to.
   * Without `true` nothing in the app offers one: not the paywall, not the settings, not the
   * forecast or the question screen. A subscription the user already has is shown as ever.
   */
  subscriptions?: boolean;
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
export function App({
  api,
  telegram,
  apiBaseUrl,
  supportLink = '',
  subscriptions = false,
  keys,
  track,
  termsReload,
  today,
}: AppProps) {
  const loadMe = useCallback((signal: AbortSignal) => api.getMe(signal), [api]);
  const me = useRequest(loadMe);
  const [terms, setTerms] = useState(() => termsAtStart(termsReload.refusedVersion));
  // The server has deleted everything about the user: nothing the app holds is true any more.
  const [deleted, setDeleted] = useState(false);
  // Non-access fact captured when the user opens deletion, kept only for the final screen's wording.
  const [deletedHadSubscription, setDeletedHadSubscription] = useState(false);
  const handleDeleted = useCallback((hadSubscription: boolean) => {
    // The one thing the app keeps on the device between reloads: the keys of the orders, under the id of the chart.
    keys.forgetAll();
    setDeletedHadSubscription(hadSubscription);
    setDeleted(true);
  }, [keys]);

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

  if (deleted) return <DeletedScreen telegram={telegram} hadSubscription={deletedHadSubscription} />;
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
    <>
      <Screens
        api={api}
        telegram={telegram}
        apiBaseUrl={apiBaseUrl}
        supportLink={supportLink}
        subscriptions={subscriptions}
        keys={keys}
        track={track}
        today={today}
        me={me.data}
        termsRenewed={terms === 'renewed'}
        onConsentRefused={handleConsentRefused}
        onDeleted={handleDeleted}
      />
      {/*
        A start from a `pt_<code>` link: the server activated the code before this page was drawn.
        The banner says what opened, once per start; it is never a question about the code again.
      */}
      <AccessCodeBanner startedWithCode={telegram.startedWithCode} entitlements={me.data.entitlements} />
    </>
  );
}

/**
 * `current` is the chart the user already has, opened from the server; `chart` is the one
 * built from the form. `paywall`, `report`, `forecast`, `ask` and `settings` open over either.
 */
type Route =
  | 'welcome'
  | 'consent'
  | LegalDocument
  | BirthStep
  | 'chart'
  | 'current'
  | 'paywall'
  | 'report'
  | 'forecast'
  | 'today'
  | 'ask'
  | 'settings'
  | 'compatibility'
  | 'accessCode';
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
  forecast: 'forecast',
  today: 'forecast',
  ask: 'ask',
  settings: 'settings',
  compatibility: 'compatibility',
  accessCode: 'access_code',
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

interface ScreensProps extends Omit<AppProps, 'termsReload' | 'supportLink' | 'subscriptions'> {
  supportLink: string;
  subscriptions: boolean;
  /** Who the user is, as the server said when the app started. */
  me: Me;
  /** This start follows a restart for newer legal texts: it opens on the consent screen, which says so. */
  termsRenewed: boolean;
  /** The server refused the consent version. Keep the reference stable. */
  onConsentRefused: () => void;
  /** The server has deleted everything; the boolean is for post-deletion wording only. */
  onDeleted: (hadSubscription: boolean) => void;
}

/** What the paywall was opened for. */
interface PaywallEntry {
  /** Prefer the first available offer of this kind, e.g. a one-off from the report teaser. */
  preferredKind: PlanKind | null;
  /** The full report is on offer: the paywall was opened for it. */
  offersReport: boolean;
  /** The server refused to order a report and that is why the paywall is open. */
  reportRequired: boolean;
  compatibility: boolean;
}

/** A purchase Telegram called paid and the server has not granted yet. */
interface AwaitedPurchase {
  plan: OrderablePlanCode;
  kind: PlanKind;
  report: boolean;
  /** The chart a report purchase was made for; null for products unrelated to a chart report. */
  chartId: string | null;
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
  supportLink,
  subscriptions,
  keys,
  track,
  today: pinnedToday,
  me: meAtStart,
  termsRenewed,
  onConsentRefused,
  onDeleted,
}: ScreensProps) {
  const [today] = useState(() => pinnedToday ?? new Date());
  // The moment as it is when asked: a forecast is «today's» by the hour the user looks at it, not by the hour the app started.
  const clock = useCallback(() => pinnedToday ?? new Date(), [pinnedToday]);
  // What the server last said about the user. Access is read from here and from nowhere else.
  const [me, setMe] = useState(meAtStart);
  // The report the app knows of: the one `Me` names, then whichever the report screen meets.
  const [reportId, setReportId] = useState<string | null>(meAtStart.latest_report_id ?? null);
  // And the server's last word about it, so the chart screen can show it at once and ask again behind it.
  const [knownReport, setKnownReport] = useState<Report | null>(null);
  // The reports the server has said it does not have. An id never comes back: should `Me` go on naming one,
  // the app does not take it up again, or it would ask about it, hear 404 and ask `Me` once more, without end.
  const goneReports = useRef(new Set<string>());
  // The server no longer has that report (404 to the id `Me` named: it went with the user's data).
  // Nothing the app holds about it is true any more; `null` is the ordinary «no report».
  const forgetReport = useCallback((gone: string) => {
    goneReports.current.add(gone);
    setReportId((current) => (current === gone ? null : current));
    setKnownReport((current) => (current?.report_id === gone ? null : current));
  }, []);
  // What the server last said about the forecast of a chart: the card and the screen show it at once and ask again behind it.
  const [knownForecast, setKnownForecast] = useState<KnownForecast | null>(null);
  const rememberForecast = useCallback((chartId: string, forecast: Forecast | null) => {
    // «None yet» is news as well: what was known before is not shown in its place.
    setKnownForecast(forecast === null ? null : { chartId, forecast });
  }, []);
  // A purchase Telegram called paid in this visit and the server has not granted yet. Until it does,
  // no screen offers to pay for it again. The ref is for the moment the answer comes, the state for the screens.
  const [awaitedPurchase, setAwaitedPurchase] = useState<AwaitedPurchase | null>(null);
  const awaited = useRef<AwaitedPurchase | null>(null);
  const awaitPayment = useCallback((purchase: AwaitedPurchase) => {
    awaited.current = purchase;
    setAwaitedPurchase(purchase);
  }, []);
  const refreshMe = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await api.getMe(signal);
      setMe(fresh);
      if (typeof fresh.latest_report_id === 'string' && !goneReports.current.has(fresh.latest_report_id)) setReportId(fresh.latest_report_id);
      const purchase = awaited.current;
      if (purchase?.plan === 'compat_249') {
        // A compatibility credit is confirmed only by its own quota endpoint, never by an active subscription in `Me`.
        try {
          const compatibility = await api.getCompatibilities(20, 0, signal);
          if (signal?.aborted !== true && awaited.current === purchase && compatibility.quota.kind === 'purchase' && compatibility.quota.left > 0) {
            awaited.current = null;
            setAwaitedPurchase(null);
            track('payment_succeeded', { plan_code: purchase.plan });
          }
        } catch {
          // The payment is still awaited: an unread quota grants nothing.
        }
      } else if (purchase !== null && grants(fresh, purchase.report, purchase.chartId)) {
        // A report is confirmed for the chart it was bought for; a subscription is confirmed by Me. Telegram's word is not enough.
        awaited.current = null;
        setAwaitedPurchase(null);
        track('payment_succeeded', { plan_code: purchase.plan });
      }
      return fresh;
    },
    [api, track],
  );
  // Either field says it. Whether the chart is really there is the answer of `GET /charts/current`.
  const [home, setHome] = useState<Home>(meAtStart.has_chart || typeof meAtStart.chart_id === 'string' ? 'current' : 'welcome');
  const [knownDailyForecast, setKnownDailyForecast] = useState<{ context: string; day: ForecastDay } | null>(null);
  const [questionHistoryCache, setQuestionHistoryCache] = useState<(HistoryPageCache<Question> & { quota: Question['quota'] | null }) | null>(null);
  const [compatibilityHistoryCache, setCompatibilityHistoryCache] = useState<CompatibilityHistoryCache | null>(null);
  const dailyScroll = useRef(0);
  const questionScroll = useRef(0);
  const [stack, setStack] = useState<readonly Route[]>(() => (termsRenewed ? [home, 'consent'] : [home]));
  const [draft, setDraft] = useState<BirthDraft>(EMPTY_DRAFT);
  const [serverErrors, setServerErrors] = useState(NO_SERVER_ERRORS);
  // Said until the user agrees to the new texts; after that it is no longer news.
  const [termsNotice, setTermsNotice] = useState(termsRenewed);
  const [shownCharts, setShownCharts] = useState<ShownCharts>({ current: null, built: null });
  // Counts the times the app has dropped a chart: the chart screen of before is not the chart screen of after.
  const tabChartId = me.chart_id ?? shownCharts.current?.chart.chart_id ?? shownCharts.built?.result.chart.chart_id ?? null;
  const historyChartId = useRef(tabChartId);
  useEffect(() => {
    if (historyChartId.current === tabChartId) return;
    historyChartId.current = tabChartId;
    setQuestionHistoryCache(null);
    setCompatibilityHistoryCache(null);
  }, [tabChartId]);
  const dailyContext = `${tabChartId ?? ''}:${String(me.entitlements.is_active)}`;
  const rememberDailyForecast = useCallback((day: ForecastDay | null) => {
    setKnownDailyForecast(day === null ? null : { context: dailyContext, day });
  }, [dailyContext]);
  const [chartEpoch, setChartEpoch] = useState(0);
  const chartScroll = useRef(0);
  // The chart the paywall and the report screen were opened from.
  const [openChart, setOpenChart] = useState<OpenChart | null>(null);
  // The zone of that chart's birth place, when the forecast was opened from it: there the server counts the days.
  const [paywall, setPaywall] = useState<PaywallEntry>({ preferredKind: null, offersReport: false, reportRequired: false, compatibility: false });
  const [compatibilityId, setCompatibilityId] = useState<string | null>(null);
  const [compatibilityChartId, setCompatibilityChartId] = useState<string | null>(null);
  const [reportEntry, setReportEntry] = useState<ReportEntry>({ reportId: null, orderAtOnce: false, justPaid: false });
  const route = stack[stack.length - 1] ?? home;
  const mainTab: MainTab = route === 'settings' ? 'cabinet' : route === 'today' || route === 'ask' ? route : 'map';
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
  /**
   * The chart the app was showing is not on the server any more: the user's data was deleted
   * elsewhere while this page stayed open. Everything remembered about that chart is dropped,
   * and the app starts where it starts at launch: by asking the server which chart the user
   * has. With none, the answer leads on to the welcome screen (`handleMissing`), and whatever
   * the server said about the missing chart is never shown.
   */
  const forgetChart = useCallback(() => {
    chartScroll.current = 0;
    dailyScroll.current = 0;
    questionScroll.current = 0;
    setKnownDailyForecast(null);
    keys.forgetAll();
    setShownCharts({ current: null, built: null });
    setOpenChart(null);
    setReportId(null);
    setKnownReport(null);
    setKnownForecast(null);
    setCompatibilityChartId(null);
    setCompatibilityId(null);
    // The form starts clean as well: the consent went with the data it was given for.
    setDraft(EMPTY_DRAFT);
    setServerErrors(NO_SERVER_ERRORS);
    // A payment still on its way that was made for a chart went with the chart: nothing will come of it now, and
    // the chart built next is offered its own price. A subscription is about no chart: it is awaited as before.
    if (awaited.current !== null && awaited.current.chartId !== null) {
      awaited.current = null;
      setAwaitedPurchase(null);
    }
    // The chart screen may be the one on screen (it asks about the report too): it starts over like any other.
    setChartEpoch((epoch) => epoch + 1);
    setHome('current');
    setStack((routes) => routes.length === 1 && (routes[0] === 'today' || routes[0] === 'ask' || routes[0] === 'settings') ? routes : ['current']);
  }, [keys]);
  /** The server answered that the chart is not there: to an order, a question, an invoice. */
  const handleChartGone = useCallback(() => {
    forgetChart();
    // What else went with the chart (a purchase, the day's questions) is the server's to say: the screens read it from `Me`.
    void refreshMe().catch(() => undefined);
  }, [forgetChart, refreshMe]);
  /**
   * `Me` asked anew from a screen that works with the chart on screen. An answer without
   * any chart says that one is gone, whatever the request that prompted the question said:
   * the server's 404 to a forecast means «not prepared yet» and «no such chart» alike.
   */
  const refreshMeForChart = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await refreshMe(signal);
      // Either field would say there is a chart, as at the start: gone is when neither does.
      if (signal?.aborted !== true && !fresh.has_chart && typeof fresh.chart_id !== 'string') forgetChart();
      return fresh;
    },
    [refreshMe, forgetChart],
  );
  /**
   * Is the chart still on the server? Asked of `Me` when the server has no such report (404):
   * a report goes with the user's data and in no other way. Without a chart the app has
   * started over by the time this says so.
   */
  const isChartThere = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await refreshMeForChart(signal);
      return fresh.has_chart || typeof fresh.chart_id === 'string';
    },
    [refreshMeForChart],
  );
  /** The report `Me` named is not on the server (404 on the chart screen): forgotten, and `Me` is asked whether the chart went with it. */
  const handleReportGone = useCallback(
    (gone: string) => {
      forgetReport(gone);
      void refreshMeForChart().catch(() => undefined);
    },
    [forgetReport, refreshMeForChart],
  );
  const openSettings = () => {
    open('settings');
  };
  const selectMainTab = (tab: MainTab) => {
    const mapHome = shownCharts.built !== null ? 'current' : home;
    setStack([tab === 'cabinet' ? 'settings' : tab === 'map' ? mapHome : tab]);
  };
  const withTabs = (screen: ReactNode) => <div className="tabbed">{screen}<BottomTabs active={mainTab} onSelect={selectMainTab}/></div>;
  // A subscription is offered where this build sells them and the user has none.
  const canSubscribe = subscriptions && !me.entitlements.is_active;
  const openSubscriptions = () => {
    setPaywall({ preferredKind: null, offersReport: false, reportRequired: false, compatibility: false });
    open('paywall');
  };
  /** The code screen has no menu item for a subscriber: the route itself stays open (a gift may be for a second period). */
  const openAccessCode = () => {
    open('accessCode');
  };
  const openCompatibility = (chartId: string | null) => {
    setCompatibilityChartId(chartId);
    setCompatibilityId(null);
    open('compatibility');
  };
  const openSavedCompatibility = (id: string) => {
    setCompatibilityChartId(null);
    setCompatibilityId(id);
    open('compatibility');
  };
  const backToCompatibilityList = () => {
    setCompatibilityChartId(null);
    setCompatibilityId(null);
    open('settings');
  };
  const buyCompatibility = (chartId: string) => {
    setCompatibilityChartId(chartId);
    setPaywall({ preferredKind: 'one_off', offersReport: false, reportRequired: false, compatibility: true });
    open('paywall');
  };
  const compatibilityPaid = () => {
    awaited.current = null;
    setAwaitedPurchase(null);
    setCompatibilityId(null);
    replace('compatibility');
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
      <div className={route === 'current' ? 'tabbed' : undefined}>
      <ChartScreen
        // A screen of its own per chart: the one from the server and the one from the form share nothing,
        // and neither does the screen of a chart the server turned out not to have.
        key={`${route}:${String(chartEpoch)}`}
        api={api}
        telegram={telegram}
        share={me.share}
        request={route === 'current' ? null : request}
        apiBaseUrl={apiBaseUrl}
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
        subscriptionPromotion={route === 'current' && canSubscribe ? { onOpen: openSubscriptions } : undefined}
        report={{
          // Paid for or not is asked about the chart on screen, never about the user: `cached` is that chart
          // from the moment the server hands it over (`onLoaded` comes before the screen draws it).
          fullReport: cached !== null && hasReportFor(me, cached.chart.chart_id),
          reportId,
          known: knownReport,
          onKnown: setKnownReport,
          onGone: handleReportGone,
          // Whichever chart that payment was for: while one is on its way, no price is offered anywhere.
          paymentPending: awaitedPurchase?.report === true && awaitedPurchase.chartId === cached?.chart.chart_id,
          // The payment was for a chart: `Me` without any says that the chart is gone, and the purchase with it.
          onCheckPayment: refreshMeForChart,
          onBuy: (chart) => {
            setOpenChart(chart);
            setPaywall({ preferredKind: 'one_off', offersReport: true, reportRequired: false, compatibility: false });
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
      {route === 'current' && <BottomTabs active={mainTab} onSelect={selectMainTab}/>}
      </div>
    );
  }

  // The chart a report can be about: the one the user came from, else the one `Me` names.
  const reportChart = openChart ?? (typeof me.chart_id === 'string' ? { chartId: me.chart_id } : null);
  // The chart the paywall sells the report for; null when the report is not on offer there.
  const paywallChartId = reportChart?.chartId ?? null;
  const offersReport = paywall.offersReport && paywallChartId !== null;
  // The chart of the payment the app is waiting for; null when there is none, or it is for a subscription.
  const awaitedChartId = awaitedPurchase?.chartId ?? null;

  switch (route) {
    case 'welcome':
      return withTabs(
        <WelcomeScreen
          api={api}
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
          // A report is paid for a chart. Where the screen sells one, or waits for a payment made for a chart, `Me`
          // without any chart says that the chart is gone, and the purchase with it: the app starts over instead of waiting.
          refreshMe={offersReport || awaitedChartId !== null ? refreshMeForChart : refreshMe}
          reportChartId={paywallChartId}
          initialKind={paywall.preferredKind}
          subscriptions={subscriptions}
          offersReport={offersReport}
          reportRequired={paywall.reportRequired && offersReport}
          compatibilityPurchase={paywall.compatibility}
          refreshCompatibility={(signal) => api.getCompatibilities(20, 0, signal)}
          onCompatibilityPaid={compatibilityPaid}
          awaiting={awaitedPurchase === null ? null : { planCode: awaitedPurchase.plan, kind: awaitedPurchase.kind, report: awaitedPurchase.report }}
          awaitingChartId={awaitedChartId}
          onAwaiting={(offer, report) => {
            awaitPayment({
              plan: offer.plan_code,
              kind: offer.kind,
              report,
              chartId: report ? paywallChartId : null,
            });
          }}
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
          onBuildChart={() => {
            forgetChart();
            setHome('welcome');
            setStack(['welcome']);
          }}
          onChartGone={handleChartGone}
          onHaveCode={openAccessCode}
        />
      );
    case 'accessCode':
      return (
        <AccessCodeScreen
          api={api}
          entitlements={me.entitlements}
          // The rights are the app's own state: the confirmation is drawn from the answer to the request,
          // and `Me` is asked again behind it so every other screen sees what the code opened.
          refreshMe={refreshMe}
          track={track}
          back={back}
          onClose={goBack}
        />
      );
    case 'forecast':
      // Not reachable without a chart; if it ever is, the screen under this one is the place to be.
      if (reportChart === null) return <BootScreen />;
      return (
        <ForecastScreen
          api={api}
          telegram={telegram}
          share={me.share}
          chartId={reportChart.chartId}
          timeZone={null}
          known={knownForecast}
          onKnown={rememberForecast}
          now={clock}
          track={track}
          back={back}
          onAsk={() => {
            open('ask');
          }}
          onSubscribe={canSubscribe ? openSubscriptions : undefined}
          onClose={goBack}
          onNotReady={() => {
            void refreshMeForChart().catch(() => undefined);
          }}
        />
      );
    case 'today':
    case 'ask': {
      const chartId = tabChartId;
      if (route === 'today') return withTabs(
        <DailyForecastScreen key={dailyContext} api={api} chartId={chartId} share={me.share} telegram={telegram}
          known={knownDailyForecast?.context === dailyContext ? knownDailyForecast.day : null}
          now={clock} onKnown={rememberDailyForecast} onBuildChart={handleMissing} onChartGone={handleChartGone}
          onSubscribe={canSubscribe ? openSubscriptions : undefined} scroll={dailyScroll} track={track} />
      );
      return withTabs(<QuestionsScreen api={api} telegram={telegram} subscribed={me.entitlements.is_active && chartId !== null} chartAvailable={chartId !== null} onSubscribe={canSubscribe ? openSubscriptions : undefined} onBuildChart={handleMissing} onChartGone={handleChartGone} scroll={questionScroll} cache={questionHistoryCache} onCacheChange={setQuestionHistoryCache}/>);
    }
    case 'report':
      // Not reachable without a chart; if it ever is, the screen under this one is the place to be.
      if (reportChart === null) return <BootScreen />;
      return (
        <ReportScreen
          api={api}
          telegram={telegram}
          share={me.share}
          keys={keys}
          chartId={reportChart.chartId}
          reportId={reportEntry.reportId}
          orderAtOnce={reportEntry.orderAtOnce}
          justPaid={reportEntry.justPaid}
          apiBaseUrl={apiBaseUrl}
          supportLink={supportLink}
          track={track}
          back={back}
          onPaymentRequired={(explain) => {
            setPaywall({ preferredKind: 'one_off', offersReport: true, reportRequired: explain, compatibility: false });
            replace('paywall');
          }}
          onReportId={setReportId}
          onReport={setKnownReport}
          onReportGone={forgetReport}
          onChartGone={handleChartGone}
          isChartThere={isChartThere}
          onOpenCompatibility={(chartId) => { openCompatibility(chartId); }}
          onBuyCompatibility={buyCompatibility}
        />
      );
    case 'compatibility':
      return (
        <CompatibilityScreen
          api={api}
          chartId={compatibilityChartId ?? reportChart?.chartId ?? me.chart_id}
          compatibilityId={compatibilityId}
          onCompatibilityId={setCompatibilityId}
          keys={keys}
          limits={me.limits}
          refreshMe={refreshMe}
          telegram={telegram}
          supportLink={supportLink}
          track={track}
          back={back}
          onBackToList={backToCompatibilityList}
          onBuy={buyCompatibility}
        />
      );
    case 'settings':
      return (
        <div className="tabbed">
        <SettingsScreen
          api={api}
          telegram={telegram}
          // Opened from a chart, the settings ask `Me` like every screen that works with one: an answer without
          // a chart says the data was deleted elsewhere. A user who has built none yet has nothing to lose that way.
          refreshMe={home === 'current' || shownCharts.built !== null ? refreshMeForChart : refreshMe}
          supportLink={supportLink}
          track={track}
          back={back}
          onOpenDocument={open}
          onSubscribe={subscriptions ? openSubscriptions : undefined}
          // A paid subscription already opens everything: the row is not offered to its owner,
          // while the route itself stays reachable by a direct address (a gift may be for a second period).
          onOpenAccessCode={me.subscription.is_active ? undefined : openAccessCode}
          onOpenCompatibility={openCompatibility}
          onOpenSavedCompatibility={openSavedCompatibility}
          onBuyCompatibility={buyCompatibility}
          compatibilityCache={compatibilityHistoryCache}
          onCompatibilityCacheChange={setCompatibilityHistoryCache}
          onDeleted={(hadSubscription) => {
            setQuestionHistoryCache(null);
            setCompatibilityHistoryCache(null);
            onDeleted(hadSubscription);
          }}
        />
        <BottomTabs active={mainTab} onSelect={selectMainTab}/>
        </div>
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
          // The search bounds come from GET /me: this build keeps no copy of the numbers.
          limits={me.limits}
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
