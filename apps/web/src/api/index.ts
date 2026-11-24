import { ApiError, isApiError, isRecord } from './errors';
import { createHttpClient, type HttpClientOptions } from './http';
import type { components, paths } from './schema.gen';

export {
  ApiError,
  failureCodeOf,
  fieldErrorsOf,
  isAbortError,
  isApiError,
  rejectionTextOf,
  resetAtOf,
  serverTextOf,
  type ApiErrorCode,
  type FieldError,
} from './errors';

/*
 * Every type below is derived from api.openapi.yaml (see `pnpm gen:api`).
 * A field that is not in the contract does not exist for this app.
 */
export type Me = components['schemas']['Me'];
/** The subscription as `Me` carries it: the plan, until when, and whether Telegram renews it. */
export type Subscription = components['schemas']['SubscriptionState'];
export type SubscriptionCancelResult = components['schemas']['SubscriptionCancelResult'];
export type NotificationSettings = components['schemas']['Notifications'];
/** What the user may use right now. Drawn by the app, decided by the server alone. */
export type Entitlements = components['schemas']['Entitlements'];
export type Quota = components['schemas']['Quota'];
export type GeoPlace = components['schemas']['GeoPlace'];
export type Chart = components['schemas']['Chart'];
export type ChartCreateRequest = components['schemas']['ChartCreateRequest'];
/** How well the birth time is known: `exact`, `approximate` or `unknown`. */
export type TimePrecision = ChartCreateRequest['time_precision'];
type ChartEnvelope = components['schemas']['ChartResponse'];

/**
 * What the server may say about the quality of the birth data behind a chart: the codes this
 * build has words for. A list of its own, not the contract's enum: the server may add a code
 * at any time, and a build that does not know it leaves it out instead of breaking.
 */
export const CHART_WARNINGS = [
  'no_birth_time',
  'approximate_time',
  'approximate_place',
] as const satisfies readonly ChartEnvelope['warnings'][number][];
export type ChartWarning = (typeof CHART_WARNINGS)[number];

/**
 * The chart as every method hands it over (`POST /charts`, `GET /charts/current`): the chart,
 * its short reading, the warnings and the paths of the wheel pictures.
 */
export type ChartResult = Omit<ChartEnvelope, 'warnings' | 'wheel_png_url'> & {
  warnings: ChartWarning[];
  // Optional in the app's own type: an older server sends no PNG, and the screen then reads
  // "there is none". Contract 1.5.1 marks the field required, so it is narrowed here.
  wheel_png_url?: string;
};
export type MiniReading = ChartResult['mini_reading'];
/** A product event as `POST /events` takes it. */
export type ClientEvent = components['schemas']['ClientEvent'];
type EventsBatch = components['schemas']['EventsBatch'];
type GeoResolveRequest = paths['/api/v1/geo/resolve']['post']['requestBody']['content']['application/json'];
/** `{code}` — the only field the activation takes (contract 1.6.14), and the only one sent. */
type ActivateCodeRequest = paths['/api/v1/me/activate-code']['post']['requestBody']['content']['application/json'];

/** What can be bought, by the codes of the contract. Prices are not here: the invoice names them. */
export type PlanCode = components['schemas']['PlanCode'];
/** A code returned by the server's tariff catalogue; deliberately a string beyond the closed regular catalogue. */
export type OrderablePlanCode = components['schemas']['OrderablePlanCode'];
export type PlanOffer = components['schemas']['PlanOffer'];
export type PlanKind = PlanOffer['kind'];
export type InvoiceRequest = components['schemas']['InvoiceRequest'];
export type CompatibilityRequest = components['schemas']['CompatibilityRequest'];
export type Compatibility = components['schemas']['Compatibility'];
export type CompatibilitySection = components['schemas']['CompatibilitySection'];
export type CompatibilityList = components['schemas']['CompatibilityList'];
export type CompatibilityQuota = components['schemas']['CompatibilityQuota'];
/** A Stars invoice: the link Telegram opens, and the price the server put on it. */
export type Invoice = components['schemas']['Invoice'];

