/*
 * Dev-only stand-in for the backend (apps/api is owned by BACKEND and is not
 * part of this package). Enabled with API_MOCK=1 for `vite` and `vite preview`;
 * it is never part of the production bundle.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PLANS } from '@astro-soul/shared';
import type { Connect, Plugin } from 'vite';
import { EVENT_NAMES } from '../src/analytics/events.ts';
import {
  buildChart,
  buildMe,
  findPlaces,
  inputKey,
  MOCK_CHART_ID,
  MOCK_CONSENT_VERSION,
  problem,
  RETURNING_INPUT,
  SCENARIO,
} from './fixtures.ts';
import type { ChartCreateRequest, ChartResponse, EventsAccepted, FieldError, Invoice, MockAccount, PlanCode, Problem } from './fixtures.ts';
import { isRefunded, mockPdf, REPORT_SCENARIOS, viewOf, type MockReport, type ReportPace, type ReportScenario } from './reports.ts';
import { renderMockWheel } from './wheel.ts';
import { PNG_SIZES, renderMockWheelPng } from './wheelPng.ts';

export interface MockApiOptions {
  /** Artificial latency, so loading states can be seen. */
  delayMs: number;
  /**
   * Who the user is, a list of words separated by commas: `401` and `500` fail GET /me;
   * `returning` already has a chart; `paid` has, besides the chart, the full report bought
   * for it; `subscriber` has a chart and a monthly subscription. Nothing = a new user.
   * Either way the mock remembers what happens to its user until it is restarted.
   */
  me?: string;
  /**
   * The version of the legal texts this "server" accepts in `consent.version`; any other is refused.
   * By default MOCK_CONSENT_VERSION, the one of the app's own texts. Another value plays a server
   * whose texts are newer than the app's.
   */
  consentVersion?: string;
  /** How every report of this run ends: `ready` (the default), `failed`, `refunded` or `stuck`. */
  report?: string;
  /** How long one chapter of a report takes, so the progress can be watched or hurried. */
  reportChapterMs?: number;
  /** POST /billing/invoice: `422` and `500` fail it, `price` makes the invoice dearer than the app expects. */
  invoice?: string;
  /** DELETE /me: `409`, `401` or `500` fail it; by default everything is deleted. */
  deletion?: string;
  /** A finished report has a PDF to download. Off by default, as in apps/api, which makes none yet. */
  pdf?: boolean;
}

const PREFIX = '/api/v1';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendPng(res: ServerResponse, png: Buffer): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.end(png);
}

function sendProblem(res: ServerResponse, status: number, code: Problem['code'], message: string, details?: Problem['details']): void {
  send(res, status, problem(code, message, details), 'application/problem+json');
}

/** 422 the way the API sends it: the fields in `details.field_errors`, the text of the first one as `message`. */
function sendInvalid(res: ServerResponse, errors: readonly [FieldError, ...FieldError[]]): void {
  sendProblem(res, 422, 'VALIDATION_FAILED', errors[0].message, { field_errors: [...errors] });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/*
 * The user-facing texts of the mock are the ones apps/api sends (i18n/ru.ts,
 * modules/charts/charts.dto.ts, modules/geo/geo.service.ts, modules/events/events.dto.ts;
 * for reports, invoices and the deletion, the ones of the backend's pull request #20,
 * which is where those answers are written), so a screen looks in the mock the way it
 * will with the real server.
 */
const MESSAGE = {
  UNAUTHORIZED: 'Не удалось подтвердить вход. Открой приложение заново из чата с ботом.',
  FORBIDDEN: 'Это действие тебе недоступно.',
  NOT_FOUND: 'Такой страницы нет. Обнови приложение.',
  VALIDATION_FAILED: 'Проверь введённые данные.',
  RATE_LIMITED: 'Слишком много запросов. Попробуй через минуту.',
  INTERNAL: 'Что-то сломалось на нашей стороне. Мы уже разбираемся.',
  GEO_NOT_FOUND: 'Поиск городов временно недоступен. Попробуй ещё раз через минуту.',
} as const satisfies Partial<Record<Problem['code'], string>>;

/** What the server says when the consent was given to texts of another version than its own. */
const CONSENT_VERSION_REFUSED: FieldError = { field: 'consent.version', message: 'Условия обновились — подтверди согласие ещё раз' };

const FIELD_MESSAGE = {
  birth_date: 'Укажи дату рождения в формате ГГГГ-ММ-ДД',
  birth_time: 'Укажи время рождения в формате ЧЧ:ММ или отметь, что не знаешь',
  time_precision: 'Укажи, насколько точно известно время рождения',
  birth_place: 'Выбери город рождения из подсказок',
  consent: 'Без согласия на обработку данных мы не можем построить карту',
} as const;

const PRECISIONS: readonly unknown[] = ['exact', 'approximate', 'unknown'] satisfies ChartCreateRequest['time_precision'][];

function isPlace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.country === 'string' &&
    typeof value.tz === 'string' &&
    typeof value.lat === 'number' &&
    typeof value.lon === 'number'
  );
}

