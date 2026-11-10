/*
 * Dev-only stand-in for the backend (apps/api is owned by BACKEND and is not
 * part of this package). Enabled with API_MOCK=1 for `vite` and `vite preview`;
 * it is never part of the production bundle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { buildChart, findPlaces, me, MOCK_CHART_ID, problem, SCENARIO } from './fixtures.ts';
import type { ChartCreateRequest, Problem } from './fixtures.ts';
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

function sendProblem(res: ServerResponse, status: number, code: Problem['code'], message: string): void {
  send(res, status, problem(code, message), 'application/problem+json');
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

function isChartRequest(body: unknown): body is ChartCreateRequest {
  if (!isRecord(body) || !isRecord(body.birth_place)) return false;
  const time = body.birth_time;
  return (
    typeof body.birth_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.birth_date) &&
    (time === undefined || time === null || (typeof time === 'string' && /^\d{2}:\d{2}$/.test(time))) &&
    typeof body.birth_place.name === 'string' &&
    typeof body.birth_place.tz === 'string'
  );
}

function createHandler({ delayMs, me: meScenario }: MockApiOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method ?? 'GET'} ${url.pathname.slice(PREFIX.length)}`;
    await sleep(delayMs);

    if (route === `GET /charts/${MOCK_CHART_ID}/wheel.svg`) {
      // Public by signed token: no initData here, see the contract.
      if (!url.searchParams.get('sig')) {
        sendProblem(res, 403, 'FORBIDDEN', 'Ссылка на колесо недействительна.');
        return;
      }
      send(res, 200, renderMockWheel(url.searchParams.get('theme') === 'light' ? 'light' : 'dark'), 'image/svg+xml');
      return;
    }

    if (!req.headers['x-telegram-init-data']) {
      sendProblem(res, 401, 'UNAUTHORIZED', 'Не получилось подтвердить вход через Telegram.');
      return;
    }

    if (route === 'GET /me') {
      if (meScenario === '401') sendProblem(res, 401, 'UNAUTHORIZED', 'Данные входа устарели. Открой приложение заново.');
      else if (meScenario === '500') sendProblem(res, 500, 'INTERNAL', 'Сервис временно недоступен. Попробуй позже.');
      else send(res, 200, meScenario === 'returning' ? { ...me, is_new: false, has_profile: true, has_chart: true } : me);
      return;
    }

    if (route === 'POST /geo/resolve') {
      const body = await readJson(req);
      const query = isRecord(body) && typeof body.query === 'string' ? body.query.trim() : '';
      const limit = isRecord(body) && typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 10) : 5;
      const needle = query.toLowerCase();
      if (query.length < 2 || query.length > 120) {
        sendProblem(res, 422, 'VALIDATION_FAILED', 'Запрос должен быть длиной от 2 до 120 символов.');
      } else if (needle.startsWith('ошибка')) {
        sendProblem(res, 500, 'INTERNAL', 'Поиск мест временно недоступен. Попробуй позже.');
      } else if (needle.startsWith('лимит')) {
        sendProblem(res, 429, 'RATE_LIMITED', 'Слишком много запросов. Подожди минуту.');
      } else {
        const places = findPlaces(query, limit);
        if (places.length === 0) sendProblem(res, 404, 'GEO_NOT_FOUND', 'Такое место не нашлось.');
        else send(res, 200, places);
      }
      return;
    }

    if (route === 'POST /charts') {
      const body = await readJson(req);
      if (!isChartRequest(body)) {
        sendProblem(res, 422, 'VALIDATION_FAILED', 'Проверь дату, время и место рождения.');
        return;
      }
      const created = buildChart(body);
      switch (body.birth_place.name) {
        case SCENARIO.serverError:
          sendProblem(res, 500, 'INTERNAL', 'Не получилось построить карту. Попробуй ещё раз.');
          return;
        case SCENARIO.rejected:
          sendProblem(res, 422, 'VALIDATION_FAILED', 'Для этого места не удалось определить часовой пояс. Выбери другое.');
          return;
        case SCENARIO.emptyChart:
          send(res, 201, { chart: { ...created.chart, planets: [], asc: {}, houses: [] } });
          return;
        case SCENARIO.brokenWheel:
          send(res, 201, { ...created, wheel_url: 'charts/unknown/wheel.svg?sig=broken' });
          return;
        default:
          send(res, 201, created);
          return;
      }
    }

    sendProblem(res, 404, 'NOT_FOUND', 'Мок не знает такого адреса.');
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
      if (!res.headersSent) sendProblem(res, 500, 'INTERNAL', 'Мок сломался, подробности в консоли dev-сервера.');
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
