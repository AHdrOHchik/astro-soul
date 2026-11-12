/*
 * Dev-only stand-in for the backend (apps/api is owned by BACKEND and is not
 * part of this package). Enabled with API_MOCK=1 for `vite` and `vite preview`;
 * it is never part of the production bundle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import type { ChartCreateRequest, ChartResponse, EventsAccepted, FieldError, Problem } from './fixtures.ts';
import { renderMockWheel } from './wheel.ts';
import { PNG_SIZES, renderMockWheelPng } from './wheelPng.ts';

export interface MockApiOptions {
  /** Artificial latency, so loading states can be seen. */
  delayMs: number;
  /**
   * Scenario for GET /me: `401`, `500`, or `returning`, a user who already has a chart.
   * Anything else is a new user. Either way the mock remembers the chart built last,
   * until it is restarted.
   */
  me?: string;
  /**
   * The version of the legal texts this "server" accepts in `consent.version`; any other is refused.
   * By default MOCK_CONSENT_VERSION, the one of the app's own texts. Another value plays a server
   * whose texts are newer than the app's.
   */
  consentVersion?: string;
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
 * The user-facing texts of the mock are the ones apps/api sends at contract 1.4.0
 * (i18n/ru.ts, modules/charts/charts.dto.ts, modules/geo/geo.service.ts,
 * modules/events/events.dto.ts), so a screen looks in the mock the way it will
 * with the real server.
 */
const MESSAGE = {
  UNAUTHORIZED: 'Не удалось подтвердить вход. Открой приложение заново из чата с ботом.',
  FORBIDDEN: 'Это действие тебе недоступно.',
  NOT_FOUND: 'Такой страницы нет. Обнови приложение.',
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
  'events.at': 'Время события — ISO 8601 с часовым поясом',
  'events.props': 'Свойства события — короткие строки, числа или флаги',
} as const;

type EventField = keyof typeof EVENT_MESSAGE;

const isEventProp = (value: unknown) =>
  (typeof value === 'string' && value.length <= EVENTS.maxPropLength) || typeof value === 'number' || typeof value === 'boolean';

/** What is wrong with the shape of one event; undefined for an event the server would parse. */
function eventShapeError(event: unknown): EventField | undefined {
  if (!isRecord(event)) return 'events';
  if (typeof event.name !== 'string' || !Object.hasOwn(EVENT_NAMES, event.name)) return 'events.name';
  if (typeof event.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(event.at) || Number.isNaN(Date.parse(event.at))) {
    return 'events.at';
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

  const accepted = (events as { at: string; props?: Record<string, unknown> }[]).filter((event) => {
    const forbidden: readonly string[] = EVENTS.forbiddenProps;
    if (Object.keys(event.props ?? {}).some((key) => forbidden.includes(key))) return false;
    const at = Date.parse(event.at);
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

function createHandler({ delayMs, me: meScenario, consentVersion = MOCK_CONSENT_VERSION }: MockApiOptions) {
  // All the mock keeps between requests: the user's chart and the birth data it was built from.
  let current: { key: string; chart: ChartResponse } | null =
    meScenario === 'returning' ? { key: inputKey(RETURNING_INPUT), chart: buildChart(RETURNING_INPUT) } : null;

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method ?? 'GET'} ${url.pathname.slice(PREFIX.length)}`;
    await sleep(delayMs);

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

    if (route === 'GET /me') {
      if (meScenario === '401') sendProblem(res, 401, 'UNAUTHORIZED', MESSAGE.UNAUTHORIZED);
      else if (meScenario === '500') sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      else send(res, 200, buildMe(current?.chart.chart.chart_id ?? null));
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

export function mockApi(options: MockApiOptions): Plugin {
  const handle = createHandler(options);
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      next();
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
