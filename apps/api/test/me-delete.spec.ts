import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { makeFakeAstro } from './fake-astro';

/** Таблицы, которые обязаны опустеть после `DELETE /me` (SPEC «Сценарий 6»). */
const PERSONAL_TABLES = ['users', 'profiles', 'charts', 'reports', 'asks', 'forecasts'] as const;

let ctx: TestContext;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

/** Готовит пользователя со всеми видами ПДн: профиль, карта, разбор, прогноз, вопрос. */
async function seedPersonalData(): Promise<{ userId: string; chartId: string }> {
  await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);

  await ctx.db.query(
    `INSERT INTO profiles (user_id, birth_date, birth_time, time_mode, place_name,
                           place_country, place_lat, place_lon, place_tz, consent_at)
     VALUES ($1, '1994-05-17', '14:20', 'exact', 'Москва', 'RU', 55.7558, 37.6173, 'Europe/Moscow', now())`,
    [userId],
  );

  const chart = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({
      birth_date: '1994-05-17',
      birth_time: '14:20',
      time_precision: 'exact',
      birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
      consent: { accepted: true, version: '2026-11-01' },
    })
    .expect(201);

  const chartId = chart.body.chart.chart_id as string;

  await ctx.db.query(`INSERT INTO reports (chart_id, user_id) VALUES ($1, $2)`, [chartId, userId]);
  await ctx.db.query(`INSERT INTO forecasts (chart_id, date) VALUES ($1, CURRENT_DATE)`, [chartId]);
  await ctx.db.query(`INSERT INTO asks (user_id, chart_id, question) VALUES ($1, $2, 'вопрос')`, [
    userId,
    chartId,
  ]);
  await ctx.db.query(
    `INSERT INTO quotas (user_id, code, period_key, used, reset_at)
     VALUES ($1, 'ask_daily', '2026-11-10', 1, now() + interval '1 day')`,
    [userId],
  );

  return { userId, chartId };
}

async function countRows(table: string): Promise<number> {
  const row = await ctx.db.queryOne<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(row?.count ?? '0');
}

beforeAll(async () => {
  ctx = await createTestContext({ astro: makeFakeAstro() });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('DELETE /api/v1/me', () => {
  it('стирает ПДн во всех шести таблицах, платежи остаются обезличенными', async () => {
    const { userId } = await seedPersonalData();

    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, status, processed)
       VALUES ($1, $2, 'one_149', 149, 'charge-delete-1', 'processed', true)`,
      [userId, FICTIONAL_USER.id],
    );
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'month', 'active', now() + interval '20 days')`,
      [userId],
    );

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    for (const table of PERSONAL_TABLES) {
      expect(await countRows(table), `${table} должна быть пустой`).toBe(0);
    }

    // Платежи — бухгалтерия: остаются, но без telegram_id (это ПДн).
    const payment = await ctx.db.queryOne<{
      telegram_id: string | null;
      anonymized_at: Date | null;
      telegram_payment_charge_id: string;
    }>(`SELECT telegram_id::text AS telegram_id, anonymized_at, telegram_payment_charge_id FROM payments`);
    expect(payment?.telegram_id).toBeNull();
    expect(payment?.anonymized_at).not.toBeNull();
    expect(payment?.telegram_payment_charge_id).toBe('charge-delete-1');

    // Подписка переживает удаление: оплаченный период не сгорает.
    expect(await countRows('subscriptions')).toBe(1);
    expect(await countRows('quotas')).toBe(0);
  });

  it('после удаления /me отдаёт чистый аккаунт', async () => {
    await seedPersonalData();

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(me.body).toMatchObject({ is_new: true, has_profile: false, has_chart: false });
    expect(me.body.user_id).toBe(userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER));
  });

  it('незавершённый платёж → 409 CONFLICT, ничего не удаляется', async () => {
    const { userId } = await seedPersonalData();

    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, status, processed)
       VALUES ($1, $2, 'one_149', 149, 'charge-pending-1', 'paid', false)`,
      [userId, FICTIONAL_USER.id],
    );

    const response = await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(409);

    expect(response.body).toMatchObject({ code: 'CONFLICT' });
    expect(await countRows('users')).toBe(1);
    expect(await countRows('charts')).toBe(1);
    expect(await countRows('profiles')).toBe(1);
  });

  it('повторное удаление идемпотентно: 204 без ошибки', async () => {
    await seedPersonalData();

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);
    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);
  });

  it('без initData → 401 и данные не тронуты', async () => {
    const { userId } = await seedPersonalData();

    await request(ctx.app.getHttpServer()).delete('/api/v1/me').expect(401);

    const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [userId]);
    expect(user?.id).toBe(userId);
  });
});