type ReportEnvelope = components['schemas']['Report'];
export type ReportRequest = components['schemas']['ReportRequest'];
export type ReportStatus = ReportEnvelope['status'];

type ForecastEnvelope = components['schemas']['Forecast'];
export type ForecastDay = components['schemas']['ForecastDay'];
export type Question = components['schemas']['Question'];
export type QuestionList = components['schemas']['QuestionList'];
export type QuestionAccepted = components['schemas']['QuestionAccepted'];
export type PdfStatus = components['schemas']['PdfStatus'];
export type ShareCardKind = components['schemas']['ShareCardKind'];
export type ShareCard = components['schemas']['ShareCard'];

/**
 * What a forecast may be about: the codes of the contract (`Forecast.focus`) this build has a
 * label for, each under the name the app calls it. A list of its own, like `CHART_WARNINGS`:
 * a code a newer server adds is left out, not shown raw.
 *
 * The contract's `health` is `wellbeing` from this line on. That focus is about energy and
 * routine, and the service gives no advice on health: the word stays here, on the wire side,
 * and does not travel into the texts.
 */
const FOCUS_BY_CODE = {
  career: 'career',
  love: 'love',
  money: 'money',
  health: 'wellbeing',
  self: 'self',
} as const satisfies Partial<Record<NonNullable<ForecastEnvelope['focus']>, string>>;
export type ForecastFocus = (typeof FOCUS_BY_CODE)[keyof typeof FOCUS_BY_CODE];

/**
 * The forecast of a day as the screens get it. Prepared by the server at night and only
 * read here: there is no request that makes one.
 */
export interface Forecast {
  /** `YYYY-MM-DD`: the day the forecast is for, by the calendar of the birth place. */
  date: string;
  /** As much of the text as the server gives out: all of it, or its short version. */
  text: string;
  /** What the day is about; null when the server named nothing, or something this build has no label for. */
  focus: ForecastFocus | null;
  /** The server's word that this is the full forecast. Decides nothing here but what stands under the text. */
  is_paid: boolean;
}

/** `POST /engagement/ask`: the chart and the question, 3 to 500 characters of it. */
export type AskRequest = components['schemas']['AskRequest'];

/** The answer to a question about the chart. A refusal to answer comes in this very shape and is shown the same way. */
export interface AskAnswer {
  answer: string;
  /** The positions of the chart the answer rests on; empty when the server named none. */
  based_on: string[];
}

/** The limit of the contract for a question, counted like the server counts it: in UTF-16 units, after trimming. */
export const QUESTION_MAX_LENGTH = 500;

/** Typed against the contract: a status added to or removed from `Report.status` breaks the build here. */
const REPORT_STATUSES: Record<ReportStatus, true> = {
  queued: true,
  generating: true,
  ready: true,
  failed: true,
  refunded: true,
};

/**
 * The chapters of a full report as the contract lists them. Only their number is used, for
 * «3 of 7 chapters are ready»: a chapter under any other key is shown like the rest.
 */
export const REPORT_SECTION_KEYS = [
  'core',
  'emotions',
  'talents',
  'relations',
  'money',
  'purpose',
  'summary',
] as const satisfies readonly NonNullable<NonNullable<ReportEnvelope['sections']>[number]['key']>[];

/** One chapter. The key is the server's string: a build that has not heard of it shows the chapter anyway. */
export interface ReportSection {
  /** Tells the chapters of one report apart: no two of them share it. */
  key: string;
  title: string;
  /** Markdown, to be rendered as text and nothing else. */
  body_md: string;
  order: number;
}

/**
 * A report as the screens get it. The envelope of the contract has every field but four
 * optional; here each has a value, and a missing one reads as «none».
 */
