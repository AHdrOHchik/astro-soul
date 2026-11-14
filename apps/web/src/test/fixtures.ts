/* Shared test doubles. All birth data here is invented. */
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { EventName, Track } from '../analytics';
import type { Api, Chart, ChartCreateRequest, ChartResult, FieldError, GeoPlace, Invoice, Me, Report, ReportSection } from '../api';
import { ApiError, type ApiErrorCode } from '../api';
import { CONSENT_VERSION } from '../i18n/ru';
import type { IdempotencyKeys } from '../lib/idempotency';
import type { TermsReload } from '../lib/termsReload';
import type { InvoiceOutcome, Telegram } from '../telegram';

/** Noon UTC: the app reads the UTC day, so the tests give the same result in any time zone. */
export const TODAY = new Date(Date.UTC(2026, 10, 10, 12));

export const kazan: GeoPlace = {
  name: 'Казань',
  region: 'Татарстан',
  country: 'RU',
  lat: 55.7963,
  lon: 49.1088,
  tz: 'Europe/Moscow',
};

export const kazanka: GeoPlace = {
  name: 'Казанка',
  region: 'Николаевская область',
  country: 'UA',
  lat: 47.8381,
  lon: 32.8236,
  tz: 'Europe/Kyiv',
};

export const entitlements: Me['entitlements'] = {
  is_active: false,
  plan: 'none',
  full_forecast: false,
  ask_per_day: 0,
  full_report: false,
  compat_per_month: 0,
  solar_included: false,
};

export const me: Me = {
  user_id: '00000000-0000-4000-8000-000000000001',
  display_name: null,
  is_new: true,
  has_profile: false,
  has_chart: false,
  chart_id: null,
  subscription: { plan: 'none', is_active: false, expires_at: null, auto_renew: false },
  entitlements,
  quotas: [],
  onboarding_step: 'birth_date',
};

/** A complete body of `POST /charts`: what the app sends once every step is filled in and the consent box is ticked. */
export const chartRequest: ChartCreateRequest = {
  birth_date: '1994-05-17',
  birth_time: '14:30',
  time_precision: 'exact',
  birth_place: kazan,
  consent: { accepted: true, version: CONSENT_VERSION },
};

export const chart: Chart = {
  chart_id: '00000000-0000-4000-8000-00000000c0de',
  created_at: '2026-11-10T09:00:00Z',
  birth: { date: '1994-05-17', time: '14:30', time_known: true, time_precision: 'exact', place: kazan },
  asc: { sign: 'Дева', degree: 4, minute: 9 },
  mc: { sign: 'Близнецы', degree: 18, minute: 44 },
  planets: [
    { key: 'sun', name: 'Солнце', sign: 'Телец', degree: 26, minute: 17, house: 9, retrograde: false },
    { key: 'moon', name: 'Луна', sign: 'Рак', degree: 3, minute: 5, house: 11, retrograde: false },
    { key: 'mercury', name: 'Меркурий', sign: 'Близнецы', degree: 11, minute: 40, house: 10, retrograde: true },
  ],
  houses: [],
  aspects: [],
  balances: {},
};

export const chartResult: ChartResult = {
  chart,
  mini_reading: {
    sun: 'Текст про Солнце.',
    moon: 'Текст про Луну.',
    asc: 'Текст про Асцендент.',
    summary: 'Начало полного разбора.',
  },
  wheel_url: `/api/v1/charts/${chart.chart_id}/wheel.svg?sig=test-signature`,
  wheel_png_url: `/api/v1/charts/${chart.chart_id}/wheel.png?sig=test-signature`,
  warnings: [],
  is_restored: false,
};

/** The same chart as the API returns it when the birth time is unknown. */
export const chartWithoutTime: ChartResult = {
  chart: {
    ...chart,
    birth: { date: '1994-05-17', time: null, time_known: false, time_precision: 'unknown', place: kazan },
    asc: null,
    mc: null,
    houses: null,
    planets: chart.planets.map((planet) => ({ ...planet, house: null })),
  },
  mini_reading: {
    sun: 'Текст про Солнце.',
    moon: 'Текст про Луну.',
    asc: 'Время рождения неизвестно — Асцендент не рассчитан',
    summary: 'Начало полного разбора.',
  },
  wheel_url: chartResult.wheel_url,
  wheel_png_url: chartResult.wheel_png_url,
  warnings: ['no_birth_time'],
  is_restored: false,
};

/** `Me` of a user who has the fixture chart and nothing bought. */
export const meWithChart: Me = { ...me, is_new: false, has_profile: true, has_chart: true, chart_id: chart.chart_id, onboarding_step: 'done' };

/** The same user with the full report bought. */
export const mePaid: Me = { ...meWithChart, entitlements: { ...entitlements, full_report: true } };

/** The same user with a monthly subscription that renews. */
export const meSubscribed: Me = {
  ...meWithChart,
  subscription: { plan: 'month', is_active: true, expires_at: '2026-12-10T09:00:00Z', auto_renew: true },
  entitlements: { ...entitlements, is_active: true, plan: 'month', full_forecast: true, ask_per_day: 5, compat_per_month: 1 },
};

