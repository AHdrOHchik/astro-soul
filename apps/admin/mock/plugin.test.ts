/*
 * Проверка самого мокера. Он dev-only, но враньё в нём стоит дороже, чем враньё
 * в продукте: на него смотрят человек и QA, решая, готов ли интерфейс. Поэтому
 * проверяется не «данные красивые», а три вещи:
 *
 *   1. публичные маршруты НЕ подменяются (при недоступном API — 502, а не
 *      нарисованный `/health`);
 *   2. живая сессия важнее мока (если `/admin/me` отвечает — весь `/admin/*`
 *      проксируется наверх, фикстуры не отдаются);
 *   3. отказы воспроизводятся как на сервере: 401 без сессии, 403 без CSRF,
 *      422 без `user_id`, 404 на повторный отзыв.
 *
 * Тест идёт через настоящий `node:http`: мокер — это connect-middleware, и
 * дергать его руками, имитируя `req`/`res`, значило бы проверывать свою
 * имитацию, а не его.
 */

// @vitest-environment node

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminMockApi } from './plugin';
import { DEMO_CSRF, DEMO_USER_ID, MOCK_MARKER } from './fixtures';

interface Handles {
  readonly origin: string;
  readonly handled: () => number;
  close: () => Promise<void>;
}

/**
 * Поднимает мокер на реальном порту. `upstream` — то, что панель считает живым
 * API; если сервер не поднят, `/admin/me` не отвечает, и мокер включает режим
 * `mock`. Счётчик `handled` нужен, чтобы отличить «ответил мокер» от
 * «next() — обработал не он».
 */