export interface Report {
  report_id: string;
  /** The chart the report is about; null when the server did not say. */
  chart_id: string | null;
  status: ReportStatus;
  /** 0…100, the server's number; null when it sent none. Never invented by the app. */
  progress: number | null;
  /** The server's word that the text is paid for. The only thing that opens the chapters. */
  is_paid: boolean;
  /** The opening of the first chapter, shown before the purchase; '' when there is none yet. */
  teaser: string;
  /** In the order to read them. Always empty unless `is_paid`. */
  sections: ReportSection[];
  /** A signed link that expires: kept in memory only. */
  pdf_url: string | null;
}

/** Root of every API path; relative URLs returned by the API (`wheel_url`) resolve against it. */
export const API_ROOT = '/api/v1/';

const PATHS = {
  me: '/api/v1/me',
  geoResolve: '/api/v1/geo/resolve',
  charts: '/api/v1/charts',
  currentChart: '/api/v1/charts/current',
  events: '/api/v1/events',
  invoice: '/api/v1/billing/invoice',
  plans: '/api/v1/billing/plans',
  reports: '/api/v1/reports',
  report: '/api/v1/reports/{report_id}',
  reportPdf: '/api/v1/reports/{report_id}/pdf',
  shareCard: '/api/v1/share/card',
  compatibility: '/api/v1/compatibility',
  compatibilityById: '/api/v1/compatibility/{compatibility_id}',
  forecast: '/api/v1/engagement/forecast',
  forecastToday: '/api/v1/forecast/today',
  ask: '/api/v1/engagement/ask',
  questions: '/api/v1/questions',
  question: '/api/v1/questions/{question_id}',
  subscriptionCancel: '/api/v1/subscription/cancel',
  notifications: '/api/v1/me/notifications',
  activateCode: '/api/v1/me/activate-code',
} as const satisfies Record<string, keyof paths>;

/** The header of idempotent order endpoints that makes a repeated order the same order. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface Api {
  getMe(signal?: AbortSignal): Promise<Me>;
  /**
   * Deletes everything the server keeps about the user. Sent once: whether to try again
   * after a failure is the user's decision, made with a tap.
   */
  deleteMe(signal?: AbortSignal): Promise<void>;
  /** Disables auto-renewal; never changes local access before `GET /me` confirms it. */
  cancelSubscription(idempotencyKey: string, signal?: AbortSignal): Promise<SubscriptionCancelResult>;
  /** Stores and returns the server's authoritative daily forecast notification setting. */
  updateNotifications(dailyForecast: boolean, signal?: AbortSignal): Promise<NotificationSettings>;
  /**
   * Activates an access code. The answer is the whole `Me.entitlements`, so nothing is
   * shown as «activated» before the server says what it actually opened. Sent once: a
   * repeat is the user's tap, never the client's retry.
   */
  activateCode(code: string, signal?: AbortSignal): Promise<Entitlements>;
  /**
   * Candidates for a birth place; an empty list when nothing matches. A failure of the
   * geodata provider is an error (503 `GEO_NOT_FOUND`), not an empty list.
   */
  resolveGeo(query: string, signal?: AbortSignal): Promise<GeoPlace[]>;
  /**
   * Idempotent on the server by input hash, so it is safe to retry. For data the user already
   * has a chart of, the answer is that chart, with `is_restored: true`.
   */
  createChart(input: ChartCreateRequest, signal?: AbortSignal): Promise<ChartResult>;
  /** The chart the user already has; null when there is none yet (the server's 404 is not a failure here). */
  getCurrentChart(signal?: AbortSignal): Promise<ChartResult | null>;
  /**
   * One batch of product events, 1 to 20 of them. Sent once and never repeated: the caller
   * has no use for the answer, and a batch that arrived twice would be counted twice.
   * `keepalive` lets the browser deliver it while the page is being closed.
   */
  sendEvents(events: ClientEvent[], options?: { keepalive?: boolean }): Promise<void>;
  /** The server-owned tariff catalogue. Read afresh each time the paywall opens; never persisted by the client. */
  getPlans(signal?: AbortSignal): Promise<PlanOffer[]>;
  /**
   * Asks the server for a Stars invoice. Sent once: the server counts invoices
   * (3 an hour), so a repeat is made by the user's tap, never by the client.
   */
  createInvoice(input: InvoiceRequest, signal?: AbortSignal): Promise<Invoice>;
  /**
   * Orders a report. `idempotencyKey` makes a repeated order the same order: the server
   * answers a known key with the report it already has.
   */
  orderReport(input: ReportRequest, idempotencyKey: string, signal?: AbortSignal): Promise<Report>;
  /** Where the report stands, and as much of it as the server gives out. */
  getReport(reportId: string, signal?: AbortSignal): Promise<Report>;
  createReportPdf(reportId: string, idempotencyKey: string, signal?: AbortSignal): Promise<PdfStatus>;
  getReportPdf(reportId: string, signal?: AbortSignal): Promise<PdfStatus>;
  createShareCard(kind: ShareCardKind, tz: string, signal?: AbortSignal): Promise<ShareCard>;
  /** Current compatibility history and server-owned remaining quota; never cached between visits. */
  getCompatibilities(limit?: number, offset?: number, signal?: AbortSignal): Promise<CompatibilityList>;
  /** Requests one compatibility analysis. The idempotency key makes retries the same request. */
  orderCompatibility(input: CompatibilityRequest, idempotencyKey: string, signal?: AbortSignal): Promise<components['schemas']['CompatibilityAccepted']>;
  /** The current status and, when ready, sections for one compatibility. */
  getCompatibility(id: string, signal?: AbortSignal): Promise<Compatibility>;
  /**
   * The forecast the server has prepared for the chart; null while there is none for today
   * (the contract's 404: a nightly job writes them, a request never does). A read of a cache:
   * there is nothing to wait for, so nobody asks twice in a row.
   */
  getForecast(chartId: string, signal?: AbortSignal): Promise<Forecast | null>;
  getForecastToday(signal?: AbortSignal): Promise<ForecastDay>;
  listQuestions(limit?: number, offset?: number, signal?: AbortSignal): Promise<QuestionList>;
  createQuestion(question: string, idempotencyKey: string, signal?: AbortSignal): Promise<QuestionAccepted>;
  getQuestion(id: string, signal?: AbortSignal): Promise<Question>;
  /**
   * Asks a question about the chart. Sent once: every question that reaches the server may
   * cost one of the day's few, so a repeat is made by the user's tap, never by the client.
   */
  ask(input: AskRequest, signal?: AbortSignal): Promise<AskAnswer>;
}

