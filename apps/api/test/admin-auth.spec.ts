import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { AdminLoginThrottle } from '../src/modules/admin-auth/admin-login-throttle.service';
import { ADMIN_SESSION_COOKIE } from '../src/modules/admin-auth/admin-session-cookie';
import {
  ADMIN_LOGIN_MAX_AGE_SECONDS,
  verifyTelegramLogin,
} from '../src/modules/admin-auth/telegram-login';
import { UsersRepository } from '../src/modules/users/users.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { signTelegramLogin, telegramLoginPayload } from './telegram-login-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Вход в админ-панель (итерация 40, контракт 1.6.15).
 *
 * Проверяется не «маршрут отвечает 200», а то, что нельзя увидеть глазами:
 * граница окна `auth_date` (ровно 300 — годен), отказ входа без сессии и без
 * журнала, CSRF до любого эффекта (по базе, а не по коду ответа), настоящий
 * выход (старая cookie перестаёт работать) и то, что «аудит недоступен» значит
 * «действие не выполнено».
 */

const ADMIN_TG_ID = '777000999';
const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_owner' };

let ctx: TestContext;
let users: UsersRepository;
let throttle: AdminLoginThrottle;

function payload(overrides: { readonly id?: string | number; readonly nowSeconds?: number } = {}) {
  return telegramLoginPayload({
    id: overrides.id ?? ADMIN_TG_ID,
    botToken: TEST_BOT_TOKEN,
    ...(overrides.nowSeconds === undefined ? {} : { nowSeconds: overrides.nowSeconds }),
  });
}

function initData(user: Record<string, unknown> = ADMIN): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

/** Cookie из ответа `POST /admin/auth/telegram` — так, как её пришлёт браузер. */
function sessionCookie(response: request.Response): string {
  const raw = response.headers['set-cookie'];
  const list: readonly string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const cookie = list.find((item) => item.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (cookie === undefined) {
    throw new Error('ответ не выставил cookie сессии');
  }
  return cookie.split(';')[0] ?? '';
}

async function login(): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/admin/auth/telegram')
    .send(payload())
    .expect(200);

  const cookie = sessionCookie(response);

  const me = await request(ctx.app.getHttpServer())
    .get('/api/v1/admin/me')
    .set('Cookie', cookie)
    .expect(200);

  return { cookie, csrf: me.body.csrf_token as string };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      ADMIN_TG_ID,
      COOKIE_SECURE: 'true',
      ADMIN_LOGIN_MAX_ATTEMPTS: '10',
      ADMIN_LOGIN_WINDOW_MINUTES: '15',
    },
  });
  users = ctx.app.get(UsersRepository);
  throttle = ctx.app.get(AdminLoginThrottle);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // Счётчик неудач живёт в памяти процесса: без сброса тест «10 неудач» закрыл
  // бы вход всем следующим тестам этого файла.
  throttle.reset();
});

describe('verifyTelegramLogin — чистая проверка', () => {
  it('принимает id строкой и числом', () => {
    const asString = verifyTelegramLogin(payload(), TEST_BOT_TOKEN);
    expect(asString).toMatchObject({ ok: true, tgId: BigInt(ADMIN_TG_ID), name: 'Владелец Панели' });

    const asNumber = verifyTelegramLogin(payload({ id: Number(ADMIN_TG_ID) }), TEST_BOT_TOKEN);
    expect(asNumber).toMatchObject({ ok: true, tgId: BigInt(ADMIN_TG_ID) });
  });

  it('граница окна: ровно 300 секунд — годен, 301 — auth_stale', () => {
    const now = Math.floor(Date.now() / 1000);

    const exactly = verifyTelegramLogin(
      payload({ nowSeconds: now - ADMIN_LOGIN_MAX_AGE_SECONDS }),
      TEST_BOT_TOKEN,
      { nowSeconds: now },
    );
    expect(exactly).toMatchObject({ ok: true });

    const later = verifyTelegramLogin(
      payload({ nowSeconds: now - ADMIN_LOGIN_MAX_AGE_SECONDS - 1 }),
      TEST_BOT_TOKEN,
      { nowSeconds: now },
    );
    expect(later).toMatchObject({ ok: false, reason: 'auth_stale' });
  });

  it('подмена поля ломает подпись, отсутствие hash — отдельная причина', () => {
    const signed = payload();

    expect(verifyTelegramLogin({ ...signed, first_name: 'Другой' }, TEST_BOT_TOKEN)).toMatchObject({
      ok: false,
      reason: 'invalid_hash',
    });

    const { hash: _hash, ...withoutHash } = signed;
    expect(verifyTelegramLogin(withoutHash, TEST_BOT_TOKEN)).toMatchObject({
      ok: false,
      reason: 'missing_hash',
    });
  });

  it('пустой токен бота — это «проверить нечем», а не «пропускаем»', () => {
    expect(verifyTelegramLogin(payload(), '')).toMatchObject({ ok: false, reason: 'invalid_hash' });
  });

  it('будущая auth_date дальше допуска — протухшая строка', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifyTelegramLogin(signTelegramLogin({ id: ADMIN_TG_ID, auth_date: now + 600 }, TEST_BOT_TOKEN), TEST_BOT_TOKEN, {
        nowSeconds: now,
      }),
    ).toMatchObject({ ok: false, reason: 'auth_stale' });
  });
});

