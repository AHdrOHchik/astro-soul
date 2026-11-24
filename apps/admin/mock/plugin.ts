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
  MOCK_BACKUP_WINDOW_MS,
  MOCK_MARKER,
  mockAlerts,
  mockAudit,
  mockCodes,
  mockFounders,
  mockGrants,
  mockMe,
  mockMetrics,
  mockPartners,
  mockPayments,
  mockPlanHistory,
  mockPlans,
  mockReports,
  mockUsers,
  nowIso,
  userSummary,
  type MockAccessCode,
  type MockGrant,
} from './fixtures.ts';
import type {
  AdminAlertAckResult,
  AdminBackupRunResult,
  AdminBanResult,
  AdminFounder,
  AdminPartner,
  AdminPaymentEntry,
  AdminPlan,
  AdminPlanHistoryEntry,
  AdminPushResult,
  AdminRefundResult,
  AdminReportRegenerateResult,
  AdminReportSummary,
  AdminUserCard,
  AdminWebhookSetResult,
} from '../src/api/types.ts';

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
  let plans: readonly AdminPlan[] = mockPlans.map((item) => ({ ...item }));
  let planHistory: readonly AdminPlanHistoryEntry[] = mockPlanHistory.map((item) => ({ ...item }));
  let users: readonly AdminUserCard[] = mockUsers.map((card) => ({
    ...card,
    payments: card.payments.map((payment) => ({ ...payment })),
  }));
  let payments: readonly AdminPaymentEntry[] = mockPayments.map((item) => ({ ...item }));
  let reports: readonly AdminReportSummary[] = mockReports.map((item) => ({ ...item }));
  let alerts = { ...mockAlerts, alerts: (mockAlerts.alerts ?? []).map((item) => ({ ...item })) };
  let pushSentAt: Record<string, string> = {};
  let backupRuns: number[] = [];
  const founders: readonly AdminFounder[] = mockFounders.map((item) => ({ ...item }));
  const partners: readonly AdminPartner[] = mockPartners.map((item) => ({ ...item }));
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
      // Отказы — те же, что у живого сервера (1.6.15), чтобы тексты входа
      // проверялись на экране, а не в мечтах разработчика панели:
      //   422 missing_fields · 401 invalid_hash · 401 auth_stale · 403 forbidden.
      // 429 по IP в моке нет — его воспроизводит только настоящая защита.
      const body = asRecord(ctx.body);
      const missing = ['id', 'auth_date', 'hash'].filter((key) => body[key] === undefined);
      if (missing.length > 0) {
        problem(res, 422, 'VALIDATION_FAILED', 'Виджет вернул неполный набор полей.', demo, {
          field_errors: missing.map((field) => ({ field, message: 'Подпись виджета не полная' })),
          reason: 'missing_fields',
          mock: MOCK_MARKER,
        });
        return;
      }
      if (body.hash === 'bad') {
        problem(res, 401, 'UNAUTHORIZED', 'Подпись не совпала.', demo, { reason: 'invalid_hash' });
        return;
      }
      const authDate = Number(body.auth_date);
      if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > 300) {
        problem(res, 401, 'UNAUTHORIZED', 'Подпись старше 300 секунд.', demo, { reason: 'auth_stale' });
        return;
      }
      // «Владелец» мока — 777001; кнопка ДЕМО шлёт 0, smoke-скрипты — 42.
      const id = String(body.id);
      if (id !== '777001' && id !== '0' && id !== '42') {
        problem(res, 403, 'FORBIDDEN', 'Этот id не входит в ADMIN_TG_ID.', demo, { reason: 'forbidden' });
        return;
      }
      json(res, 200, { ok: true, note: MOCK_MARKER }, { ...demo, 'Set-Cookie': 'admin_session=mock; Path=/; SameSite=Lax' });
      return;
    }

    if (ctx.method === 'POST' && pathname === '/api/v1/admin/auth/logout') {
      // Живую сессиию сервер разлогинит только с CSRF-заголовком; без cookie
      // повтор кнопки остаётся идемпотентным 200.
      if (hasSession(ctx.cookie) && ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'Выход из живой сессии требует X-Admin-CSRF.', demo, { reason: 'csrf_missing' });
        return;
      }
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
      json(res, 200, { ...alerts, note: MOCK_MARKER }, demo);
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

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/audit') {
      // Курсор — непрозрачный `c<offset>`: как у сервера, «страниц по номеру»
      // интерфейс не знает, а мокеру нужен переносимый указатель.
      const limitRaw = ctx.url.searchParams.get('limit');
      if (limitRaw !== null && limitRaw !== '') {
        const limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          problem(res, 422, 'VALIDATION_FAILED', 'Limit вне диапазона 1..200.', demo, { reason: 'invalid_limit', field_errors: [{ field: 'limit', message: 'Целое 1..200' }] });
          return;
        }
      }
      const actor = ctx.url.searchParams.get('actor_tg_id');
      if (actor !== null && actor !== '' && !/^\d+$/.test(actor)) {
        problem(res, 422, 'VALIDATION_FAILED', 'actor_tg_id — только цифры.', demo, { reason: 'invalid_actor_tg_id', field_errors: [{ field: 'actor_tg_id', message: 'Число' }] });
        return;
      }
      const cursorRaw = ctx.url.searchParams.get('cursor');
      let start = 0;
      if (cursorRaw !== null && cursorRaw !== '') {
        const match = /^c(\d+)$/.exec(cursorRaw);
        if (match === null) {
          problem(res, 422, 'VALIDATION_FAILED', 'Курсор мне не знаком.', demo, { reason: 'invalid_cursor' });
          return;
        }
        start = Number(match[1]);
      }
      const limit = limitRaw === null || limitRaw === '' ? 50 : Number(limitRaw);
      const entity = ctx.url.searchParams.get('entity');
      const action = ctx.url.searchParams.get('action');
      const rows = mockAudit.filter(
        (item) =>
          (entity === null || entity === '' || item.entity === entity) &&
          (action === null || action === '' || item.action === action) &&
          (actor === null || actor === '' || item.actor_tg_id === actor),
      );
      const page = rows.slice(start, start + limit);
      json(res, 200, { items: page, next_cursor: start + limit < rows.length ? `c${start + limit}` : null, note: MOCK_MARKER }, demo);
      return;
    }

    // ---- «Тарифы»: каталог, правка цены с версией и историей, история ----
    if (ctx.method === 'GET' && pathname === '/api/v1/admin/plans') {
      json(res, 200, { items: plans, note: MOCK_MARKER }, demo);
      return;
    }

    const planMatch = /^\/api\/v1\/admin\/plans\/([^/]+)$/.exec(pathname);
    if (planMatch !== null && ctx.method === 'PATCH') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF на PATCH.', demo, { reason: 'csrf_missing' });
        return;
      }
      const code = decodeURIComponent(planMatch[1] ?? '');
      const plan = plans.find((item) => item.code === code);
      if (plan === undefined) {
        problem(res, 404, 'NOT_FOUND', `Плана ${code} нет.`, demo, { reason: 'plan_not_found' });
        return;
      }
      const body = asRecord(ctx.body);
      const allowed = ['price_stars', 'test_only', 'confirm', 'comment', 'base_version'];
      const extra = Object.keys(body).filter((key) => !allowed.includes(key));
      if (extra.length > 0) {
        // 1.6.16: неизвестное поле — отказ, а не «молча проигнорировали».
        problem(res, 422, 'VALIDATION_FAILED', 'В теле есть поля, которых контракт не знает.', demo, {
          reason: 'unknown_field',
          field_errors: extra.map((field) => ({ field, message: 'Нет такого поля в PATCH /admin/plans/{code}' })),
        });
        return;
      }
      const errors: { field: string; message: string }[] = [];
      if (typeof body.comment !== 'string' || body.comment.trim() === '') {
        errors.push({ field: 'comment', message: 'Комментарий обязателен: правка цены без основания не записывается' });
      }
      if (typeof body.base_version !== 'number') {
        errors.push({ field: 'base_version', message: 'Оптимистичная блокировка: нужна версия строки' });
      }
      const price = body.price_stars;
      if (price !== undefined && (typeof price !== 'number' || !Number.isInteger(price) || price < 1)) {
        errors.push({ field: 'price_stars', message: 'Нужно целое число ≥ 1' });
      }
      // Сужение типа сразу: `body.test_only` — `unknown`, и «проверка в
      // накопительный массив ошибок».TypeScript не сужает.
      const testOnly = typeof body.test_only === 'boolean' ? body.test_only : undefined;
      if (body.test_only !== undefined && testOnly === undefined) {
        errors.push({ field: 'test_only', message: 'Только true/false' });
      }
      if (errors.length > 0) {
        problem(res, 422, 'VALIDATION_FAILED', 'Тариф не изменён.', demo, { field_errors: errors });
        return;
      }
      if (testOnly === false && plan.test_only && body.confirm !== 'disable_test_plan') {
        // Снять флаг = выставить тариф в продажу по его текущей цене.
        problem(res, 422, 'VALIDATION_FAILED', 'Снятие test_only требует подтверждения.', demo, {
          reason: 'confirmation_required',
          field_errors: [{ field: 'confirm', message: 'Нужно confirm: "disable_test_plan"' }],
        });
        return;
      }
      const priceChanged = price !== undefined && price !== plan.price_stars;
      const flagsChanged = testOnly !== undefined && testOnly !== plan.test_only;
      if (!priceChanged && !flagsChanged) {
        problem(res, 422, 'VALIDATION_FAILED', 'Менять нечего.', demo, { reason: 'nothing_to_update' });
        return;
      }
      if (priceChanged && plan.founder_only) {
        // Ответ владельца §5: `founder_month` ценой не правится.
        problem(res, 403, 'FORBIDDEN', 'Цена этого тарифа обещана первым 50 людям и из панели не меняется.', demo, {
          reason: 'founder_plan_locked',
        });
        return;
      }
      if (body.base_version !== plan.version) {
        // 409 price_changed: панель обязана перечитать, а не перезаписать.
        problem(res, 409, 'CONFLICT', 'Тариф изменён другой сессией — показываем текущее значение.', demo, {
          reason: 'price_changed',
          current: { price_stars: plan.price_stars, version: plan.version },
        });
        return;
      }
      const nextPrice = priceChanged ? (price as number) : plan.price_stars;
      const updated: AdminPlan = {
        ...plan,
        price_stars: nextPrice,
        test_only: testOnly ?? plan.test_only,
        version: plan.version + 1,
        updated_at: nowIso(0),
      };
      plans = plans.map((item) => (item.code === code ? updated : item));
      if (priceChanged) {
        // История цен пишется только когда менялась цена; `test_only` живёт в аудите.
        planHistory = [
          {
            id: `ph-${planHistory.length + 1}`,
            plan_code: code,
            price_stars: nextPrice,
            previous_price_stars: plan.price_stars,
            version: updated.version,
            comment: String(body.comment).trim(),
            actor_tg_id: typeof mockMe.tg_id === 'string' ? mockMe.tg_id : '0',
            // Снимок имени на момент действия — не ссылка на `users`.
            actor_name: typeof mockMe.name === 'string' ? mockMe.name : 'ДЕМО',
            effective_from: nowIso(0),
            created_at: nowIso(0),
          },
          ...planHistory,
        ];
      }
      const patchResult: { plan: AdminPlan; effective_from: string; price_change_scope?: 'only_new_purchases' } = {
        plan: updated,
        effective_from: nowIso(0),
      };
      if (priceChanged) patchResult.price_change_scope = 'only_new_purchases';
      json(res, 200, { ...patchResult, note: MOCK_MARKER }, demo);
      return;
    }

    const historyMatch = /^\/api\/v1\/admin\/plans\/([^/]+)\/history$/.exec(pathname);
    if (historyMatch !== null && ctx.method === 'GET') {
      const code = decodeURIComponent(historyMatch[1] ?? '');
      json(res, 200, { items: planHistory.filter((item) => item.plan_code === code), note: MOCK_MARKER }, demo);
      return;
    }

    // ---- «Пользователи»: поиск одним параметром, карточка, три действия ----
    if (ctx.method === 'GET' && pathname === '/api/v1/admin/users') {
      const telegramId = ctx.url.searchParams.get('telegram_id')?.trim() ?? '';
      const alias = ctx.url.searchParams.get('alias')?.trim().replace(/^@+/, '') ?? '';
      const text = ctx.url.searchParams.get('q')?.trim() ?? '';
      const given = [telegramId !== '', alias !== '', text !== ''].filter(Boolean).length;
      if (given !== 1) {
        problem(res, 422, 'VALIDATION_FAILED', 'Поиск принимает ровно один параметр: telegram_id, alias или q.', demo, {
          reason: 'invalid_search',
          field_errors: [{ field: 'query', message: 'Ровно один непустой параметр' }],
        });
        return;
      }
      if (telegramId !== '' && !/^[0-9]{1,20}$/.test(telegramId)) {
        problem(res, 422, 'VALIDATION_FAILED', 'telegram_id — только цифры (до 20 знаков).', demo, {
          reason: 'invalid_search',
          field_errors: [{ field: 'telegram_id', message: '^[0-9]{1,20}$' }],
        });
        return;
      }
      const items = users
        .filter((card) =>
          telegramId !== ''
            ? card.telegram_id === telegramId
            : alias !== ''
              ? card.alias.toLowerCase() === alias.toLowerCase()
              : [card.alias, card.telegram_id ?? '', card.user_id].some((value) => value.toLowerCase().includes(text.toLowerCase())))
        .slice(0, 20)
        .map(userSummary);
      json(res, 200, { items, truncated: false, note: MOCK_MARKER }, demo);
      return;
    }

    const userMatch = /^\/api\/v1\/admin\/users\/([^/]+)(?:\/(refund|ban|push))?$/.exec(pathname);
    if (userMatch !== null) {
      const id = decodeURIComponent(userMatch[1] ?? '');
      const action = userMatch[2];
      const card = users.find((item) => item.user_id === id);
      if (card === undefined) {
        problem(res, 404, 'NOT_FOUND', 'Человека с таким user_id нет.', demo, { reason: 'user_not_found' });
        return;
      }

      if (action === undefined && ctx.method === 'GET') {
        json(res, 200, { ...card, note: MOCK_MARKER }, demo);
        return;
      }

      if (ctx.method !== 'POST') {
        problem(res, 405, 'VALIDATION_FAILED', `Метод ${ctx.method} здесь не работает.`, demo);
        return;
      }
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF на изменяющий запрос.', demo, { reason: 'csrf_missing' });
        return;
      }
      const body = asRecord(ctx.body);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (action === 'refund') {
        const allowed = ['charge_id', 'reason'];
        const extra = Object.keys(body).filter((key) => !allowed.includes(key));
        if (extra.length > 0) {
          // Отдельно «суммы» в теле нет: `amount_stars` — это `unknown_field`.
          problem(res, 422, 'VALIDATION_FAILED', 'Возврат принимает только charge_id и reason.', demo, {
            reason: extra.includes('amount_stars') ? 'refund_amount_not_allowed' : 'unknown_field',
            field_errors: extra.map((field) => ({ field, message: 'Сумму считает сервер' })),
          });
          return;
        }
        if (reason === '') {
          problem(res, 422, 'VALIDATION_FAILED', 'Возврат без основания не проводится.', demo, {
            field_errors: [{ field: 'reason', message: 'Обязательно' }],
          });
          return;
        }
        const chargeId = typeof body.charge_id === 'string' ? body.charge_id : '';
        const payment = card.payments.find((item) => item.charge_id === chargeId);
        if (payment === undefined) {
          problem(res, 404, 'NOT_FOUND', 'Платежа с таким charge_id у этого человека нет.', demo, { reason: 'charge_not_found' });
          return;
        }
        if (payment.status === 'refunded' || payment.refunded_at !== undefined) {
          problem(res, 409, 'CONFLICT', 'По этому платежу уже был возврат.', demo, { reason: 'already_refunded' });
          return;
        }
        if (payment.status === 'failed') {
          problem(res, 409, 'CONFLICT', 'Возвращать нечего: платёж не прошёл.', demo, { reason: 'nothing_to_refund' });
          return;
        }
        // Возврат только полный: сумма — сумма исходного заряда, поля «сколько»
        // в теле нет, и `access_revoked` решает сервер (у нас — остаётся).
        const refund: AdminRefundResult = {
          ok: true,
          charge_id: payment.charge_id,
          amount_stars: payment.amount_stars,
          refunded_at: nowIso(0),
          access_revoked: false,
        };
        users = users.map((item) =>
          item.user_id === id
            ? {
                ...item,
                payments: item.payments.map((entry) =>
                  entry.charge_id === payment.charge_id ? { ...entry, status: 'refunded' as const, refunded_at: nowIso(0) } : entry),
              }
            : item);
        payments = payments.map((entry) => (entry.charge_id === payment.charge_id ? { ...entry, status: 'refunded', refunded_at: nowIso(0) } : entry));
        json(res, 200, { ...refund, note: MOCK_MARKER }, demo);
        return;
      }
      if (action === 'ban') {
        const banned = body.banned;
        if (typeof banned !== 'boolean') {
          problem(res, 422, 'VALIDATION_FAILED', 'Нужен флаг banned: true|false — маршрут один на бан и разбан.', demo, {
            field_errors: [{ field: 'banned', message: 'Только true/false' }],
          });
          return;
        }
        if (banned && reason === '') {
          problem(res, 422, 'VALIDATION_FAILED', 'Блокировка без основания не проводится.', demo, {
            field_errors: [{ field: 'reason', message: 'Обязательно для banned: true' }],
          });
          return;
        }
        const result: AdminBanResult = {
          user_id: id,
          banned,
          banned_at: banned ? nowIso(0) : null,
          reason: banned ? reason : null,
        };
        users = users.map((item) =>
          item.user_id === id
            ? { ...item, banned, banned_at: banned ? nowIso(0) : null, ban_reason: banned ? reason : null }
            : item);
        json(res, 200, { ...result, note: MOCK_MARKER }, demo);
        return;
      }
      if (action === 'push') {
        if (Object.keys(body).length > 0) {
          problem(res, 422, 'VALIDATION_FAILED', 'У этого запроса тела нет.', demo, {
            reason: 'unknown_field',
            field_errors: Object.keys(body).map((field) => ({ field, message: 'Тело не принимается' })),
          });
          return;
        }
        if (!card.push_enabled) {
          problem(res, 409, 'CONFLICT', 'У человека выключены пуши (или он заблокировал бота).', demo, { reason: 'push_disabled' });
          return;
        }
        if (pushSentAt[id] !== undefined) {
          problem(res, 409, 'CONFLICT', 'Тестовый пуш уже отправляли в эти сутки.', demo, { reason: 'push_test_sent_24h' });
          return;
        }
        const sentAt = nowIso(0);
        pushSentAt = { ...pushSentAt, [id]: sentAt };
        const result: AdminPushResult = { user_id: id, sent: true, sent_at: sentAt, kind: 'test' };
        json(res, 200, { ...result, note: MOCK_MARKER }, demo);
        return;
      }
    }

    // ---- «Платежи и генерации»: лента зарядов по курсору и лента разборов ----
    if (ctx.method === 'GET' && pathname === '/api/v1/admin/payments') {
      const chargeId = ctx.url.searchParams.get('charge_id')?.trim() ?? '';
      const userId = ctx.url.searchParams.get('user_id')?.trim() ?? '';
      const status = ctx.url.searchParams.get('status')?.trim() ?? '';
      if (status !== '' && !['paid', 'processed', 'refunded', 'failed'].includes(status)) {
        problem(res, 422, 'VALIDATION_FAILED', 'Неизвестный статус платежа.', demo, {
          reason: 'invalid_filter',
          field_errors: [{ field: 'status', message: 'paid|processed|refunded|failed' }],
        });
        return;
      }
      const limitRaw = ctx.url.searchParams.get('limit');
      const limit = limitRaw === null || limitRaw === '' ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        problem(res, 422, 'VALIDATION_FAILED', 'limit — целое от 1 до 100.', demo, {
          reason: 'invalid_limit',
          field_errors: [{ field: 'limit', message: '1..100' }],
        });
        return;
      }
      let start = 0;
      const cursorRaw = ctx.url.searchParams.get('cursor');
      if (cursorRaw !== null && cursorRaw !== '') {
        const match = /^(\d+)$/.exec(cursorRaw);
        if (match === null) {
          problem(res, 422, 'VALIDATION_FAILED', 'Курсор мне не знаком.', demo, { reason: 'invalid_cursor' });
          return;
        }
        start = Number(match[1]);
      }
      const rows = payments.filter(
        (item) =>
          (chargeId === '' || item.charge_id === chargeId) &&
          (userId === '' || item.user_id === userId) &&
          (status === '' || item.status === status),
      );
      const page = rows.slice(start, start + limit);
      json(res, 200, {
        items: page,
        next_cursor: start + limit < rows.length ? String(start + limit) : null,
        note: MOCK_MARKER,
      }, demo);
      return;
    }

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/reports') {
      const status = ctx.url.searchParams.get('status')?.trim() ?? '';
      const kind = ctx.url.searchParams.get('kind')?.trim() ?? '';
      const userId = ctx.url.searchParams.get('user_id')?.trim() ?? '';
      const statuses = ['queued', 'planning', 'writing', 'ready', 'failed', 'refunded'];
      const kinds = ['report', 'compat', 'solar'];
      if (status !== '' && !statuses.includes(status)) {
        problem(res, 422, 'VALIDATION_FAILED', 'Неизвестный статус разбора.', demo, {
          reason: 'invalid_filter',
          field_errors: [{ field: 'status', message: statuses.join('|') }],
        });
        return;
      }
      if (kind !== '' && !kinds.includes(kind)) {
        problem(res, 422, 'VALIDATION_FAILED', 'Неизвестный вид разбора.', demo, {
          reason: 'invalid_filter',
          field_errors: [{ field: 'kind', message: kinds.join('|') }],
        });
        return;
      }
      const limitRaw = ctx.url.searchParams.get('limit');
      const limit = limitRaw === null || limitRaw === '' ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        problem(res, 422, 'VALIDATION_FAILED', 'limit — целое от 1 до 100.', demo, {
          reason: 'invalid_limit',
          field_errors: [{ field: 'limit', message: '1..100' }],
        });
        return;
      }
      const rows = reports.filter(
        (item) => (status === '' || item.status === status) && (kind === '' || item.kind === kind) && (userId === '' || item.user_id === userId),
      );
      const page = rows.slice(0, limit);
      json(res, 200, { items: page, truncated: rows.length > page.length, note: MOCK_MARKER }, demo);
      return;
    }

    const regenerateMatch = /^\/api\/v1\/admin\/reports\/([^/]+)\/regenerate$/.exec(pathname);
    if (regenerateMatch !== null && ctx.method === 'POST') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF на изменяющий запрос.', demo, { reason: 'csrf_missing' });
        return;
      }
      const id = decodeURIComponent(regenerateMatch[1] ?? '');
      const report = reports.find((item) => item.id === id);
      if (report === undefined) {
        problem(res, 404, 'NOT_FOUND', 'Разбора с таким id нет.', demo, { reason: 'report_not_found' });
        return;
      }
      if (report.status !== 'failed') {
        problem(res, 409, 'CONFLICT', 'Перезапускать можно только упавший разбор: готовый текст было бы затёрт.', demo, {
          reason: 'report_not_regenerable',
        });
        return;
      }
      reports = reports.map((item) => (item.id === id ? { ...item, status: 'queued' as const, updated_at: nowIso(0) } : item));
      const result: AdminReportRegenerateResult = { report_id: id, state: 'queued', attempts: report.attempts + 1 };
      json(res, 202, { ...result, note: MOCK_MARKER }, demo);
      return;
    }

    // ---- «Основатели и партнёры»: места 1…50 и агрегаты по партнёрам ----
    if (ctx.method === 'GET' && pathname === '/api/v1/admin/founders') {
      const limitRaw = ctx.url.searchParams.get('limit');
      const limit = limitRaw === null || limitRaw === '' ? 50 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        problem(res, 422, 'VALIDATION_FAILED', 'limit — целое от 1 до 100.', demo, {
          reason: 'invalid_limit',
          field_errors: [{ field: 'limit', message: '1..100' }],
        });
        return;
      }
      let start = 0;
      const cursorRaw = ctx.url.searchParams.get('cursor');
      if (cursorRaw !== null && cursorRaw !== '') {
        const match = /^(\d+)$/.exec(cursorRaw);
        if (match === null) {
          problem(res, 422, 'VALIDATION_FAILED', 'Курсор мне не знаком.', demo, { reason: 'invalid_cursor' });
          return;
        }
        start = Number(match[1]);
      }
      const page = founders.slice(start, start + limit);
      json(res, 200, {
        items: page,
        next_cursor: start + limit < founders.length ? String(start + limit) : null,
        note: MOCK_MARKER,
      }, demo);
      return;
    }

    if (ctx.method === 'GET' && pathname === '/api/v1/admin/partners') {
      json(res, 200, { items: partners, note: MOCK_MARKER }, demo);
      return;
    }

    // ---- «Эксплуатация»: дамп, вебхук, подтверждение алерта ----
    if (ctx.method === 'POST' && pathname === '/api/v1/admin/backup/run') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF на изменяющий запрос.', demo, { reason: 'csrf_missing' });
        return;
      }
      const body = asRecord(ctx.body);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 5) {
        problem(res, 422, 'VALIDATION_FAILED', 'Основание обязательно: от 5 до 500 знаков.', demo, {
          reason: 'invalid_reason',
          field_errors: [{ field: 'reason', message: 'minLength 5' }],
        });
        return;
      }
      if (process.env.API_MOCK_BACKUP === 'unconfigured') {
        // Имена переменных — из `details.missing`: панель показывает их дословно.
        problem(res, 503, 'UNAVAILABLE', 'Выгрузка не настроена — локальный дамп бэкапом не считается.', demo, {
          reason: 'backup_not_configured',
          missing: ['BACKUP_S3_URL', 'BACKUP_REMOTE', 'BACKUP_STATE_FILE'],
        });
        return;
      }
      const now = Date.now();
      const recent = backupRuns.filter((at) => now - at < MOCK_BACKUP_WINDOW_MS);
      if (recent.length > 0) {
        const left = Math.ceil((MOCK_BACKUP_WINDOW_MS - (now - Math.max(...recent))) / 1000);
        problem(res, 409, 'CONFLICT', 'Дамп уже запускался меньше 10 минут назад.', demo, {
          reason: 'backup_too_frequent',
          retry_after_seconds: left,
        });
        return;
      }
      backupRuns = [...recent, now];
      const result: AdminBackupRunResult = { started: true, job_id: randomUuid(backupRuns.length) };
      json(res, 202, { ...result, note: MOCK_MARKER }, demo);
      return;
    }

    if (ctx.method === 'POST' && pathname === '/api/v1/admin/telegram/webhook') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF на изменяющий запрос.', demo, { reason: 'csrf_missing' });
        return;
      }
      const body = asRecord(ctx.body);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 5) {
        problem(res, 422, 'VALIDATION_FAILED', 'Основание обязательно: от 5 до 500 знаков.', demo, {
          reason: 'invalid_reason',
          field_errors: [{ field: 'reason', message: 'minLength 5' }],
        });
        return;
      }
      const url = 'https://example.invalid/api/v1/telegram/webhook';
      if (process.env.API_MOCK_WEBHOOK === 'reject') {
        // Текст Bot API отдаётся дословно, в `details.last_error_message`.
        problem(res, 502, 'UPSTREAM_LLM', 'Telegram отказался принимать адрес.', demo, {
          url,
          ok: false,
          last_error_message: '[Bad Request: Webhook URL must be HTTPS]',
        });
        return;
      }
      const result: AdminWebhookSetResult = { url, ok: true, last_error_message: null };
      json(res, 200, { ...result, note: MOCK_MARKER }, demo);
      return;
    }

    const ackMatch = /^\/api\/v1\/admin\/alerts\/([^/]+)\/ack$/.exec(pathname);
    if (ackMatch !== null && ctx.method === 'POST') {
      if (ctx.csrf !== DEMO_CSRF) {
        problem(res, 403, 'FORBIDDEN', 'DEV-мокер требует X-Admin-CSRF на изменяющий запрос.', demo, { reason: 'csrf_missing' });
        return;
      }
      const id = decodeURIComponent(ackMatch[1] ?? '');
      const alert = alerts.alerts.find((item) => item.id === id);
      if (alert === undefined) {
        problem(res, 422, 'VALIDATION_FAILED', 'Такого правила мониторинга нет.', demo, {
          reason: 'unknown_alert',
          field_errors: [{ field: 'id', message: 'только правила из GET /admin/alerts' }],
        });
        return;
      }
      const body = asRecord(ctx.body);
      const minutes = body.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
        problem(res, 422, 'VALIDATION_FAILED', 'minutes — целое от 15 до 1440.', demo, {
          reason: 'invalid_minutes',
          field_errors: [{ field: 'minutes', message: '15..1440' }],
        });
        return;
      }
      const ackedUntil = nowIso(minutes * 60_000);
      // Подтверждение гасит показ: `fired` → false, `value`/`threshold`/`since` не трогаются.
      alerts = {
        ...alerts,
        alerts: alerts.alerts.map((item) => (item.id === id ? { ...item, fired: false, acked_until: ackedUntil } : item)),
      };
      const result: AdminAlertAckResult = {
        acked_until: ackedUntil,
        alert: alerts.alerts.find((item) => item.id === id) ?? alert,
      };
      json(res, 200, { ...result, note: MOCK_MARKER }, demo);
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