function invalid(): ApiError {
  return new ApiError('INVALID_RESPONSE');
}

function isGeoPlace(value: unknown): value is GeoPlace {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.country === 'string' &&
    typeof value.tz === 'string' &&
    typeof value.lat === 'number' &&
    typeof value.lon === 'number'
  );
}

/**
 * Brings the keys the screens read without checking to the shapes the contract
 * gives them. `asc`, `mc` and `houses` are null when the birth time is unknown;
 * a missing or malformed value is treated the same way: not calculated.
 */
function withContractShapes(chart: Record<string, unknown>): Record<string, unknown> {
  return {
    ...chart,
    birth: isRecord(chart.birth) ? chart.birth : {},
    asc: isRecord(chart.asc) ? chart.asc : null,
    mc: isRecord(chart.mc) ? chart.mc : null,
    planets: Array.isArray(chart.planets) ? chart.planets : [],
    houses: Array.isArray(chart.houses) ? chart.houses : null,
  };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The reading is required by the contract; a missing or malformed line becomes an empty one, which the screen leaves out. */
function toMiniReading(value: unknown): MiniReading {
  const reading = isRecord(value) ? value : {};
  return { sun: text(reading.sun), moon: text(reading.moon), asc: text(reading.asc), summary: text(reading.summary) };
}

/** The known codes in the server's order, each once; anything else in the list is skipped. */
function toWarnings(value: unknown): ChartWarning[] {
  if (!Array.isArray(value)) return [];
  const known: readonly unknown[] = CHART_WARNINGS;
  return [...new Set(value.filter((code): code is ChartWarning => known.includes(code)))];
}

/** One envelope for every method that returns a chart (contract 1.4.0), so one reader. */
function toChartResult(result: unknown): ChartResult {
  // Without a chart there is nothing to show; the rest of the answer degrades to "absent".
  if (!isRecord(result) || !isRecord(result.chart) || typeof result.chart.chart_id !== 'string') throw invalid();
  const wheelPng = text(result.wheel_png_url);
  return {
    chart: withContractShapes(result.chart) as Chart,
    mini_reading: toMiniReading(result.mini_reading),
    warnings: toWarnings(result.warnings),
    wheel_url: text(result.wheel_url),
    is_restored: result.is_restored === true,
    // Not sent by a server older than 1.3.0: the screen then knows there is no PNG.
    ...(wheelPng !== '' && { wheel_png_url: wheelPng }),
  };
}

const FREE: Entitlements = {
  is_active: false,
  plan: 'none',
  full_forecast: false,
  ask_per_day: 0,
  full_report: false,
  full_report_chart_id: null,
  compat_per_month: 0,
  solar_included: false,
};

const NO_SUBSCRIPTION: Subscription = { plan: 'none', is_active: false, expires_at: null, auto_renew: false };

function isQuota(value: unknown): value is Quota {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.used === 'number' &&
    typeof value.limit === 'number' &&
    typeof value.reset_at === 'string'
  );
}