describe('POST /admin/auth/telegram', () => {
  it('ставит непрозрачную cookie с нужными атрибутами и пишет session.login', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .send(payload())
      .expect(200);

    expect(response.body).toEqual({ ok: true });

    const raw = [response.headers['set-cookie']].flat().join('\n');
    expect(raw).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
    expect(raw).toContain('Max-Age=43200');

    const sessions = await ctx.db.query<{ tg_id: string; name: string; expires_at: Date }>(
      'SELECT tg_id, name, expires_at FROM admin_sessions',
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ tg_id: ADMIN_TG_ID, name: 'Владелец Панели' });

    const audit = await ctx.db.query<{ action: string; actor_name: string; after: unknown }>(
      'SELECT action, actor_name, after FROM admin_audit',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'session.login', actor_name: 'Владелец Панели' });
    expect(audit[0]?.after).toMatchObject({ expires_at: sessions[0]?.expires_at.toISOString() });
  });

  it('серверное событие admin_login пишется без ПДн', async () => {
    await login();

    const events = await ctx.db.query<{ name: string; props: Record<string, unknown>; user_id: string | null }>(
      `SELECT name, props, user_id FROM events WHERE name LIKE 'admin_%'`,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'admin_login', props: { ok: true }, user_id: null });
    expect(JSON.stringify(events[0])).not.toContain(ADMIN_TG_ID);
  });

  it('не-админ получает 403 без строки сессии и без записи в журнале', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .send(payload({ id: '777000111' }))
      .expect(403);

    const sessions = await ctx.db.query('SELECT 1 FROM admin_sessions');
    const audit = await ctx.db.query('SELECT 1 FROM admin_audit');
    expect(sessions).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('просроченная строка — 401 auth_stale, без hash — 422', async () => {
    const stale = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .send(payload({ nowSeconds: Math.floor(Date.now() / 1000) - 301 }))
      .expect(401);
    expect(stale.body.details.reason).toBe('auth_stale');

    const { hash: _hash, ...withoutHash } = payload();
    const noHash = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .send(withoutHash)
      .expect(422);
    expect(noHash.body.details.reason).toBe('missing_hash');
  });

  it('лимит считается по IP: чужой адрес не блокируется', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(ctx.app.getHttpServer())
        .post('/api/v1/admin/auth/telegram')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ ...payload(), hash: 'c'.repeat(64) })
        .expect(401);
    }

    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .set('X-Forwarded-For', '203.0.113.10')
      .send(payload())
      .expect(429);

    // Другой адрес — своя корзина: вход проходит.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .set('X-Forwarded-For', '203.0.113.11')
      .send(payload())
      .expect(200);
  });

  it('после 10 неудач 429 с retry_after, и даже верная строка не проверяется', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(ctx.app.getHttpServer())
        .post('/api/v1/admin/auth/telegram')
        .send({ ...payload(), hash: 'a'.repeat(64) })
        .expect(401);
    }

    const blocked = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/telegram')
      .send(payload())
      .expect(429);

    expect(blocked.body.details.reason).toBe('admin_login_throttled');
    expect(blocked.body.details.retry_after).toBeGreaterThan(0);

    // Ни одной сессии: заблокированный запрос не дошёл до создания.
    expect(await ctx.db.query('SELECT 1 FROM admin_sessions')).toHaveLength(0);
  });
});