async function serveMock(upstream: string | null): Promise<Handles> {
  const plugin = adminMockApi({ upstream: upstream ?? 'http://127.0.0.1:1', delayMs: 0 });
  const configure = (plugin as unknown as { configureServer: (server: unknown) => void }).configureServer;

  // Список, а не переменная: `configureServer` регистрирует middleware синхронно,
  // и «пусто» после вызова означает, что мокер вообще не подключился.
  const handlers: ((req: never, res: never, next: () => void) => void)[] = [];
  configure({ middlewares: { use: (fn: (req: never, res: never, next: () => void) => void) => { handlers.push(fn); } } });
  const handler = handlers[0];
  if (handler === undefined) throw new Error('мокер не зарегистрировал middleware');

  let handled = 0;
  const server: Server = createServer((req, res) => {
    handler(req as never, res as never, () => {
      handled += 1;
      res.writeHead(418, { 'Content-Type': 'text/plain' });
      res.end('handled by vite, not by the mock');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    handled: () => handled,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

async function serveUpstream(status: number, marker: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/problem+json', 'X-Upstream': marker });
    res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: marker, request_id: 'upstream' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

describe('dev-мокер', () => {
  let mock: Handles;

  beforeAll(async () => {
    mock = await serveMock(null);
  });

  afterAll(async () => {
    await mock.close();
  });

  const get = (path: string, init?: RequestInit) => fetch(mock.origin + path, init);

  it('публичные маршруты не подменяются: недоступный API = 502, не фикстура', async () => {
    const reply = await get('/api/v1/health');

    expect(reply.status).toBe(502);
    expect(await reply.text()).toContain('API не отвечает');
    expect(reply.headers.get('X-Admin-Demo')).toBeNull();
    expect(mock.handled()).toBe(0);
  });

  it('до входа приватные маршруты закрыты и моком тоже', async () => {
    const reply = await get('/api/v1/admin/metrics');

    expect(reply.status).toBe(401);
    expect(reply.headers.get('X-Admin-Demo')).toBe('1');
  });

  it('вход по неполному набору полей отклоняется 422 с field_errors', async () => {
    const reply = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1' }),
    });

    expect(reply.status).toBe(422);
    const body = (await reply.json()) as { details?: { field_errors?: { field: string }[] } };
    expect(body.details?.field_errors?.map((item) => item.field)).toEqual(['auth_date', 'hash']);
  });

  it('вход выдаёт cookie, `/admin/me` отдаёт профиль с CSRF и маркером мока', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1', auth_date: 1, hash: 'h' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0] ?? '';
    expect(cookie).toContain('admin_session=mock');

    const me = await get('/api/v1/admin/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ csrf_token: DEMO_CSRF });
    expect(body.note).toBe(MOCK_MARKER);
  });

  it('POST без CSRF-токена мока не принимает — как и настоящий бэкенд', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1', auth_date: 1, hash: 'h' }),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';

    const forbidden = await get('/api/v1/admin/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ kind: 'single_report', max_activations: 1 }),
    });
    expect(forbidden.status).toBe(403);

    const created = await get('/api/v1/admin/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'X-Admin-CSRF': DEMO_CSRF },
      body: JSON.stringify({ kind: 'single_report', max_activations: 1 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'single_report', max_activations: 1, activations: 0 });
    expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('`all_access` без дней — 422: мокер не мягче сервера', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1', auth_date: 1, hash: 'h' }),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';

    const reply = await get('/api/v1/admin/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'X-Admin-CSRF': DEMO_CSRF },
      body: JSON.stringify({ kind: 'all_access', max_activations: 1 }),
    });
    expect(reply.status).toBe(422);
  });

  it('гранты: без user_id — 422, чужой user_id — пустой список, своего — непустой', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1', auth_date: 1, hash: 'h' }),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';

    const noUser = await get('/api/v1/admin/grants', { headers: { cookie } });
    expect(noUser.status).toBe(422);

    const other = await get(`/api/v1/admin/grants?user_id=00000000-0000-4000-8000-000000000009`, { headers: { cookie } });
    expect(((await other.json()) as { items: unknown[] }).items).toHaveLength(0);

    const mine = await get(`/api/v1/admin/grants?user_id=${DEMO_USER_ID}`, { headers: { cookie } });
    const { items } = (await mine.json()) as { items: { id: string; revoked: boolean }[] };
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.revoked)).toBe(true);
  });

  it('отзыв работает один раз: повтор — 404, как у сервера', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1', auth_date: 1, hash: 'h' }),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';
    const list = await get(`/api/v1/admin/grants?user_id=${DEMO_USER_ID}`, { headers: { cookie } });
    const { items } = (await list.json()) as { items: { id: string; revoked: boolean }[] };
    const target = items.find((item) => !item.revoked);
    if (!target) throw new Error('в фикстурах нет неотозванного права');

    const request = (): Promise<Response> =>
      get('/api/v1/admin/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie, 'X-Admin-CSRF': DEMO_CSRF },
        body: JSON.stringify({ user_id: DEMO_USER_ID, kind: 'all_access', action: 'revoke', grant_id: target.id }),
      });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(404);
  });

  it('неизвестный моку маршрут — 404 с именем маршрута, а не фикстура', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '1', auth_date: 1, hash: 'h' }),
    });

    const reply = await get('/api/v1/admin/plans', { headers: { cookie: login.headers.getSetCookie()[0] ?? '' } });
    expect(reply.status).toBe(404);
    expect(await reply.text()).toContain('/api/v1/admin/plans');
  });

  it('не /api/* мокер не трогает — отдаёт next()', async () => {
    const reply = await get('/assets/app.js');
    expect(reply.status).toBe(418);
  });
});

describe('dev-мокер рядом с живым API', () => {
  it('если /admin/me отвечает не 404 — фикстур нет, запрос идёт наверх', async () => {
    const upstream = await serveUpstream(401, 'upstream-says-no');
    const live = await serveMock(upstream.origin);

    try {
      const reply = await fetch(`${live.origin}/api/v1/admin/metrics`);

      expect(reply.status).toBe(401);
      const text = await reply.text();
      // Тело пришло с апстрима (мокер поместил в `message` свою метку).
      expect(text).toContain('upstream-says-no');
      // Ни следа подмены: ни демо-заголовка, ни маркера фикстур.
      expect(reply.headers.get('X-Admin-Demo')).toBeNull();
      expect(text).not.toContain(MOCK_MARKER);
    } finally {
      await live.close();
      await upstream.close();
    }
  });

  it('публичный /health идёт наверх и при живом, и при мёртвом API', async () => {
    const upstream = await serveUpstream(200, 'upstream-health');
    const live = await serveMock(upstream.origin);

    try {
      const reply = await fetch(`${live.origin}/api/v1/health`);
      expect(await reply.text()).toContain('upstream-health');
      expect(live.handled()).toBe(0);
    } finally {
      await live.close();
      await upstream.close();
    }
  });
});