/**
 * `Me` with the parts the screens read brought to the shapes of the contract. What decides
 * access is taken as granted only when the server says exactly `true`: a missing or
 * malformed answer never opens anything.
 */
/**
 * `limits` of `GET /me`: the two bounds the server checks itself.
 *
 * Not numbers — no field: that is an older server (or rubbish), and the client then
 * blocks nothing and shows the `422` with `field_errors[0].field = query`. This build
 * keeps no copy of the numbers: it would drift from the server's.
 */
function toLimits(value: unknown): Me['limits'] {
  if (!isRecord(value)) return undefined;
  const min = value.geo_min_query_length;
  const max = value.geo_max_query_length;
  if (typeof min !== 'number' || typeof max !== 'number') return undefined;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return undefined;
  return { geo_min_query_length: min, geo_max_query_length: max };
}

function toEntitlements(value: unknown): Entitlements {
  const entitlements = isRecord(value) ? value : {};
  return {
    ...FREE,
    ...(entitlements as Partial<Entitlements>),
    is_active: entitlements.is_active === true,
    full_report: entitlements.full_report === true,
    // The chart the report is bought for: an id, or null. Whatever else arrives names no chart.
    full_report_chart_id:
      typeof entitlements.full_report_chart_id === 'string' && entitlements.full_report_chart_id !== ''
        ? entitlements.full_report_chart_id
        : null,
  };
}

function toMe(value: unknown): Me {
  if (!isRecord(value) || typeof value.user_id !== 'string') throw invalid();
  const subscription = isRecord(value.subscription) ? value.subscription : {};
  const limits = toLimits(value.limits);
  return {
    ...(value as Me),
    ...(limits === undefined ? {} : { limits }),
    has_chart: value.has_chart === true,
    chart_id: typeof value.chart_id === 'string' ? value.chart_id : null,
    latest_report_id: typeof value.latest_report_id === 'string' ? value.latest_report_id : null,
    entitlements: toEntitlements(value.entitlements),
    subscription: {
      ...NO_SUBSCRIPTION,
      ...(subscription as Partial<Subscription>),
      is_active: subscription.is_active === true,
      expires_at: typeof subscription.expires_at === 'string' ? subscription.expires_at : null,
      auto_renew: subscription.auto_renew === true,
    },
    quotas: Array.isArray(value.quotas) ? value.quotas.filter(isQuota) : [],
  };
}

function toInvoice(value: unknown): Invoice {
  // Without a link there is nothing to open, without a price nothing to show: not an invoice.
  if (
    !isRecord(value) ||
    typeof value.invoice_link !== 'string' ||
    value.invoice_link === '' ||
    typeof value.stars !== 'number' ||
    !Number.isInteger(value.stars) ||
    value.stars <= 0
  ) {
    throw invalid();
  }
  return value as Invoice;
}