function isConsent(value: unknown): boolean {
  return isRecord(value) && value.accepted === true && typeof value.version === 'string' && /^.{1,32}$/.test(value.version);
}

/** The limits of the contract for a search query, counted after trimming. */
const QUERY_LENGTH = { min: 2, max: 120 } as const;

/** The limits of the contract for product events. */
const EVENTS = {
  maxBatch: 20,
  maxPropLength: 64,
  /** An event may be this much ahead of the server's clock, and this old. */
  maxAheadMs: 5 * 60_000,
  maxAgeMs: 24 * 60 * 60_000,
  /** Keys the server takes for personal data: an event with one of them is dropped without a word. */
  forbiddenProps: [
    'birth_date',
    'birth_time',
    'birth_place',
    'date',
    'time',
    'place',
    'city',
    'query',
    'lat',
    'lon',
    'tz',
    'first_name',
    'last_name',
    'username',
    'phone',
    'email',
  ],
} as const;

const EVENT_MESSAGE = {
  events: 'События должны быть батчем от 1 до 20 штук',
  'events.name': 'Такого события нет в контракте',
  'events.occurred_at': 'Время события — ISO 8601 с часовым поясом',
  'events.props': 'Свойства события — короткие строки, числа или флаги',
} as const;

type EventField = keyof typeof EVENT_MESSAGE;

const isEventProp = (value: unknown) =>
  (typeof value === 'string' && value.length <= EVENTS.maxPropLength) || typeof value === 'number' || typeof value === 'boolean';

/** What is wrong with the shape of one event; undefined for an event the server would parse. */
function eventShapeError(event: unknown): EventField | undefined {
  if (!isRecord(event)) return 'events';
  if (typeof event.name !== 'string' || !Object.hasOwn(EVENT_NAMES, event.name)) return 'events.name';
  const { occurred_at: at } = event;
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(at) || Number.isNaN(Date.parse(at))) {
    return 'events.occurred_at';
  }
  if (event.props !== undefined && !(isRecord(event.props) && Object.values(event.props).every(isEventProp))) return 'events.props';
  return undefined;
}

/**
 * `POST /events` as apps/api answers it: one malformed event fails the whole batch with
 * 422; an event with personal data in `props`, or with a time outside the window, is dropped
 * silently and only lowers `accepted`.
 */
export function eventsAnswer(body: unknown, now: number): { errors: FieldError[] } | EventsAccepted {
  const events = isRecord(body) ? body.events : undefined;
  if (!Array.isArray(events) || events.length < 1 || events.length > EVENTS.maxBatch) {
    return { errors: [{ field: 'events', message: EVENT_MESSAGE.events }] };
  }
  const fields = new Set<EventField>();
  for (const event of events) {
    const field = eventShapeError(event);
    if (field) fields.add(field);
  }
  if (fields.size > 0) return { errors: [...fields].map((field) => ({ field, message: EVENT_MESSAGE[field] })) };

  const accepted = (events as { occurred_at: string; props?: Record<string, unknown> }[]).filter((event) => {
    const forbidden: readonly string[] = EVENTS.forbiddenProps;
    if (Object.keys(event.props ?? {}).some((key) => forbidden.includes(key))) return false;
    const at = Date.parse(event.occurred_at);
    return at <= now + EVENTS.maxAheadMs && at >= now - EVENTS.maxAgeMs;
  });
  return { accepted: accepted.length };
}

