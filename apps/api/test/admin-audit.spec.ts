import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { AdminLoginThrottle } from '../src/modules/admin-auth/admin-login-throttle.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { telegramLoginPayload } from './telegram-login-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Журнал аудита админки (итерация 40, контракт 1.6.15).
 *
 * Здесь проверяется то, ради чего журнал и заводился: лента не теряет строки
 * на границе страниц, строки нельзя переписать или удалить, в `before`/`after`
 * нет ПДн, джоб уборки сессий пишет в журнал сам факт уборки, а метрики
 * показывают те же числа, что и журнал.
 */

const ADMIN_TG_ID = '777000999';
const JOBS_SECRET = 'test-jobs-secret-0123456789';
const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_owner' };

let ctx: TestContext;
let users: UsersRepository;
let throttle: AdminLoginThrottle;

function initData(user: Record<string, unknown> = ADMIN): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

async function loginCookie(): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/admin/auth/telegram')
    .send(telegramLoginPayload({ id: ADMIN_TG_ID, botToken: TEST_BOT_TOKEN }))
    .expect(200);

  const cookie = [response.headers['set-cookie']].flat().join(';').split(';')[0] ?? '';
  const me = await request(ctx.app.getHttpServer())
    .get('/api/v1/admin/me')
    .set('Cookie', cookie)
    .expect(200);

  return { cookie, csrf: me.body.csrf_token as string };
}

async function insertAudit(options: {
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string;
  readonly at: string;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO admin_audit (at, actor_tg_id, actor_name, action, entity, entity_id, after)
     VALUES ($1, $2, 'Тест', $3, $4, $5, '{"marker": true}'::jsonb)`,
    [options.at, ADMIN_TG_ID, options.action, options.entity, options.entityId ?? null],
  );
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { ADMIN_TG_ID, INTERNAL_JOB_SECRET: JOBS_SECRET, COOKIE_SECURE: 'false' },
  });
  users = ctx.app.get(UsersRepository);
  throttle = ctx.app.get(AdminLoginThrottle);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  throttle.reset();
});

describe('GET /admin/audit', () => {
  it('сортирует по at desc и отдаёт поля записи', async () => {
    await insertAudit({ action: 'code.create', entity: 'code', entityId: 'c1', at: '2026-01-01T10:00:00Z' });
    await insertAudit({ action: 'grant.create', entity: 'grant', entityId: 'g1', at: '2026-01-01T11:00:00Z' });

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    const items = response.body.items as { action: string }[];
    expect(items.map((item) => item.action)).toEqual([
      'grant.create',
      'code.create',
    ]);
    expect(response.body.items[0]).toMatchObject({
      actor_tg_id: ADMIN_TG_ID,
      actor_name: 'Тест',
      entity: 'grant',
      entity_id: 'g1',
    });
    expect(typeof response.body.items[0].id).toBe('string');
    expect(response.body.next_cursor).toBeNull();
  });

  it('фильтры: entity, entity_id, action, actor_tg_id', async () => {
    await insertAudit({ action: 'code.create', entity: 'code', entityId: 'c1', at: '2026-01-01T10:00:00Z' });
    await insertAudit({ action: 'grant.revoke', entity: 'grant', entityId: 'g9', at: '2026-01-01T11:00:00Z' });

    const byAction = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?action=grant.revoke')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);
    expect(byAction.body.items).toHaveLength(1);
    expect(byAction.body.items[0].entity_id).toBe('g9');

    const byEntity = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?entity=code&entity_id=c1')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);
    expect(byEntity.body.items).toHaveLength(1);
    expect(byEntity.body.items[0].action).toBe('code.create');

    const byActor = await request(ctx.app.getHttpServer())
      .get(`/api/v1/admin/audit?actor_tg_id=${ADMIN_TG_ID}`)
      .set(INIT_DATA_HEADER, initData())
      .expect(200);
    expect(byActor.body.items).toHaveLength(2);

    const stranger = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?actor_tg_id=12345')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);
    expect(stranger.body.items).toHaveLength(0);
  });

  it('курсор (at, id) не теряет и не дублирует строки', async () => {
    // Одинаковое `at` у двух строк — именно тот случай, где `at <` потерял бы
    // запись на границе страниц.
    await insertAudit({ action: 'session.login', entity: 'session', at: '2026-01-01T12:00:00Z' });
    await insertAudit({ action: 'session.logout', entity: 'session', at: '2026-01-01T12:00:00Z' });
    await insertAudit({ action: 'code.create', entity: 'code', at: '2026-01-01T11:00:00Z' });

    const first = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?limit=2')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    expect(first.body.items).toHaveLength(2);

    const second = await request(ctx.app.getHttpServer())
      .get(`/api/v1/admin/audit?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(second.body.next_cursor).toBeNull();
  });

  it('limit больше 200 и мусор в курсоре — 422', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?limit=201')
      .set(INIT_DATA_HEADER, initData())
      .expect(422);

    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?limit=abc')
      .set(INIT_DATA_HEADER, initData())
      .expect(422);

    const cursor = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit?cursor=не-курсор')
      .set(INIT_DATA_HEADER, initData())
      .expect(422);
    expect(cursor.body.details.reason).toBe('invalid_cursor');
  });

  it('не-админ получает 403', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/audit')
      .set(INIT_DATA_HEADER, initData(FICTIONAL_USER))
      .expect(403);
  });
});

