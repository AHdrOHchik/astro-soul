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

/** What can be bought, by the codes of the contract. Prices are not here: the invoice names them. */
export type PlanCode = components['schemas']['PlanCode'];
export type InvoiceRequest = components['schemas']['InvoiceRequest'];
/** A Stars invoice: the link Telegram opens, and the price the server put on it. */
export type Invoice = components['schemas']['Invoice'];

type ReportEnvelope = components['schemas']['Report'];
export type ReportRequest = components['schemas']['ReportRequest'];
export type ReportStatus = ReportEnvelope['status'];

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
  reports: '/api/v1/reports',
  report: '/api/v1/reports/{report_id}',
} as const satisfies Record<string, keyof paths>;

/** The header of `POST /reports` that makes a repeated order the same order. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface Api {
  getMe(signal?: AbortSignal): Promise<Me>;
  /**
   * Deletes everything the server keeps about the user. Sent once: whether to try again
   * after a failure is the user's decision, made with a tap.
   */
  deleteMe(signal?: AbortSignal): Promise<void>;
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
function toMe(value: unknown): Me {
  if (!isRecord(value) || typeof value.user_id !== 'string') throw invalid();
  const entitlements = isRecord(value.entitlements) ? value.entitlements : {};
  const subscription = isRecord(value.subscription) ? value.subscription : {};
  return {
    ...(value as Me),
    has_chart: value.has_chart === true,
    chart_id: typeof value.chart_id === 'string' ? value.chart_id : null,
    latest_report_id: typeof value.latest_report_id === 'string' ? value.latest_report_id : null,
    entitlements: {
      ...FREE,
      ...(entitlements as Partial<Entitlements>),
      is_active: entitlements.is_active === true,
      full_report: entitlements.full_report === true,
    },
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

export function createApi(options: HttpClientOptions): Api {
  const request = createHttpClient(options);

  return {
    async getMe(signal) {
      return toMe(await request<unknown>('GET', PATHS.me, { signal }));
    },

    async deleteMe(signal) {
      await request<unknown>('DELETE', PATHS.me, { signal, retry: false });
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