/** The fields of a `POST /charts` body the server would reject, in the order of the form. Empty for a body it accepts. */
function chartRequestErrors(body: unknown, consentVersion: string): FieldError[] {
  if (!isRecord(body)) return [{ field: 'body', message: 'Проверь это поле' }];
  const time = body.birth_time;
  const timeGiven = typeof time === 'string';
  const malformed: Record<keyof typeof FIELD_MESSAGE, boolean> = {
    birth_date: typeof body.birth_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.birth_date),
    birth_time: !(time === undefined || time === null || (timeGiven && /^([01]\d|2[0-3]):[0-5]\d$/.test(time))),
    time_precision: !PRECISIONS.includes(body.time_precision),
    birth_place: !isPlace(body.birth_place),
    consent: !isConsent(body.consent),
  };
  const errors: FieldError[] = [];
  for (const field of Object.keys(FIELD_MESSAGE) as (keyof typeof FIELD_MESSAGE)[]) {
    if (malformed[field]) errors.push({ field, message: FIELD_MESSAGE[field] });
  }
  if (errors.length > 0) return errors;

  // From here on, as in apps/api, everything that is wrong is named at once.
  if (body.time_precision === 'unknown' && timeGiven) {
    errors.push({ field: 'birth_time', message: 'Если время неизвестно, оставь это поле пустым' });
  }
  if (body.time_precision !== 'unknown' && !timeGiven) {
    errors.push({ field: 'birth_time', message: 'Укажи время рождения или отметь, что не знаешь' });
  }
  if ((body.consent as { version: string }).version !== consentVersion) errors.push(CONSENT_VERSION_REFUSED);
  return errors;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `Idempotency-Key` as apps/api takes it (`reports.dto.ts`). */
const IDEMPOTENCY_KEY = /^[\w.:-]{1,64}$/;

/** apps/api counts invoices: no more than three an hour for one user (payments.md §5). */
const INVOICES_PER_HOUR = 3;
/** What `API_MOCK_INVOICE=price` adds to the price: an invoice that is not the one the app expected. */
const PRICE_SURPRISE = 50;

/** Before a report is taken into work, and after that per chapter. */
const REPORT_QUEUED_MS = 1500;
const REPORT_CHAPTER_MS = 2500;

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && Object.hasOwn(PLANS, value);
}

