import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';

const ADMIN_TG_ID = String(FICTIONAL_USER.id);
const JOBS_SECRET = 'test-jobs-secret-0123456789';

let ctx: TestContext;
let telegram: FakeTelegram;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

async function ensureUser(userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER)) {
  await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);
  return userId;
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    telegram,
    env: { ADMIN_TG_ID, INTERNAL_JOB_SECRET: JOBS_SECRET },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.messages.length = 0;
  telegram.refunds.length = 0;
});

describe('GET /api/v1/admin/metrics', () => {
  it('не админу → 403 FORBIDDEN', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor({ id: 777_000_999, first_name: 'Чужой' }))
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('без initData → 401 (маршрут не публичный)', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/admin/metrics').expect(401);
  });

  it('считает воронку по occurred_at, а не по created_at', async () => {
    const userId = await ensureUser();

    // Событие случилось 10 дней назад, а батч пришёл сейчас: в воронку
    // 30 дней оно входит, в «сегодня» — нет.
    await ctx.db.query(
      `INSERT INTO events (user_id, name, props, occurred_at, created_at)
       VALUES ($1, 'app_open', '{}'::jsonb, now() - interval '10 days', now())`,
      [userId],
    );

    // Слишком старое событие вне окна.
    await ctx.db.query(
      `INSERT INTO events (user_id, name, props, occurred_at, created_at)
       VALUES ($1, 'app_open', '{}'::jsonb, now() - interval '40 days', now())`,
      [userId],
    );

    // Серверное событие без клиентского времени: берётся created_at.
    await ctx.db.query(
      `INSERT INTO events (user_id, name, props)
       VALUES ($1, 'payment_succeeded', '{}'::jsonb)`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.mau).toBe(1);
    // Сорокадневное событие не считается, остальные два — считаются.
    expect(response.body.events_30d.app_open).toBe(1);
    expect(response.body.events_30d.payment_succeeded).toBe(1);
    expect(response.body.funnel_30d).toMatchObject({
      app_open: 1,
      consent_accepted: 0,
      chart_created: 0,
      checkout_opened: 0,
      payment_succeeded: 1,
    });
    expect(response.body.conversion_to_paid).toBe(0);
  });

  it('отдаёт агрегаты подписок и платежей без ПДн', async () => {
    const userId = await ensureUser();

    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'month', 'active', now() + interval '20 days')`,
      [userId],
    );
    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
       VALUES ($1, $2, 'month_399', 399, 'charge-metrics-1', true)`,
      [userId, FICTIONAL_USER.id],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.paying).toBe(1);
    expect(response.body.stars_received_30d).toBe(399);
    // Ни одного идентификатора пользователя в теле — только числа.
    expect(JSON.stringify(response.body)).not.toContain(String(FICTIONAL_USER.id));
  });
});

describe('POST /api/v1/internal/jobs/run', () => {
  it('без секрета → 403', async () => {
    await request(ctx.app.getHttpServer()).post('/api/v1/internal/jobs/run').expect(403);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run')
      .set('X-Jobs-Secret', 'wrong-secret-000')
      .expect(403);
  });

  it('гасит истёкшую подписку и пишет одно сообщение', async () => {
    const userId = await ensureUser();

    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'week', 'active', now() - interval '1 hour')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    expect(response.body).toMatchObject({ subscriptions_expired: 1, expiry_notices_sent: 1 });
    expect(telegram.messages).toHaveLength(1);

    const subscription = await ctx.db.queryOne<{ status: string }>(
      `SELECT status FROM subscriptions WHERE user_id = $1`,
      [userId],
    );
    expect(subscription?.status).toBe('expired');
  });

  it('повторный запуск не дублирует сообщение (троттлинг 30 дней)', async () => {
    const userId = await ensureUser();

    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'week', 'active', now() - interval '1 hour')`,
      [userId],
    );

    await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    const second = await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    expect(second.body).toMatchObject({ subscriptions_expired: 0, expiry_notices_sent: 0 });
    expect(telegram.messages).toHaveLength(1);
  });

  it('возвращает звёзды за платёж, который не удалось выдать за 10 минут', async () => {
    const userId = await ensureUser();

    await ctx.db.query(
      `INSERT INTO payments
         (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed, paid_at)
       VALUES ($1, $2, 'one_149', 149, 'charge-undelivered-1', false, now() - interval '15 minutes')`,
      [userId, FICTIONAL_USER.id],
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .expect(202);

    expect(response.body).toMatchObject({ refunds_attempted: 1, refunds_done: 1 });
    expect(telegram.refunds).toEqual([
      { userId: FICTIONAL_USER.id, chargeId: 'charge-undelivered-1' },
    ]);

    const payment = await ctx.db.queryOne<{ status: string }>(
      `SELECT status FROM payments WHERE telegram_payment_charge_id = 'charge-undelivered-1'`,
    );
    expect(payment?.status).toBe('refunded');
  });
});
