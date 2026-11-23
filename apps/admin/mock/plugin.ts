/*
 * Dev-мокер API админ-панели. Работает только в `vite serve` и только при
 * `API_MOCK=1`; `vite build` с этой переменной падает в самом конфиге.
 *
 * Три правила, из-за которых мокер не опасен:
 *
 *   1. Публичные маршруты (`/health`, `/founders/count`) не мокуются никогда:
 *      они ходят в настоящий API. Если API не запущен, панель получит честную
 *      ошибку сети, а не красивую картинку.
 *   2. Мокер молчит, пока живой бэкенд отвечает на `GET /api/v1/admin/me`
 *      (любой ответ, кроме 404, — «механизм сессий есть»): тогда весь
 *      `/admin/*` проксируется наверх. Подмена допускается ровно в двух
 *      случаях: API не отвечает вовсе, или `/admin/me` отвечает 404 — входа нет.
 *      Тихого отката на мок при 401 не существует: 401 проксируется как есть.
 *   3. Каждый ответ мокера помечен `X-Admin-Demo: 1`, а его тело содержит
 *      маркер `MOCK_MARKER`; `scripts/check-no-mock.mjs` ищет маркер в `dist`.
 *
 * Мокер намеренно воспроизводит и отказы: 401 без сессии, 403 без CSRF-токена,
 * 422 без `user_id`, 404 на отзыве несуществующего права. Иначе «состояния
 * ошибок» в интерфейсе остались бы непроверенными.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginOption } from 'vite';
import {
  DEMO_CSRF,
  DEMO_USER_ID,
  mockAlerts,
  mockCodes,
  mockGrants,
  mockMe,
  mockMetrics,
  MOCK_MARKER,
  nowIso,
  type MockAccessCode,
  type MockGrant,
} from './fixtures.ts';

export interface MockOptions {
  /** Куда проксируются живые запросы: `API_PROXY_TARGET` или `http://localhost:8080`. */
  readonly upstream: string;
  readonly delayMs?: number;
}

/** Публичные маршруты не мокуются никогда — они и без сессии настоящие. */
const PUBLIC_PATHS: readonly string[] = ['/api/v1/health', '/api/v1/founders/count'];

const DAY = 86_400_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type Mode = 'unknown' | 'live' | 'mock';