function createHandler({
  delayMs,
  me: meScenario = '',
  consentVersion = MOCK_CONSENT_VERSION,
  report: reportScenario,
  reportChapterMs = REPORT_CHAPTER_MS,
  invoice: invoiceScenario,
  deletion: deletionScenario,
  pdf = false,
}: MockApiOptions) {
  const who = meScenario.split(',').map((word) => word.trim());
  const startsWithChart = who.some((word) => word === 'returning' || word === 'paid' || word === 'subscriber');
  const scenario: ReportScenario = REPORT_SCENARIOS.find((name) => name === reportScenario) ?? 'ready';
  const pace: ReportPace = { queuedMs: REPORT_QUEUED_MS, chapterMs: reportChapterMs };

  // All the mock keeps between requests: the user's chart with the birth data it was built from,
  // what the user has bought, and the reports ordered.
  let current: { key: string; chart: ChartResponse } | null = startsWithChart
    ? { key: inputKey(RETURNING_INPUT), chart: buildChart(RETURNING_INPUT) }
    : null;
  /** The charts the full report is bought for. */
  const paidCharts = new Set<string>(who.includes('paid') ? [MOCK_CHART_ID] : []);
  let subscription: MockAccount['subscription'] = who.includes('subscriber') ? { plan: 'month', expiresAt: Date.now() + MONTH_MS } : null;
  const reports = new Map<string, MockReport>();
  /** Idempotency keys already used, with the report each one ordered. */
  const reportKeys = new Map<string, string>();
  let latestReportId: string | null = null;
  /** The invoices made, by link: what a payment of each one buys. */
  const invoices = new Map<string, { plan: PlanCode; chartId: string | null }>();

  /** A refund takes the purchase back: seen here, the way the job of apps/api does it between requests. */
  const settleRefunds = (now: number) => {
    for (const report of reports.values()) if (isRefunded(report, pace, now)) paidCharts.delete(report.chartId);
  };
  const account = (): MockAccount => ({
    chartId: current?.chart.chart.chart_id ?? null,
    subscription,
    fullReport: paidCharts.size > 0,
    latestReportId,
  });
  const pdfUrlOf = (reportId: string) => (pdf ? `${PREFIX}/reports/${reportId}/report.pdf?sig=mock-signature` : null);
  const reportView = (report: MockReport, now: number, paid: boolean) => viewOf(report, pace, now, paid, pdfUrlOf(report.id));

  /** What Telegram's webhook does on the real server: the payment of an invoice becomes what it bought. */
  const pay = (link: string) => {
    const invoice = invoices.get(link);
    if (!invoice) return;
    const plan = PLANS[invoice.plan];
    if (plan.kind === 'subscription') subscription = { plan: plan.subscriptionPlan as 'week' | 'month' | 'year', expiresAt: Date.now() + plan.periodSeconds * 1000 };
    else if (plan.grant === 'report' && invoice.chartId !== null) paidCharts.add(invoice.chartId);
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.slice(PREFIX.length);
    const route = `${req.method ?? 'GET'} ${path}`;
    await sleep(delayMs);

    if (route === 'POST /__mock/payments') {
      // Not a part of the API: stands in for Telegram telling the server that an invoice is paid.
      // `delay_ms` plays a webhook that is late.
      const body = await readJson(req);
      const link = isRecord(body) && typeof body.invoice_link === 'string' ? body.invoice_link : '';
      const delay = isRecord(body) && typeof body.delay_ms === 'number' ? body.delay_ms : 0;
      setTimeout(() => {
        pay(link);
      }, delay);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (route === 'POST /__mock/revoke') {
      // Not a part of the API either: takes every purchase of the report back, the way a refund through support does.
      // What is left of a report then is what the server shows unpaid: its opening.
      paidCharts.clear();
      res.statusCode = 204;
      res.end();
      return;
    }

    const pdfOf = /^\/reports\/([^/]+)\/report\.pdf$/.exec(path);
    if (pdfOf && (req.method === 'GET' || req.method === 'HEAD')) {
      // Public by signed token, like the wheel.
      if (!pdf || !reports.has(pdfOf[1] ?? '') || !url.searchParams.get('sig')) {
        sendProblem(res, 404, 'NOT_FOUND', MESSAGE.NOT_FOUND);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
      res.end(req.method === 'HEAD' ? undefined : mockPdf());
      return;
    }

    const wheel = { svg: `GET /charts/${MOCK_CHART_ID}/wheel.svg`, png: `GET /charts/${MOCK_CHART_ID}/wheel.png` };
    if (route === wheel.svg || route === wheel.png) {
      // Public by signed token: no initData here, see the contract. The same signature opens both.
      if (!url.searchParams.get('sig')) {
        sendProblem(res, 403, 'FORBIDDEN', MESSAGE.FORBIDDEN);
        return;
      }
      const theme = url.searchParams.get('theme') ?? 'dark';
      if (theme !== 'dark' && theme !== 'light') {
        sendInvalid(res, [{ field: 'theme', message: 'Тема может быть dark или light' }]);
        return;
      }
      if (route === wheel.svg) {
        send(res, 200, renderMockWheel(theme), 'image/svg+xml');
        return;
      }
      // The default width, or one of the two the contract names; any other is refused, not replaced.
      const size = Number(url.searchParams.get('size') ?? PNG_SIZES[0]);
      if (!PNG_SIZES.includes(size)) {
        sendInvalid(res, [{ field: 'size', message: 'Размер картинки — 1080 или 1600' }]);
        return;
      }
      sendPng(res, renderMockWheelPng(theme, size));
      return;
    }

    if (!req.headers['x-telegram-init-data']) {
      sendProblem(res, 401, 'UNAUTHORIZED', MESSAGE.UNAUTHORIZED);
      return;
    }

    const now = Date.now();
    settleRefunds(now);

    if (route === 'GET /me') {
      if (who.includes('401')) sendProblem(res, 401, 'UNAUTHORIZED', MESSAGE.UNAUTHORIZED);
      else if (who.includes('500')) sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      else send(res, 200, buildMe(account(), now));
      return;
    }

    if (route === 'DELETE /me') {
      if (deletionScenario === '409') {
        // The text and the reason of apps/api (`me.service.ts`) for a refund that did not go through.
        sendProblem(res, 409, 'CONFLICT', 'Не получилось вернуть звёзды за незавершённую оплату. Напиши в поддержку — вернём вручную.', {
          reason: 'refund_failed',
        });
      } else if (deletionScenario === '401') {
        sendProblem(res, 401, 'UNAUTHORIZED', MESSAGE.UNAUTHORIZED);
      } else if (deletionScenario === '500') {
        sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      } else {
        // Everything about the user goes; the subscription lives on to the end of its period, as on the server.
        current = null;
        paidCharts.clear();
        reports.clear();
        reportKeys.clear();
        latestReportId = null;
        res.statusCode = 204;
        res.end();
      }
      return;
    }

    if (route === 'POST /billing/invoice') {
      const body = await readJson(req);
      const plan = isRecord(body) ? body.plan_code : undefined;
      const chartId = isRecord(body) && typeof body.chart_id === 'string' ? body.chart_id : null;
      if (invoiceScenario === '500') {
        sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      } else if (invoiceScenario === '422') {
        // A 422 without `field_errors`: the app has to read this form too.
        sendProblem(res, 422, 'VALIDATION_FAILED', MESSAGE.VALIDATION_FAILED);
      } else if (!isPlanCode(plan)) {
        sendInvalid(res, [{ field: 'plan_code', message: 'plan_code — один из тарифов каталога' }]);
      } else if (plan === 'one_149' && chartId === null) {
        sendInvalid(res, [{ field: 'chart_id', message: 'Выбери карту, для которой покупаешь разбор' }]);
      } else if (chartId !== null && chartId !== current?.chart.chart.chart_id) {
        sendProblem(res, 404, 'NOT_FOUND', MESSAGE.NOT_FOUND, { reason: 'chart_not_found' });
      } else if (invoices.size >= INVOICES_PER_HOUR) {
        // The limit is checked before anything else, as in apps/api: also for a plan that already has an invoice.
        sendProblem(res, 429, 'RATE_LIMITED', MESSAGE.RATE_LIMITED, { reason: 'invoice_limits', hour_limit: INVOICES_PER_HOUR });
      } else {
        const { stars, kind, periodSeconds } = PLANS[plan];
        // The same plan again gets the invoice it already has: a double tap is not a second invoice.
        let link = [...invoices].find(([, made]) => made.plan === plan && made.chartId === chartId)?.[0];
        if (link === undefined) {
          link = `https://t.me/$mock${String(invoices.size + 1)}${randomUUID().slice(0, 8)}`;
          invoices.set(link, { plan, chartId });
        }
        const invoice: Invoice = {
          invoice_link: link,
          plan_code: plan,
          stars: invoiceScenario === 'price' ? stars + PRICE_SURPRISE : stars,
          is_subscription: kind === 'subscription',
          subscription_period_sec: periodSeconds,
        };
        send(res, 201, invoice);
      }
      return;
    }

    if (route === 'POST /reports') {
      const body = await readJson(req);
      const key = req.headers['idempotency-key'];
      const chartId = isRecord(body) ? body.chart_id : undefined;
      const type = isRecord(body) ? body.type : undefined;
      if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
        sendInvalid(res, [{ field: 'Idempotency-Key', message: 'Повтори заказ — приложение не передало ключ идемпотентности' }]);
      } else if (typeof chartId !== 'string' || !UUID.test(chartId)) {
        sendInvalid(res, [{ field: 'chart_id', message: 'Выбери карту, по которой нужен разбор' }]);
      } else if (type !== 'full') {
        sendInvalid(res, [{ field: 'type', message: 'Пока собираю только полный разбор — совместимость и карту года сделаю позже' }]);
      } else if (chartId !== current?.chart.chart.chart_id) {
        sendProblem(res, 404, 'NOT_FOUND', 'Такой карты нет. Построй карту заново', { reason: 'chart_not_found' });
      } else {
        const known = reports.get(reportKeys.get(key) ?? '');
        const latest = [...reports.values()].filter((report) => report.chartId === chartId).pop();
        const latestStatus = latest && reportView(latest, now, false).status;
        if (known) {
          // The answer of apps/api to a key it knows carries no chapters and `is_paid: false`,
          // whatever is bought: what the report is like is the business of GET.
          send(res, 202, reportView(known, now, false));
        } else if (latest && latestStatus !== 'failed' && latestStatus !== 'refunded') {
          // A report of this chart is in work or done: a second order is that same report.
          send(res, 202, reportView(latest, now, paidCharts.size > 0));
        } else if (!paidCharts.has(chartId)) {
          sendProblem(res, 402, 'PAYMENT_REQUIRED', 'Полный разбор — отдельная покупка. Оформи её на экране разбора', {
            reason: 'report_not_paid',
          });
        } else {
          const report: MockReport = { id: randomUUID(), chartId, createdAt: now, scenario };
          reports.set(report.id, report);
          reportKeys.set(key, report.id);
          latestReportId = report.id;
          send(res, 202, reportView(report, now, true));
        }
      }
      return;
    }

    const reportOf = /^\/reports\/([^/]+)$/.exec(path);
    if (reportOf && req.method === 'GET') {
      const report = reports.get(reportOf[1] ?? '');
      if (report) send(res, 200, reportView(report, now, paidCharts.size > 0));
      else sendProblem(res, 404, 'NOT_FOUND', 'Такого разбора нет. Обнови приложение', { reason: 'report_not_found' });
      return;
    }

    if (route === 'GET /charts/current') {
      // No chart is not a failure: the app takes the 404 as «go to the onboarding». The body is the one apps/api sends.
      if (current) send(res, 200, { ...current.chart, is_restored: true });
      else sendProblem(res, 404, 'NOT_FOUND', MESSAGE.NOT_FOUND);
      return;
    }

    if (route === 'POST /geo/resolve') {
      const body = await readJson(req);
      const query = isRecord(body) && typeof body.query === 'string' ? body.query.trim() : '';
      const limit = isRecord(body) ? (body.limit ?? 5) : 5;
      const needle = query.toLowerCase();
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
        // Refused, not cut to the nearest bound. The app sends no `limit` at all.
        sendInvalid(res, [{ field: 'limit', message: 'limit — целое число от 1 до 10' }]);
      } else if (query.length < QUERY_LENGTH.min) {
        // 422, not an empty list: `[]` means «no such place», not «too little typed». The app never sends a query this short.
        sendInvalid(res, [{ field: 'query', message: 'Введи хотя бы 2 буквы' }]);
      } else if (query.length > QUERY_LENGTH.max) {
        sendInvalid(res, [{ field: 'query', message: 'Слишком длинный запрос — введи название города' }]);
      } else if (needle.startsWith('ошибка')) {
        sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      } else if (needle.startsWith('лимит')) {
        sendProblem(res, 429, 'RATE_LIMITED', MESSAGE.RATE_LIMITED);
      } else if (needle.startsWith('провайдер')) {
        // The reason is for machines; the app does not read it and shows `message`.
        sendProblem(res, 503, 'GEO_NOT_FOUND', MESSAGE.GEO_NOT_FOUND, { reason: 'provider_timeout' });
      } else {
        send(res, 200, findPlaces(query, limit));
      }
      return;
    }

    if (route === 'POST /events') {
      const answer = eventsAnswer(await readJson(req), Date.now());
      if ('accepted' in answer) {
        send(res, 202, answer);
        return;
      }
      const [first, ...rest] = answer.errors;
      if (first) sendInvalid(res, [first, ...rest]);
      return;
    }

    if (route === 'POST /charts') {
      const body = await readJson(req);
      const [first, ...rest] = chartRequestErrors(body, consentVersion);
      if (first) {
        sendInvalid(res, [first, ...rest]);
        return;
      }
      const input = body as ChartCreateRequest;
      const created = buildChart(input);
      switch (input.birth_place.name) {
        case SCENARIO.serverError:
          sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
          return;
        case SCENARIO.rejectedPlace:
          sendInvalid(res, [{ field: 'birth_place', message: 'Не знаем такой часовой пояс — выбери город заново' }]);
          return;
        case SCENARIO.rejectedDate:
          sendInvalid(res, [{ field: 'birth_date', message: 'Сервис доступен с 18 лет' }]);
          return;
        case SCENARIO.rejectedTime:
          sendInvalid(res, [{ field: 'birth_time', message: FIELD_MESSAGE.birth_time }]);
          return;
        case SCENARIO.rejectedConsent:
          sendInvalid(res, [{ field: 'consent', message: FIELD_MESSAGE.consent }]);
          return;
        case SCENARIO.outdatedConsent:
          // The texts changed on the server after this app was built. The mock has no newer build to give:
          // after its restart the app finds the same texts and says so.
          sendInvalid(res, [CONSENT_VERSION_REFUSED]);
          return;
        case SCENARIO.emptyChart:
          // On purpose less than the contract promises: shows what the screen does with an answer it cannot draw.
          send(res, 201, { chart: { ...created.chart, planets: [], asc: {}, houses: [] } });
          return;
        case SCENARIO.brokenWheel:
          send(res, 201, { ...created, wheel_url: '/api/v1/charts/unknown/wheel.svg?sig=broken' });
          return;
        default: {
          const key = inputKey(input);
          if (current?.key === key) {
            // The same birth data again: the chart that is already there, with 200 instead of 201.
            send(res, 200, { ...current.chart, is_restored: true });
            return;
          }
          current = { key, chart: created };
          send(res, 201, created);
          return;
        }
      }
    }

    sendProblem(res, 404, 'NOT_FOUND', MESSAGE.NOT_FOUND);
  };
}

