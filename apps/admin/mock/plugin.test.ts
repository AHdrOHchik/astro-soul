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

/**
 * Тело входа, как его отдаёт виджет: `id`, свежий `auth_date` (окно сервера —
 * 300 с) и `hash`. Мокер повторяет ту же проверку, поэтому «устаревшая подпись»
 * воспроизводима в ДЕМО, а не только в бою: см. `auth_stale` ниже.
 */
function loginBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: '777001',
    first_name: 'Владелец',
    auth_date: Math.floor(Date.now() / 1000),
    hash: 'demo',
    ...overrides,
  });
}

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

  it('отказы входа воспроизводятся как на сервере: 401 с причиной, 403, 429 нет', async () => {
    // Смысл мока в том, что тексты входа проверяемы без живого бэкенда: если
    // мокер на `hash=bad` ответит 200, панель «чинит» отказ и QA его не увидит.
    const bad = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody({ hash: 'bad' }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { details?: { reason?: string } }).details?.reason).toBe('invalid_hash');

    const stale = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody({ auth_date: Math.floor(Date.now() / 1000) - 301 }),
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { details?: { reason?: string } }).details?.reason).toBe('auth_stale');

    const forbidden = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody({ id: '999999' }),
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { details?: { reason?: string } }).details?.reason).toBe('forbidden');
  });

  it('журнал аудита: страница по курсору, в конце — null', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody(),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';

    const first = await get('/api/v1/admin/audit?limit=2', { headers: { cookie } });
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(page.items.map((item) => item.id)).toEqual(['a-8', 'a-7']);
    expect(page.next_cursor).toBe('c2');

    const second = await get(`/api/v1/admin/audit?limit=2&cursor=${page.next_cursor ?? ''}`, { headers: { cookie } });
    const nextPage = (await second.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(nextPage.items.map((item) => item.id)).toEqual(['a-6', 'a-5']);
    // «Страниц по номеру» нет ни у мока, ни у сервера: незнакомый параметр
    // просто не на что опереться, и панель получает первую страницу.
    const paged = (await get('/api/v1/admin/audit?limit=2&page=2', { headers: { cookie } }).then((r) => r.json())) as { items: { id: string }[] };
    expect(paged.items.map((item) => item.id)).toEqual(['a-8', 'a-7']);

    const tail = await get('/api/v1/admin/audit?limit=50', { headers: { cookie } });
    const tailPage = (await tail.json()) as { items: unknown[]; next_cursor: string | null };
    expect(tailPage.next_cursor).toBeNull();
    expect(tailPage.items.length).toBe(6);
  });

  it('журнал: фильтры работают, кривые значения — 422 текстом сервера', async () => {
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody(),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';

    const byEntity = await get('/api/v1/admin/audit?entity=grant', { headers: { cookie } });
    const entityPage = (await byEntity.json()) as { items: { entity: string }[] };
    expect(entityPage.items.map((item) => item.entity)).toEqual(['grant', 'grant']);

    const byActor = await get('/api/v1/admin/audit?actor_tg_id=0', { headers: { cookie } });
    expect(((await byActor.json()) as { items: { action: string }[] }).items.map((item) => item.action)).toEqual(['session.purge']);

    const badLimit = await get('/api/v1/admin/audit?limit=201', { headers: { cookie } });
    expect(badLimit.status).toBe(422);
    expect(((await badLimit.json()) as { details?: { reason?: string } }).details?.reason).toBe('invalid_limit');

    const badCursor = await get('/api/v1/admin/audit?cursor=вторая', { headers: { cookie } });
    expect(badCursor.status).toBe(422);
    expect(((await badCursor.json()) as { details?: { reason?: string } }).details?.reason).toBe('invalid_cursor');

    const badActor = await get('/api/v1/admin/audit?actor_tg_id=abc', { headers: { cookie } });
    expect(badActor.status).toBe(422);
    expect(((await badActor.json()) as { details?: { reason?: string } }).details?.reason).toBe('invalid_actor_tg_id');
  });

  it('журнал закрыт без сессии, и вход/выход CSRF не требуют, а выход живой сессии — требует', async () => {
    expect((await get('/api/v1/admin/audit')).status).toBe(401);

    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody(),
    });
    const cookie = login.headers.getSetCookie()[0] ?? '';

    // Выход без заголовка из живой сессии — 403 csrf_missing, как у сервера.
    const sloppy = await get('/api/v1/admin/auth/logout', { method: 'POST', headers: { cookie } });
    expect(sloppy.status).toBe(403);
    expect(((await sloppy.json()) as { details?: { reason?: string } }).details?.reason).toBe('csrf_missing');

    const clean = await get('/api/v1/admin/auth/logout', {
      method: 'POST',
      headers: { cookie, 'X-Admin-CSRF': DEMO_CSRF },
    });
    expect(clean.status).toBe(200);
    expect(clean.headers.getSetCookie()[0] ?? '').toContain('Max-Age=0');
    // Идемпотентность: повтор без сессии — тоже 200, а не 401.
    expect((await get('/api/v1/admin/auth/logout', { method: 'POST', headers: { 'X-Admin-CSRF': DEMO_CSRF } })).status).toBe(200);
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
      body: loginBody(),
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
      body: loginBody(),
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
      body: loginBody(),
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
      body: loginBody(),
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
      body: loginBody(),
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
      body: loginBody(),
    });

    const reply = await get('/api/v1/admin/what/ever', { headers: { cookie: login.headers.getSetCookie()[0] ?? '' } });
    expect(reply.status).toBe(404);
    expect(await reply.text()).toContain('/api/v1/admin/what/ever');
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