interface Ctx {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
  readonly cookie: string;
  readonly csrf: string | null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function problem(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  details?: unknown,
): void {
  json(res, status, { code, message, request_id: 'mock', ...(details === undefined ? {} : { details }) }, {
    'Content-Type': 'application/problem+json; charset=utf-8',
    ...headers,
  });
}

function randomCode(): string {
  let out = '';
  for (let index = 0; index < 8; index += 1) {
    out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return out;
}

function randomUuid(seed: number): string {
  return `f00d0000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function adminMockApi(options: MockOptions): PluginOption {
  const upstream = options.upstream.replace(/\/+$/, '');
  const delay = options.delayMs ?? 0;

  let mode: Mode = 'unknown';
  let codes: readonly MockAccessCode[] = mockCodes;
  let grants: readonly MockGrant[] = mockGrants;
  let issued = 0;

  async function resolveMode(): Promise<Mode> {
    if (mode !== 'unknown') return mode;
    try {
      const response = await fetch(`${upstream}/api/v1/admin/me`, { method: 'GET', redirect: 'manual' });
      mode = response.status === 404 ? 'mock' : 'live';
    } catch {
      mode = 'mock';
    }
    process.stderr.write(`[admin-mock] режим: ${mode} (upstream ${upstream})\n`);
    return mode;
  }

  async function forward(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && key !== 'host' && key !== 'connection' && key !== 'content-length') headers[key] = value;
      }
      const response = await fetch(upstream + (req.url ?? '/'), {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw,
        redirect: 'manual',
      });
      const body = Buffer.from(await response.arrayBuffer());
      const out: Record<string, string | string[]> = {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
      };
      const setCookie = response.headers.getSetCookie();
      if (setCookie.length > 0) out['Set-Cookie'] = setCookie;
      res.writeHead(response.status, out);
      res.end(body);
    } catch (error) {
      // Живого API нет — и мок-данных здесь не будет: настоящая ошибка сети.
      problem(res, 502, 'INTERNAL', `API не отвечает (${upstream}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function hasSession(cookie: string): boolean {
    return /(?:^|;\s*)admin_session=mock\b/.test(cookie);
  }

  function handle(pathname: string, ctx: Ctx, res: ServerResponse): void {
    const demo = { 'X-Admin-Demo': '1' };

    if (ctx.method === 'POST' && pathname === '/api/v1/admin/auth/telegram') {
      const body = asRecord(ctx.body);
      const missing = ['id', 'auth_date', 'hash'].filter((key) => body[key] === undefined);
      if (missing.length > 0) {
        problem(res, 422, 'VALIDATION_FAILED', 'Виджет вернул неполный набор полей.', demo, {
          field_errors: missing.map((field) => ({ field, message: 'Подпись виджета не полная' })),
          mock: MOCK_MARKER,
        });
        return;
      }
      json(res, 200, { ok: true, note: MOCK_MARKER }, { ...demo, 'Set-Cookie': 'admin_session=mock; Path=/; SameSite=Lax' });
      return;
    }

    if (ctx.method === 'POST' && pathname === '/api/v1/admin/auth/logout') {
      json(res, 200, { ok: true }, { ...demo, 'Set-Cookie': 'admin_session=; Path=/; Max-Age=0' });
      return;
    }

    if (pathname === '/api/v1/admin/me') {
      if (!hasSession(ctx.cookie)) {
        problem(res, 401, 'UNAUTHORIZED', 'Сессии нет: войди через Telegram.', demo);
        return;
      }
      json(res, 200, { ...mockMe, note: MOCK_MARKER }, demo);
      return;
    }

    if (!hasSession(ctx.cookie)) {
      problem(res, 401, 'UNAUTHORIZED', 'Сессии нет: войди через Telegram.', demo);
      return;
    }

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/metrics') {
      json(res, 200, { ...mockMetrics, note: MOCK_MARKER }, demo);
      return;
    }

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/alerts') {
      json(res, 200, { ...mockAlerts, note: MOCK_MARKER }, demo);
      return;
    }

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/codes') {
      json(res, 200, { items: codes }, demo);
      return;
    }

    if (ctx.method === 'POST' && pathname === '/api/v1/admin/codes') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF: панель обязана слать токен на каждом POST.', demo, {
          reason: 'csrf_missing',
        });
        return;
      }

      const body = asRecord(ctx.body);
      const kind = body.kind;
      const days = typeof body.days === 'number' ? body.days : null;
      const maxActivations = body.max_activations;
      const errors: { field: string; message: string }[] = [];

      if (kind !== 'all_access' && kind !== 'single_report' && kind !== 'single_compat') {
        errors.push({ field: 'kind', message: 'Неизвестное право' });
      }
      if (typeof maxActivations !== 'number' || !Number.isInteger(maxActivations) || maxActivations < 1) {
        errors.push({ field: 'max_activations', message: 'Нужно целое ≥ 1' });
      }
      if (kind === 'all_access' && (days === null || days < 1 || days > 3650)) {
        errors.push({ field: 'days', message: 'Для all_access дни обязательны: 1..3650' });
      }
      if (errors.length > 0) {
        problem(res, 422, 'VALIDATION_FAILED', 'Код не создан.', demo, { field_errors: errors });
        return;
      }

      issued += 1;
      const created: MockAccessCode = {
        id: randomUuid(issued),
        code: randomCode(),
        kind: kind as MockAccessCode['kind'],
        days,
        max_activations: maxActivations as number,
        activations: 0,
        partner_name: typeof body.partner_name === 'string' ? body.partner_name : null,
        is_active: true,
        expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
        created_at: nowIso(0),
      };
      codes = [created, ...codes];
      json(res, 201, created, demo);
      return;
    }

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/grants') {
      const userId = ctx.url.searchParams.get('user_id');
      if (userId === null || userId.trim() === '') {
        problem(res, 422, 'VALIDATION_FAILED', 'Укажи user_id', demo, {
          field_errors: [{ field: 'user_id', message: 'Список без пользователя — это выгрузка базы' }],
        });
        return;
      }
      json(res, 200, { items: grants.filter((item) => item.user_id === userId) }, demo);
      return;
    }

    if (ctx.method === 'POST' && pathname === '/api/v1/admin/grants') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF: панель обязана слать токен на каждом POST.', demo, {
          reason: 'csrf_missing',
        });
        return;
      }

      const body = asRecord(ctx.body);
      const userId = typeof body.user_id === 'string' ? body.user_id : DEMO_USER_ID;

      if (body.action === 'revoke') {
        const grantId = typeof body.grant_id === 'string' ? body.grant_id : '';
        const target = grants.find((item) => item.id === grantId && !item.revoked);
        if (target === undefined) {
          problem(res, 404, 'NOT_FOUND', 'grant_not_found — отзывать нечего.', demo, { reason: 'grant_not_found' });
          return;
        }
        const revokedAt = nowIso(0);
        grants = grants.map((item) => (item.id === grantId ? { ...item, revoked: true, revoked_at: revokedAt } : item));
        json(res, 200, { grant_id: target.id, kind: target.kind, source: target.source, expires_at: target.expires_at }, demo);
        return;
      }

      const days = typeof body.days === 'number' ? body.days : null;
      issued += 1;
      const created: MockGrant = {
        id: randomUuid(1000 + issued),
        user_id: userId,
        kind: (typeof body.kind === 'string' ? body.kind : 'all_access') as MockGrant['kind'],
        source: 'admin',
        code_id: null,
        days,
        starts_at: nowIso(0),
        expires_at: days === null ? null : nowIso(days * DAY),
        consumed_at: null,
        revoked_at: null,
        revoked: false,
        created_at: nowIso(0),
      };
      grants = [created, ...grants];
      json(res, 200, { grant_id: created.id, kind: created.kind, source: created.source, expires_at: created.expires_at }, demo);
      return;
    }

    problem(res, 404, 'NOT_FOUND', `Мокер не знает маршрута ${ctx.method} ${pathname}.`, demo);
  }

  return {
    name: 'astro-admin-mock',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const raw = await readBody(req);
          const url = new URL(req.url ?? '/', 'http://localhost');
          const pathname = url.pathname;

          if (!pathname.startsWith('/api/v1/')) {
            next();
            return;
          }
          if (PUBLIC_PATHS.includes(pathname)) {
            await forward(req, res, raw);
            return;
          }
          if (!pathname.startsWith('/api/v1/admin/')) {
            next();
            return;
          }
          if ((await resolveMode()) === 'live') {
            await forward(req, res, raw);
            return;
          }

          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

          handle(pathname, {
            method: req.method ?? 'GET',
            url,
            body: raw.length === 0 ? undefined : (JSON.parse(raw.toString('utf8')) as unknown),
            cookie: req.headers.cookie ?? '',
            csrf: typeof req.headers['x-admin-csrf'] === 'string' ? req.headers['x-admin-csrf'] : null,
          }, res);
        })().catch((error: unknown) => {
          problem(res, 500, 'INTERNAL', `Мокер упал: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
    },
  };
}