describe('GET /admin/me и срок сессии', () => {
  it('отдаёт tg_id, снимок имени, срок и CSRF-токен', async () => {
    const { cookie } = await login();

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/me')
      .set('Cookie', cookie)
      .expect(200);

    expect(me.body).toMatchObject({ tg_id: ADMIN_TG_ID, name: 'Владелец Панели' });
    expect(me.body.csrf_token).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Date(me.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('last_seen_at обновляется не чаще раза в минуту', async () => {
    const { cookie } = await login();

    await request(ctx.app.getHttpServer()).get('/api/v1/admin/me').set('Cookie', cookie).expect(200);
    // Дадим записи дойти: `touch` намеренно не ждёт (авторизация не зависит от UPDATE).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const first = await ctx.db.queryOne<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM admin_sessions',
    );
    expect(first?.last_seen_at).not.toBeNull();

    await request(ctx.app.getHttpServer()).get('/api/v1/admin/me').set('Cookie', cookie).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await ctx.db.queryOne<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM admin_sessions',
    );
    // Второй запрос в ту же минуту значение не двигает.
    expect(second?.last_seen_at?.toISOString()).toBe(first?.last_seen_at?.toISOString());

    // А спустя минуту — двигает.
    await ctx.db.query(
      `UPDATE admin_sessions SET last_seen_at = now() - interval '2 minutes'`,
    );
    await request(ctx.app.getHttpServer()).get('/api/v1/admin/me').set('Cookie', cookie).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const third = await ctx.db.queryOne<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM admin_sessions',
    );
    expect(third?.last_seen_at?.toISOString()).not.toBe(first?.last_seen_at?.toISOString());
  });

  it('вход по initData работает и отдаёт null в сроке и CSRF', async () => {
    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/me')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    expect(me.body).toMatchObject({ tg_id: ADMIN_TG_ID, expires_at: null, csrf_token: null });
  });

  it('`Authorization: tma <initData>` — тот же вход, что и заголовок', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/codes')
      .set('Authorization', `tma ${initData()}`)
      .expect(200);
  });
});

describe('POST /admin/auth/logout', () => {
  it('выход настоящий: cookie перестаёт работать, повтор — 200 без новой записи', async () => {
    const { cookie } = await login();

    const logout = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/logout')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', (await request(ctx.app.getHttpServer()).get('/api/v1/admin/me').set('Cookie', cookie)).body.csrf_token)
      .expect(200);
    expect(logout.body).toEqual({ ok: true });
    expect([logout.headers['set-cookie']].flat().join('\n')).toContain('Max-Age=0');

    const session = await ctx.db.queryOne<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM admin_sessions',
    );
    expect(session?.revoked_at).not.toBeNull();

    // Старая cookie после выхода — 401: строку не удалили, но она отозвана.
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/me')
      .set('Cookie', cookie)
      .expect(401);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/auth/logout')
      .set('Cookie', cookie)
      .expect(200);

    const audit = await ctx.db.query<{ action: string }>('SELECT action FROM admin_audit');
    expect(audit.filter((row) => row.action === 'session.logout')).toHaveLength(1);
  });
});

describe('CSRF: cookie-путь без заголовка не меняет ничего', () => {
  it('нет заголовка — 403 csrf_missing, код не создан', async () => {
    const { cookie } = await login();

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set('Cookie', cookie)
      .send({ kind: 'single_report', max_activations: 1 })
      .expect(403);

    expect(response.body.details.reason).toBe('csrf_missing');
    // Главная проверка — по базе: эффекта не было.
    expect(await ctx.db.query('SELECT 1 FROM access_codes')).toHaveLength(0);
  });

  it('чужой токен — 403 csrf_mismatch; свой — 201 и запись code.create', async () => {
    const { cookie } = await login();

    const wrong = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', 'b'.repeat(64))
      .send({ kind: 'single_report', max_activations: 1 })
      .expect(403);
    expect(wrong.body.details.reason).toBe('csrf_mismatch');
    expect(await ctx.db.query('SELECT 1 FROM access_codes')).toHaveLength(0);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/me')
      .set('Cookie', cookie)
      .expect(200);

    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', me.body.csrf_token)
      .send({ kind: 'single_report', max_activations: 1, partner_name: 'Тест' })
      .expect(201);

    const audit = await ctx.db.queryOne<{ action: string; entity: string; after: unknown }>(
      `SELECT action, entity, after FROM admin_audit WHERE action = 'code.create'`,
    );
    expect(audit).toMatchObject({ action: 'code.create', entity: 'code' });
    expect(audit?.after).toMatchObject({ code: created.body.code, kind: 'single_report' });
  });

  it('путь initData CSRF не требует: мини-апп не должен ломаться', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set(INIT_DATA_HEADER, initData())
      .send({ kind: 'single_report', max_activations: 1 })
      .expect(201);
  });

  it('GET-ы без CSRF доступны: читать журнал можно, менять — нет', async () => {
    const { cookie } = await login();
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit')
      .set('Cookie', cookie)
      .expect(200);
  });
});