/** A Stars invoice for the full report at its usual price. */
export const reportInvoice: Invoice = {
  invoice_link: 'https://t.me/$test-invoice',
  plan_code: 'one_149',
  stars: 149,
  is_subscription: false,
  subscription_period_sec: null,
};

export const REPORT_ID = '00000000-0000-4000-8000-0000000000aa';

/** Two chapters, the way a report in work has them: the first two of seven. */
export const sections: ReportSection[] = [
  { key: 'core', title: 'Ядро личности', body_md: 'Текст первой главы.', order: 0 },
  { key: 'emotions', title: 'Эмоции и внутренний мир', body_md: 'Текст второй главы.', order: 1 },
];

/** A paid report, queued: what the server knows right after the order. Tests spread it into the state they need. */
export const report: Report = {
  report_id: REPORT_ID,
  chart_id: chart.chart_id,
  status: 'queued',
  progress: 0,
  is_paid: true,
  teaser: '',
  sections: [],
  pdf_url: null,
};

export function apiError(code: ApiErrorCode, info: ConstructorParameters<typeof ApiError>[1] = {}): ApiError {
  return new ApiError(code, info);
}

/** `422 VALIDATION_FAILED` as the API sends it: the fields in `details.field_errors`, the first text as the message. */
export function rejection(...fieldErrors: FieldError[]): ApiError {
  return apiError('VALIDATION_FAILED', {
    status: 422,
    serverMessage: fieldErrors[0]?.message,
    requestId: 'req-422',
    details: { field_errors: fieldErrors },
  });
}

export function fakeApi() {
  return {
    getMe: vi.fn<Api['getMe']>().mockResolvedValue(me),
    resolveGeo: vi.fn<Api['resolveGeo']>().mockResolvedValue([kazan, kazanka]),
    createChart: vi.fn<Api['createChart']>().mockResolvedValue(chartResult),
    // A new user: the server has no chart to open.
    getCurrentChart: vi.fn<Api['getCurrentChart']>().mockResolvedValue(null),
    sendEvents: vi.fn<Api['sendEvents']>().mockResolvedValue(undefined),
    deleteMe: vi.fn<Api['deleteMe']>().mockResolvedValue(undefined),
    createInvoice: vi.fn<Api['createInvoice']>().mockResolvedValue(reportInvoice),
    orderReport: vi.fn<Api['orderReport']>().mockResolvedValue(report),
    getReport: vi.fn<Api['getReport']>().mockResolvedValue(report),
  };
}

/** Idempotency keys that are easy to tell apart: `key-1`, `key-2`, … Kept per chart and kind, like the real ones. */
export function fakeKeys(): IdempotencyKeys {
  const kept = new Map<string, string>();
  let made = 0;
  const create = (name: string) => {
    made += 1;
    const key = `key-${String(made)}`;
    kept.set(name, key);
    return key;
  };
  return {
    current: (chartId, type) => kept.get(`${type}.${chartId}`) ?? create(`${type}.${chartId}`),
    renew: (chartId, type) => create(`${type}.${chartId}`),
  };
}

export interface TrackedEvent {
  name: EventName;
  props?: object;
}

/** Stands in for the product analytics: keeps the events the app reports, in order. */
export function fakeAnalytics() {
  const events: TrackedEvent[] = [];
  const track: Track = (name, ...[props]) => {
    events.push(props === undefined ? { name } : { name, props });
  };
  return {
    track,
    events,
    names: () => events.map((event) => event.name),
    /** The event reported last. */
    last: () => events[events.length - 1],
    /** Forgets what was reported so far, to look only at what follows. */
    clear: () => {
      events.length = 0;
    },
  };
}

/**
 * The restart for newer legal texts, without a page to reload. `refusedVersion` is what
 * the start before this one left behind; `storage: false` is a browser that keeps nothing.
 */
export function fakeTermsReload(options: { refusedVersion?: string | null; storage?: boolean } = {}) {
  return {
    refusedVersion: options.refusedVersion ?? null,
    remember: vi.fn<TermsReload['remember']>().mockReturnValue(options.storage ?? true),
    reload: vi.fn<TermsReload['reload']>(),
  };
}

/** Where the app runs; the methods are always spies. */
type Host = Pick<Telegram, 'isTelegram' | 'initData' | 'hasNativeBackButton' | 'canPay'>;

/** `invoice`: how Telegram closes every invoice it is asked to open; «paid» unless the test says otherwise. */
export function fakeTelegram(host: Partial<Host> & { invoice?: InvoiceOutcome | Promise<InvoiceOutcome> } = {}) {
  const { invoice = 'paid', ...where } = host;
  return {
    isTelegram: true,
    initData: 'query_id=test',
    hasNativeBackButton: true,
    canPay: true,
    ...where,
    setBackHandler: vi.fn<Telegram['setBackHandler']>(),
    ready: vi.fn<Telegram['ready']>(),
    share: vi.fn<Telegram['share']>(),
    close: vi.fn<Telegram['close']>(),
    openInvoice: vi.fn<Telegram['openInvoice']>().mockImplementation(() => Promise.resolve(invoice)),
    openLink: vi.fn<Telegram['openLink']>(),
  };
}

/** A promise settled by the test, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * user-event on fake timers, so the search debounce can be stepped through.
 * `shouldAdvanceTime` keeps Testing Library's own polling (findBy*, waitFor) alive.
 */
export function setupUser() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
}