function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REPORT_STATUSES, value);
}

/** The chapters that can be shown, in the order to read them. A chapter without a text is left out, not replaced. */
function toSections(value: unknown): ReportSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ReportSection[] = [];
  const keys = new Set<string>();
  value.forEach((item: unknown, index) => {
    if (!isRecord(item) || typeof item.body_md !== 'string' || item.body_md.trim() === '') return;
    let key = typeof item.key === 'string' && item.key !== '' ? item.key : `section-${String(index)}`;
    // Two chapters under one key are two chapters: the later one gets a key of its own, and both are shown.
    while (keys.has(key)) key = `${key}-${String(index)}`;
    keys.add(key);
    sections.push({
      key,
      title: text(item.title),
      body_md: item.body_md,
      // Without a number the chapter keeps the place the server gave it in the list.
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : index,
    });
  });
  // The sort is stable: chapters with the same number stay as the server listed them.
  return sections.sort((a, b) => a.order - b.order);
}

function toReport(value: unknown): Report {
  // A status this build does not know is not guessed at: the screen would show the wrong thing with confidence.
  if (!isRecord(value) || typeof value.report_id !== 'string' || value.report_id === '' || !isReportStatus(value.status)) throw invalid();
  const isPaid = value.is_paid === true;
  const progress = typeof value.progress === 'number' && Number.isFinite(value.progress) ? value.progress : null;
  const pdfUrl = text(value.pdf_url);
  return {
    report_id: value.report_id,
    chart_id: typeof value.chart_id === 'string' ? value.chart_id : null,
    status: value.status,
    progress: progress === null ? null : Math.min(100, Math.max(0, Math.round(progress))),
    is_paid: isPaid,
    teaser: text(value.teaser),
    // Whatever came with an unpaid report goes no further than this line: not to a screen, not to the DOM.
    sections: isPaid ? toSections(value.sections) : [],
    pdf_url: isPaid && pdfUrl !== '' ? pdfUrl : null,
  };
}

/** The app's name for a focus code of the server; null for anything this build has no label for. */
function focusOf(code: unknown): ForecastFocus | null {
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(FOCUS_BY_CODE, code)) return null;
  return FOCUS_BY_CODE[code as keyof typeof FOCUS_BY_CODE];
}

function toForecast(value: unknown): Forecast {
  // Without a text there is nothing to read, without a date nothing says which day it is about: not a forecast.
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.trim() === '' || typeof value.date !== 'string') throw invalid();
  return {
    date: value.date,
    text: value.text,
    focus: focusOf(value.focus),
    // Full only when the server says exactly `true`, like everything that is about access.
    is_paid: value.is_paid === true,
  };
}

function toAskAnswer(value: unknown): AskAnswer {
  if (!isRecord(value) || typeof value.answer !== 'string' || value.answer.trim() === '') throw invalid();
  const basedOn: unknown[] = Array.isArray(value.based_on) ? value.based_on : [];
  return {
    answer: value.answer,
    based_on: basedOn.filter((item): item is string => typeof item === 'string' && item.trim() !== ''),
  };
}

function toPdfStatus(value: unknown): PdfStatus {
  if (!isRecord(value) || !['pending', 'ready', 'failed'].includes(String(value.status))) throw invalid();
  if (value.status === 'ready' && typeof value.url !== 'string') throw invalid();
  return value as PdfStatus;
}

function toShareCard(value: unknown): ShareCard {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.expires_at !== 'string' || typeof value.caption !== 'string') throw invalid();
  return value as ShareCard;
}

function isPlanOffer(value: unknown): value is PlanOffer {
  return (
    isRecord(value) &&
    typeof value.plan_code === 'string' &&
    value.plan_code !== '' &&
    (value.kind === 'subscription' || value.kind === 'one_off') &&
    typeof value.stars === 'number' &&
    Number.isInteger(value.stars) &&
    value.stars > 0 &&
    (value.period_sec === null || (typeof value.period_sec === 'number' && Number.isInteger(value.period_sec))) &&
    typeof value.title === 'string' &&
    typeof value.subtitle === 'string' &&
    Array.isArray(value.includes) &&
    value.includes.every((item: unknown) => typeof item === 'string') &&
    typeof value.test === 'boolean'
  );
}