/** The scenario switches a request to the reset route may name, as the query spells them. */
function scenarioFrom(query: URLSearchParams): Partial<MockApiOptions> {
  const chapterMs = Number(query.get('chapter_ms'));
  return {
    me: query.get('me') ?? undefined,
    report: query.get('report') ?? undefined,
    invoice: query.get('invoice') ?? undefined,
    deletion: query.get('delete') ?? undefined,
    pdf: query.get('pdf') === '1',
    ...(chapterMs > 0 && { reportChapterMs: chapterMs }),
  };
}

export function mockApi(options: MockApiOptions): Plugin {
  let handle = createHandler(options);
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      next();
      return;
    }
    if (url.pathname === `${PREFIX}/__mock/reset`) {
      // Not a part of the API: starts the mock over, with the user and the scenarios the query names
      // (`?me=paid&report=failed`), so that another state of a screen is one address away, not one restart.
      const scenario = { ...options, me: undefined, report: undefined, invoice: undefined, deletion: undefined, ...scenarioFrom(url.searchParams) };
      handle = createHandler(scenario);
      send(res, 200, { me: scenario.me ?? '', report: scenario.report ?? 'ready', invoice: scenario.invoice ?? '', delete: scenario.deletion ?? '', pdf: scenario.pdf });
      return;
    }
    handle(req, res, url).catch((error: unknown) => {
      // The app cancels requests it no longer needs (a newer search query, a screen that was left). Not a failure.
      if (req.destroyed) return;
      console.error('[mock-api]', error);
      if (!res.headersSent) sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      else res.end();
    });
  };

  return {
    name: 'astro-soul:mock-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
