/*
 * Dev-only stand-in for the backend (apps/api is owned by BACKEND and is not
 * part of this package). Enabled with API_MOCK=1 for `vite` and `vite preview`;
 * it is never part of the production bundle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { buildChart, findPlaces, me, MOCK_CHART_ID, problem, SCENARIO } from './fixtures.ts';
import type { ChartCreateRequest, FieldError, Problem } from './fixtures.ts';
import { renderMockWheel } from './wheel.ts';

export interface MockApiOptions {
  /** Artificial latency, so loading states can be seen. */
  delayMs: number;
  /** Scenario for GET /me: `returning`, `401`, `500`; anything else is a new user. */
  me?: string;
}

const PREFIX = '/api/v1';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
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
 * The user-facing texts of the mock are the ones apps/api sends at contract 1.2.1
 * (i18n/ru.ts, modules/charts/charts.dto.ts, modules/geo/geo.service.ts), so a
 * screen looks in the mock the way it will with the real server.
 */
const MESSAGE = {
  UNAUTHORIZED: 'Не удалось подтвердить вход. Открой приложение заново из чата с ботом.',
  FORBIDDEN: 'Это действие тебе недоступно.',
  NOT_FOUND: 'Такой страницы нет. Обнови приложение.',
  RATE_LIMITED: 'Слишком много запросов. Попробуй через минуту.',
  INTERNAL: 'Что-то сломалось на нашей стороне. Мы уже разбираемся.',
  GEO_NOT_FOUND: 'Геоданные сейчас недоступны. Попробуй позже или введи координаты вручную.',
} as const satisfies Partial<Record<Problem['code'], string>>;

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

/** The fields of a `POST /charts` body the server would reject, in the order of the form. Empty for a body it accepts. */
function chartRequestErrors(body: unknown): FieldError[] {
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

  if (body.time_precision === 'unknown' && timeGiven) {
    return [{ field: 'birth_time', message: 'Если время неизвестно, оставь это поле пустым' }];
  }
  if (body.time_precision !== 'unknown' && !timeGiven) {
    return [{ field: 'birth_time', message: 'Укажи время рождения или отметь, что не знаешь' }];
  }
  return [];
}

function createHandler({ delayMs, me: meScenario }: MockApiOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method ?? 'GET'} ${url.pathname.slice(PREFIX.length)}`;
    await sleep(delayMs);

    if (route === `GET /charts/${MOCK_CHART_ID}/wheel.svg`) {
      // Public by signed token: no initData here, see the contract.
      if (!url.searchParams.get('sig')) {
        sendProblem(res, 403, 'FORBIDDEN', MESSAGE.FORBIDDEN);
        return;
      }
      send(res, 200, renderMockWheel(url.searchParams.get('theme') === 'light' ? 'light' : 'dark'), 'image/svg+xml');
      return;
    }

    if (!req.headers['x-telegram-init-data']) {
      sendProblem(res, 401, 'UNAUTHORIZED', MESSAGE.UNAUTHORIZED);
      return;
    }

    if (route === 'GET /me') {
      if (meScenario === '401') sendProblem(res, 401, 'UNAUTHORIZED', MESSAGE.UNAUTHORIZED);
      else if (meScenario === '500') sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      else send(res, 200, meScenario === 'returning' ? { ...me, is_new: false, has_profile: true, has_chart: true } : me);
      return;
    }

    if (route === 'POST /geo/resolve') {
      const body = await readJson(req);
      const query = isRecord(body) && typeof body.query === 'string' ? body.query.trim() : '';
      const limit = isRecord(body) && typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 10) : 5;
      const needle = query.toLowerCase();
      if (query.length === 0) {
        sendInvalid(res, [{ field: 'query', message: 'Начни вводить название города' }]);
      } else if (query.length > 120) {
        sendInvalid(res, [{ field: 'query', message: 'Слишком длинный запрос — введи название города' }]);
      } else if (query.length < 3) {
        // What apps/api answers to one or two characters: an empty list. The schema of the contract
        // (`minLength: 3`) asks for 422 here: issue #8. The app never sends a query this short.
        send(res, 200, []);
      } else if (needle.startsWith('ошибка')) {
        sendProblem(res, 500, 'INTERNAL', MESSAGE.INTERNAL);
      } else if (needle.startsWith('лимит')) {
        sendProblem(res, 429, 'RATE_LIMITED', MESSAGE.RATE_LIMITED);
      } else if (needle.startsWith('провайдер')) {
        // No `details`: the contract names `details.reason`, apps/api fills `details.provider` (issue #8).
        // The app reads neither.
        sendProblem(res, 503, 'GEO_NOT_FOUND', MESSAGE.GEO_NOT_FOUND);
      } else {
        send(res, 200, findPlaces(query, limit));
      }
      return;
    }

    if (route === 'POST /charts') {
      const body = await readJson(req);
      const [first, ...rest] = chartRequestErrors(body);
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
        case SCENARIO.emptyChart:
          // On purpose less than the contract promises: shows what the screen does with an answer it cannot draw.
          send(res, 201, { chart: { ...created.chart, planets: [], asc: {}, houses: [] } });
          return;
        case SCENARIO.brokenWheel:
          send(res, 201, { ...created, wheel_url: '/api/v1/charts/unknown/wheel.svg?sig=broken' });
          return;
        default:
          send(res, 201, created);
          return;
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