describe('append-only', () => {
  it('строки нельзя обновить и удалить', async () => {
    await insertAudit({ action: 'code.create', entity: 'code', at: '2026-01-01T10:00:00Z' });

    await expect(
      ctx.db.query(`UPDATE admin_audit SET actor_name = 'подмена'`),
    ).rejects.toThrow(/append-only/u);

    await expect(ctx.db.query('DELETE FROM admin_audit')).rejects.toThrow(/append-only/u);

    const rows = await ctx.db.query<{ actor_name: string }>('SELECT actor_name FROM admin_audit');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_name).toBe('Тест');
  });
});

describe('ПДн в журнале', () => {
  it('grant.create пишет только изменённые поля, без данных человека', async () => {
    const owner = await users.ensureUser({
      telegramUserId: BigInt(FICTIONAL_USER.id),
      languageCode: 'ru',
    });
    const { cookie, csrf } = await loginCookie();

    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', csrf)
      .send({ user_id: owner.userId, kind: 'all_access', days: 10 })
      .expect(200);

    const row = await ctx.db.queryOne<{ before: unknown; after: Record<string, unknown> }>(
      `SELECT before, after FROM admin_audit WHERE action = 'grant.create'`,
    );

    expect(row?.before).toBeNull();
    expect(Object.keys(row?.after ?? {}).sort()).toEqual([
      'code_id',
      'expires_at',
      'kind',
      'source',
    ]);

    const serialized = JSON.stringify(row);
    for (const forbidden of ['birth_date', 'birth_time', 'birth_place', 'telegram_id', 'user_id']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('джоб уборки сессий', () => {
  it('удаляет сессии старше недели и пишет session.purge', async () => {
    await ctx.db.query(
      `INSERT INTO admin_sessions (tg_id, name, csrf_token, created_at, expires_at)
       VALUES (1, 'старая сессия', 'token', now() - interval '10 days', now() - interval '8 days')`,
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run?job=admin_sessions_cleanup')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    expect(response.body.admin_sessions_purged).toBe(1);

    const left = await ctx.db.query('SELECT 1 FROM admin_sessions');
    expect(left).toHaveLength(0);

    const audit = await ctx.db.queryOne<{ actor_tg_id: string; action: string; after: unknown }>(
      `SELECT actor_tg_id, action, after FROM admin_audit WHERE action = 'session.purge'`,
    );
    expect(audit).toMatchObject({ actor_tg_id: '0', action: 'session.purge' });
    expect(audit?.after).toMatchObject({ purged: 1, older_than_days: 7 });
  });

  it('свежая просроченная сессия не удаляется', async () => {
    await ctx.db.query(
      `INSERT INTO admin_sessions (tg_id, name, csrf_token, created_at, expires_at)
       VALUES (1, 'вчерашняя', 'token', now() - interval '2 days', now() - interval '1 day')`,
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run?job=admin_sessions_cleanup')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    expect(response.body.admin_sessions_purged).toBe(0);
    expect(await ctx.db.query('SELECT 1 FROM admin_sessions')).toHaveLength(1);
  });
});

describe('метрики админки', () => {
  it('admin_logins_24h, admin_audit_writes_24h и admin_sessions_purged_24h', async () => {
    const { cookie, csrf } = await loginCookie();

    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set('Cookie', cookie)
      .set('X-Admin-CSRF', csrf)
      .send({ kind: 'single_report', max_activations: 1 })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run?job=admin_sessions_cleanup')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    const metrics = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    expect(metrics.body.admin_logins_24h).toBe(1);
    // login + code.create + purge — три записи журнала за сутки.
    expect(metrics.body.admin_audit_writes_24h).toBe(3);
    expect(metrics.body.admin_sessions_purged_24h).toBe(0);
  });
});

describe('сохранность контракта 1.6.14', () => {
  it('GET/POST /admin/grants и /admin/codes отвечают теми же формами', async () => {
    const owner = await users.ensureUser({
      telegramUserId: BigInt(FICTIONAL_USER.id),
      languageCode: 'ru',
    });

    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set(INIT_DATA_HEADER, initData())
      .send({ kind: 'single_report', max_activations: 2 })
      .expect(201);
    expect(Object.keys(created.body).sort()).toEqual([
      'activations',
      'code',
      'created_at',
      'days',
      'expires_at',
      'id',
      'is_active',
      'kind',
      'max_activations',
      'partner_name',
    ]);

    const issued = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set(INIT_DATA_HEADER, initData())
      .send({ user_id: owner.userId, kind: 'all_access', days: 5 })
      .expect(200);
    expect(Object.keys(issued.body).sort()).toEqual(['expires_at', 'grant_id', 'kind', 'source']);

    const list = await request(ctx.app.getHttpServer())
      .get(`/api/v1/admin/grants?user_id=${owner.userId}`)
      .set(INIT_DATA_HEADER, initData())
      .expect(200);
    expect(Object.keys(list.body.items[0]).sort()).toEqual([
      'code_id',
      'consumed_at',
      'created_at',
      'days',
      'expires_at',
      'id',
      'kind',
      'revoked',
      'revoked_at',
      'source',
      'starts_at',
      'user_id',
    ]);
  });
});