// Отдельный describe со СВОИМ экземпляром мокера: правки тарифов, бан и возврат
// меняют состояние замыкания, и делить его с тестами выше — значит сделать
// прогон зависимым от порядка.
describe('dev-мокер: тарифы и пользователи', () => {
  let mock: Handles;
  let cookie = '';

  const get = (path: string, init?: RequestInit) => fetch(mock.origin + path, init);
  const send = (method: 'PATCH' | 'POST', path: string, body: unknown, withCsrf = true) =>
    get(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        cookie,
        ...(withCsrf ? { 'X-Admin-CSRF': DEMO_CSRF } : {}),
      },
      body: JSON.stringify(body),
    });
  const patchPlan = (body: unknown, withCsrf = true) => send('PATCH', '/api/v1/admin/plans/month_399', body, withCsrf);

  beforeAll(async () => {
    mock = await serveMock(null);
    const login = await get('/api/v1/admin/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: loginBody(),
    });
    cookie = login.headers.getSetCookie()[0] ?? '';
  });

  afterAll(async () => {
    await mock.close();
  });

  it('каталог тарифов отдаётся и включает запертый founder_month', async () => {
    const reply = await get('/api/v1/admin/plans', { headers: { cookie } });
    const body = (await reply.json()) as { items: { code: string; founder_only: boolean }[] };

    expect(reply.status).toBe(200);
    expect(body.items.map((item) => item.code)).toContain('month_399');
    expect(body.items.find((item) => item.code === 'founder_month')?.founder_only).toBe(true);
  });

  it('PATCH: без CSRF 403, без comment 422, с чужой версией 409 price_changed', async () => {
    const noCsrf = await patchPlan({ price_stars: 349, comment: 'акция', base_version: 7 }, false);
    expect(noCsrf.status).toBe(403);

    const noComment = await patchPlan({ price_stars: 349, base_version: 7 });
    expect(noComment.status).toBe(422);
    expect(JSON.stringify(await noComment.json())).toContain('comment');

    const conflict = await patchPlan({ price_stars: 349, comment: 'акция', base_version: 6 });
    expect(conflict.status).toBe(409);
    const problem = (await conflict.json()) as { details?: { reason?: string } };
    expect(problem.details?.reason).toBe('price_changed');
  });

  it('PATCH с правильной версией меняет цену и пишет историю со снимком имени', async () => {
    const okReply = await patchPlan({ price_stars: 349, comment: 'акция выходного дня', base_version: 7 });
    expect(okReply.status).toBe(200);
    const result = (await okReply.json()) as { plan: { version: number; updated_by_name: string | null } };
    expect(result.plan.version).toBe(8);
    expect(result.plan.updated_by_name).toContain('ДЕМО');

    const history = await get('/api/v1/admin/plans/month_399/history', { headers: { cookie } });
    const rows = (await history.json()) as { items: { from_price: number | null; to_price: number; actor_name: string; comment: string }[] };
    expect(rows.items[0]?.from_price).toBe(399);
    expect(rows.items[0]?.to_price).toBe(349);
    // Снимок имени на момент действия — колонка «кто менял» не ходит в `users`.
    expect(rows.items[0]?.actor_name).toContain('ДЕМО');
    expect(rows.items[0]?.comment).toBe('акция выходного дня');
  });

  it('founder_month не редактируется даже с корректным телом', async () => {
    const reply = await send('PATCH', '/api/v1/admin/plans/founder_month', { price_stars: 250, comment: 'по просьбе', base_version: 2 });
    expect(reply.status).toBe(403);
    expect(JSON.stringify(await reply.json())).toContain('founder_plan_locked');
  });

  it('поиск принимает ровно один параметр; два — 422, как на сервере', async () => {
    const two = await get(`/api/v1/admin/users?telegram_id=777003&alias=anna_chart`, { headers: { cookie } });
    expect(two.status).toBe(422);

    const none = await get('/api/v1/admin/users', { headers: { cookie } });
    expect(none.status).toBe(422);

    const byAlias = await get('/api/v1/admin/users?alias=%40anna_chart', { headers: { cookie } });
    const rows = (await byAlias.json()) as { items: { tg_id: string }[] };
    expect(byAlias.status).toBe(200);
    expect(rows.items.map((item) => item.tg_id)).toEqual(['777003']);
  });

  it('возврат только полный: без основания 422; сумма серверная; повтор — 409', async () => {
    const cardReply = await get(`/api/v1/admin/users/${DEMO_USER_ID}`, { headers: { cookie } });
    const card = (await cardReply.json()) as { refundable: { amount_stars: number } | null };
    expect(card.refundable?.amount_stars).toBe(399);

    const noReason = await send('POST', `/api/v1/admin/users/${DEMO_USER_ID}/refund`, {});
    expect(noReason.status).toBe(422);

    const okReply = await send('POST', `/api/v1/admin/users/${DEMO_USER_ID}/refund`, { reason: 'возврат по обращению 4211' });
    const result = (await okReply.json()) as { amount_stars: number; currency: string; status: string };
    expect(okReply.status).toBe(200);
    // Тела ответа без поля суммы на вход — сервер сам решает, сколько: здесь это 399 ⭐ XTR.
    expect(result).toMatchObject({ amount_stars: 399, currency: 'XTR', status: 'refunded' });

    const again = await send('POST', `/api/v1/admin/users/${DEMO_USER_ID}/refund`, { reason: 'ещё раз' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(await again.json())).toContain('nothing_to_refund');
  });

  it('бан переключается с обязательным основанием; пуш — флажем', async () => {
    const banned = await send('POST', `/api/v1/admin/users/2b1f7a04-9d3c-4e21-8a55-000000000003/ban`, { reason: 'спам в промптах' });
    expect((await banned.json())).toMatchObject({ banned: true });

    const card = (await (await get('/api/v1/admin/users/2b1f7a04-9d3c-4e21-8a55-000000000003', { headers: { cookie } })).json()) as { ban_reason: string | null };
    expect(card.ban_reason).toBe('спам в промптах');

    const noReason = await send('POST', `/api/v1/admin/users/2b1f7a04-9d3c-4e21-8a55-000000000003/ban`, {});
    expect(noReason.status).toBe(422);

    const push = await send('POST', `/api/v1/admin/users/2b1f7a04-9d3c-4e21-8a55-000000000003/push`, { enabled: false });
    expect((await push.json())).toMatchObject({ push_enabled: false });
  });
});