function toPlans(value: unknown): PlanOffer[] {
  if (!isRecord(value) || !Array.isArray(value.plans)) throw invalid();
  // A malformed offer is unavailable, not a reason to invent a price or hide other valid offers.
  return value.plans.filter(isPlanOffer);
}

export function createApi(options: HttpClientOptions): Api {
  const request = createHttpClient(options);

  return {
    async getMe(signal) {
      return toMe(await request<unknown>('GET', PATHS.me, { signal }));
    },

    async deleteMe(signal) {
      await request<unknown>('DELETE', PATHS.me, { signal, retry: false });
    },

    async updateNotifications(dailyForecast, signal) {
      const value: unknown = await request('POST', PATHS.notifications, {
        body: { daily_forecast: dailyForecast },
        signal,
        retry: false,
      });
      if (!isRecord(value) || typeof value.daily_forecast !== 'boolean') throw invalid();
      return { daily_forecast: value.daily_forecast };
    },

    async activateCode(code, signal) {
      const body: ActivateCodeRequest = { code };
      const value: unknown = await request('POST', PATHS.activateCode, { body, signal, retry: false });
      // Without the rights the screen would have nothing to confirm: not an activation.
      if (!isRecord(value) || !isRecord(value.entitlements)) throw invalid();
      return toEntitlements(value.entitlements);
    },

    async cancelSubscription(idempotencyKey, signal) {
      const value: unknown = await request('POST', PATHS.subscriptionCancel, {
        headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
        signal,
        retry: false,
      });
      if (
        !isRecord(value) ||
        value.status !== 'cancelled' ||
        value.auto_renew !== false ||
        typeof value.current_period_end !== 'string'
      ) throw invalid();
      return value as SubscriptionCancelResult;
    },

    async resolveGeo(query, signal) {
      const body: GeoResolveRequest = { query };
      const places = await request<unknown>('POST', PATHS.geoResolve, { body, signal });
      if (!Array.isArray(places) || !places.every(isGeoPlace)) throw invalid();
      return places;
    },

    async createChart(input, signal) {
      // 201 for a new chart, 200 for one that already existed: the body is the same either way.
      return toChartResult(await request<unknown>('POST', PATHS.charts, { body: input, signal }));
    },

    async getCurrentChart(signal) {
      try {
        return toChartResult(await request<unknown>('GET', PATHS.currentChart, { signal }));
      } catch (error) {
        // The contract's way of saying «no chart yet».
        if (isApiError(error) && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },

    async sendEvents(events, { keepalive } = {}) {
      const body: EventsBatch = { events };
      await request<unknown>('POST', PATHS.events, { body, keepalive, retry: false });
    },

    async getPlans(signal) {
      return toPlans(await request<unknown>('GET', PATHS.plans, { signal, cache: 'no-store' }));
    },

    async createInvoice(input, signal) {
      return toInvoice(await request<unknown>('POST', PATHS.invoice, { body: input, signal, retry: false }));
    },

    async orderReport(input, idempotencyKey, signal) {
      // Safe to repeat after a 5xx: the key makes the second attempt the same order.
      const headers = { [IDEMPOTENCY_HEADER]: idempotencyKey };
      return toReport(await request<unknown>('POST', PATHS.reports, { body: input, headers, signal }));
    },

    async getReport(reportId, signal) {
      return toReport(await request<unknown>('GET', PATHS.report.replace('{report_id}', encodeURIComponent(reportId)), { signal }));
    },

    async createReportPdf(reportId, idempotencyKey, signal) {
      const headers = { [IDEMPOTENCY_HEADER]: idempotencyKey };
      return toPdfStatus(await request<unknown>('POST', PATHS.reportPdf.replace('{report_id}', encodeURIComponent(reportId)), { headers, signal, retry: false }));
    },

    async getReportPdf(reportId, signal) {
      return toPdfStatus(await request<unknown>('GET', PATHS.reportPdf.replace('{report_id}', encodeURIComponent(reportId)), { signal, cache: 'no-store' }));
    },

    async createShareCard(kind, tz, signal) {
      return toShareCard(await request<unknown>('POST', PATHS.shareCard, { body: { kind, tz }, signal, retry: false }));
    },

    async getCompatibilities(limit = 20, offset = 0, signal) {
      const query = `?limit=${Math.min(20, Math.max(1, limit))}&offset=${Math.max(0, offset)}`;
      const value: unknown = await request('GET', `${PATHS.compatibility}${query}`, { signal, cache: 'no-store' });
      if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.quota)) throw invalid();
      const quota = value.quota;
      if (
        !['purchase', 'subscription', 'none'].includes(String(quota.kind)) ||
        typeof quota.left !== 'number' ||
        (quota.resets_at !== null && typeof quota.resets_at !== 'string')
      ) throw invalid();
      return value as CompatibilityList;
    },

    async orderCompatibility(input, idempotencyKey, signal) {
      const headers = { [IDEMPOTENCY_HEADER]: idempotencyKey };
      const body = await request<unknown>('POST', PATHS.compatibility, { body: input, headers, signal, retry: false });
      if (!isRecord(body) || typeof body.compatibility_id !== 'string' || body.status !== 'pending') throw invalid();
      return body as components['schemas']['CompatibilityAccepted'];
    },

    async getCompatibility(id, signal) {
      const value: unknown = await request('GET', PATHS.compatibilityById.replace('{compatibility_id}', encodeURIComponent(id)), { signal });
      if (
        !isRecord(value) ||
        value.id !== id ||
        !['pending', 'ready', 'failed'].includes(String(value.status)) ||
        !Array.isArray(value.sections)
      ) throw invalid();
      return value as Compatibility;
    },

    async getForecast(chartId, signal) {
      try {
        return toForecast(await request<unknown>('GET', `${PATHS.forecast}?chart_id=${encodeURIComponent(chartId)}`, { signal }));
      } catch (error) {
        // The contract's way of saying «not prepared yet».
        if (isApiError(error) && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },

    async getForecastToday(signal) {
      // The server may spend up to 25 seconds preparing the day. Keep this budget local to
      // this read; the 15-second client default remains in force for every other endpoint.
      return await request<ForecastDay>('GET', PATHS.forecastToday, { signal, cache: 'no-store', timeoutMs: 30_000 });
    },

    async listQuestions(limit = 20, offset = 0, signal) {
      const query = `?limit=${Math.min(20, Math.max(1, limit))}&offset=${Math.max(0, offset)}`;
      return await request<QuestionList>('GET', `${PATHS.questions}${query}`, { signal, cache: 'no-store' });
    },

    async createQuestion(question, idempotencyKey, signal) {
      const headers = { [IDEMPOTENCY_HEADER]: idempotencyKey };
      return await request<QuestionAccepted>('POST', PATHS.questions, { body: { question }, headers, signal, retry: false });
    },

    async getQuestion(id, signal) {
      return await request<Question>('GET', PATHS.question.replace('{question_id}', encodeURIComponent(id)), { signal, cache: 'no-store' });
    },

    async ask(input, signal) {
      // The quota that comes with the answer is not read: the screens show the one of `Me`, asked anew after every answer.
      return toAskAnswer(await request<unknown>('POST', PATHS.ask, { body: input, signal, retry: false }));
    },
  };
}

/** Absolute URL for a path or URL returned by the API; null when it cannot be parsed. */
export function absoluteApiUrl(pathOrUrl: string, baseUrl: string, origin: string): string | null {
  try {
    return new URL(pathOrUrl, new URL(API_ROOT, baseUrl === '' ? origin : baseUrl)).href;
  } catch {
    return null;
  }
}