describe('аудит обязателен для действия', () => {
  it('журнал недоступен — код не создан (500 admin_audit_write_failed)', async () => {
    const { cookie, csrf } = await login();
    await users.ensureUser({ telegramUserId: BigInt(FICTIONAL_USER.id), languageCode: 'ru' });

    // Ломаем именно запись журнала: остальные таблицы работают. Так проверяется
    // порядок «сначала запись в журнал в той же транзакции, потом COMMIT».
    await ctx.db.query(
      `CREATE OR REPLACE FUNCTION admin_audit_fail_test() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'audit is down'; END;
       $$ LANGUAGE plpgsql`,
    );
    await ctx.db.query(
      `CREATE TRIGGER admin_audit_fail_test_trg BEFORE INSERT ON admin_audit
         FOR EACH ROW EXECUTE FUNCTION admin_audit_fail_test()`,
    );

    try {
      const response = await request(ctx.app.getHttpServer())
        .post('/api/v1/admin/codes')
        .set('Cookie', cookie)
        .set('X-Admin-CSRF', csrf)
        .send({ kind: 'single_report', max_activations: 1 })
        .expect(500);

      expect(response.body.details.reason).toBe('admin_audit_write_failed');
      expect(await ctx.db.query('SELECT 1 FROM access_codes')).toHaveLength(0);
    } finally {
      await ctx.db.query('DROP TRIGGER IF EXISTS admin_audit_fail_test_trg ON admin_audit');
      await ctx.db.query('DROP FUNCTION IF EXISTS admin_audit_fail_test()');
    }
  });

  it('grant.create и grant.revoke попадают в журнал с изменёнными полями', async () => {
    const adminUser = await users.ensureUser({
      telegramUserId: BigInt(ADMIN_TG_ID),
      languageCode: 'ru',
    });
    const { cookie, csrf } = await login();

    const issued = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', csrf)
      .send({ user_id: adminUser.userId, kind: 'all_access', days: 10 })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', csrf)
      .send({ user_id: adminUser.userId, kind: 'all_access', action: 'revoke', grant_id: issued.body.grant_id })
      .expect(200);

    const rows = await ctx.db.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM admin_audit WHERE entity = 'grant' ORDER BY at`,
    );

    expect(rows.map((row) => row.action)).toEqual(['grant.create', 'grant.revoke']);
    expect(rows[0]?.after).toMatchObject({ kind: 'all_access', source: 'admin', code_id: null });
    expect(rows[1]?.before).toEqual({ revoked_at: null });
    expect((rows[1]?.after as { revoked_at: string | null }).revoked_at).not.toBeNull();
  });
});

describe('cookie без Secure — только для песочницы', () => {
  it('при COOKIE_SECURE=false атрибута Secure нет', async () => {
    const local = await createTestContext({
      env: { ADMIN_TG_ID, COOKIE_SECURE: 'false' },
    });

    try {
      const response = await request(local.app.getHttpServer())
        .post('/api/v1/admin/auth/telegram')
        .send(payload())
        .expect(200);

      const raw = [response.headers['set-cookie']].flat().join('\n');
      expect(raw).toContain(`${ADMIN_SESSION_COOKIE}=`);
      expect(raw).not.toContain('Secure');
    } finally {
      await local.close();
    }
  });
});

describe('/health и метрики', () => {
  it('flags.admin_auth показывает включённость и число живых сессий', async () => {
    const before = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(before.body.flags.admin_auth).toEqual({ enabled: true, sessions_active: 0 });

    await login();

    const after = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(after.body.flags.admin_auth).toEqual({ enabled: true, sessions_active: 1 });
  });
});
