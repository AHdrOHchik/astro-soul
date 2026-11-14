import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { PaymentsService } from '../src/modules/billing/payments.service';
import { TelegramClient } from '../src/modules/telegram/telegram.client';

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
      consent: { accepted: true, version: '2026-11-10' },
    })
    .expect(201);

  const chartId = chart.body.chart.chart_id as string;

  await ctx.db.query(`INSERT INTO reports (chart_id, user_id) VALUES ($1, $2)`, [chartId, userId]);
  await ctx.db.query(`INSERT INTO forecasts (chart_id, date) VALUES ($1, CURRENT_DATE)`, [chartId]);
  // Текста вопроса в БД больше нет (итерация 10): только длина и тема.
  await ctx.db.query(
    `INSERT INTO asks (user_id, chart_id, question_length, topic) VALUES ($1, $2, 6, 'other')`,
    [userId, chartId],
  );
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

    // Платежи — бухгалтерия: строка остаётся, связь с человеком рвётся.
    // `telegram_id` живёт окно возврата: Bot API возвращает звёзды только по
    // паре (user_id, charge_id), без него возврат после удаления невозможен.
    const payment = await ctx.db.queryOne<{
      user_id: string | null;
      telegram_id: string | null;
      invoice_payload: string | null;
      anonymized_at: Date | null;
      telegram_payment_charge_id: string;
    }>(`SELECT user_id::text AS user_id, telegram_id::text AS telegram_id, invoice_payload,
              anonymized_at, telegram_payment_charge_id FROM payments`);
    expect(payment?.user_id).toBeNull();
    expect(payment?.telegram_id).not.toBeNull();
    expect(payment?.invoice_payload).toBeNull();
    expect(payment?.anonymized_at).not.toBeNull();
    expect(payment?.telegram_payment_charge_id).toBe('charge-delete-1');

    // Подписка переживает удаление строкой бухгалтерии, но уже отменённой и
    // без владельца: оплаченный период не «сгорает» и не воскресает.
    expect(await countRows('subscriptions')).toBe(1);
    const subscription = await ctx.db.queryOne<{ user_id: string | null; status: string }>(
      `SELECT user_id::text AS user_id, status::text AS status FROM subscriptions`,
    );
    expect(subscription).toEqual({ user_id: null, status: 'cancelled' });
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

  it('зависший платёж без инвойса: джоб-путь разрешает его, удаление идёт (204)', async () => {
    const { userId } = await seedPersonalData();

    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, invoice_payload,
                             telegram_payment_charge_id, status, processed)
       VALUES ($1, $2, 'one_149', 149,
               '{"p":"one_149","u":"${userId}","k":"22222222-2222-4222-8222-222222222222"}',
               'charge-pending-1', 'paid', false)`,
      [userId, FICTIONAL_USER.id],
    );

    // QA-14: раньше это был тупик 409. Теперь платёж разрешается тем же кодом,
    // что и вебхук: инвойса нет — отказ, доступ не выдаётся, ПДн удаляются.
    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    const payment = await ctx.db.queryOne<{ status: string; reject_reason: string }>(
      `SELECT status, reject_reason FROM payments WHERE telegram_payment_charge_id = 'charge-pending-1'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'no_invoice' });
    expect(await countRows('users')).toBe(0);
    expect(await countRows('charts')).toBe(0);
    expect(await countRows('profiles')).toBe(0);
    expect(await countRows('subscriptions')).toBe(0);
  });

  it('зависший платёж по валидному инвойсу: доступ выдаётся, удаление идёт (204)', async () => {
    const { userId } = await seedPersonalData();

    await ctx.db.query(
      `INSERT INTO invoices (user_id, plan_code, idem_key, payload, invoice_link)
       VALUES ($1, 'one_149', '11111111-1111-4111-8111-111111111111',
               '{"p":"one_149","u":"...","k":"11111111-1111-4111-8111-111111111111"}', 'https://t.me/$x')`,
      [userId],
    );
    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, invoice_payload,
                             telegram_payment_charge_id, status, processed)
       VALUES ($1, $2, 'one_149', 149,
               '{"p":"one_149","u":"${userId}","k":"11111111-1111-4111-8111-111111111111"}',
               'charge-pending-2', 'paid', false)`,
      [userId, FICTIONAL_USER.id],
    );

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    const payment = await ctx.db.queryOne<{ status: string; processed: boolean }>(
      `SELECT status, processed FROM payments WHERE telegram_payment_charge_id = 'charge-pending-2'`,
    );
    expect(payment).toMatchObject({ status: 'processed', processed: true });
    expect(await countRows('users')).toBe(0);
  });

  it('не удалось ни доставить, ни вернуть: 409 refund_failed с контактом поддержки', async () => {
    const { userId } = await seedPersonalData();

    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, status, processed)
       VALUES ($1, NULL, 'one_149', 149, 'charge-pending-3', 'paid', false)`,
      [userId],
    );

    // Товар не доставлен (сбой выдачи), а вернуть нельзя: у платежа нет telegram_id.
    const payments = ctx.app.get(PaymentsService);
    const resolve = vi.spyOn(payments, 'resolvePending').mockRejectedValue(new Error('выдача не удалась'));

    try {
      const response = await request(ctx.app.getHttpServer())
        .delete('/api/v1/me')
        .set(INIT_DATA_HEADER, initDataFor())
        .expect(409);

      expect(response.body).toMatchObject({ code: 'CONFLICT', details: { reason: 'refund_failed' } });
      expect(response.body.message).toContain('@test_support');
      expect(await countRows('users')).toBe(1);
      expect(await countRows('charts')).toBe(1);
    } finally {
      resolve.mockRestore();
    }
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

/**
 * Блокер A (итерация 11): удаление данных не должно оставлять ключ, по
 * которому человек снова получает свои покупки.
 *
 * `user_id` — не случайный uuid, а `HMAC(pepper, "telegram:<id>")`: тот же
 * человек при первом входе получает тот же `user_id`. Пока старые строки
 * хранили его, подписка и права «воскресали» сами, без платежа.
 */
describe('DELETE /api/v1/me — возврат не восстанавливает покупки (блокер A)', () => {
  async function buyYear(userId: string, chargeId = 'charge-resurrect-1'): Promise<void> {
    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, invoice_payload, status, processed)
       VALUES ($1, $2, 'year_2990', 2990, $3, $4, 'processed', true)`,
      [userId, FICTIONAL_USER.id, chargeId, `p=year_2990&u=${userId}&k=resurrect`],
    );
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at, telegram_payment_charge_id)
       VALUES ($1, 'year', 'active', now() + interval '365 days', $2)`,
      [userId, chargeId],
    );
    await ctx.db.query(
      `INSERT INTO entitlements (user_id, kind, status) VALUES ($1, 'report', 'active')`,
      [userId],
    );
  }

  it('удалился → вернулся → ничего не прибавилось', async () => {
    const { userId } = await seedPersonalData();
    await buyYear(userId);

    const bought = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(bought.body.subscription).toMatchObject({ plan: 'year', is_active: true });
    expect(bought.body.entitlements.full_report).toBe(true);

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    // Тот же человек впервые открывает мини-апп. Тот же `user_id` — но ни
    // одной строки, которая на него указывает, не осталось.
    const back = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(back.body.user_id).toBe(userId);
    expect(back.body.is_new).toBe(true);
    expect(back.body.subscription).toMatchObject({
      plan: 'none',
      is_active: false,
      stars_paid_total: 0,
    });
    expect(back.body.entitlements).toMatchObject({
      is_active: false,
      full_forecast: false,
      full_report: false,
      full_report_chart_id: null,
    });
    expect(back.body.entitlements.ask_per_day).toBeLessThanOrEqual(1);
    expect(back.body.latest_report_id).toBeNull();

    // Подписка в базе отменена и обезличена, права отозваны.
    const subscription = await ctx.db.queryOne<{ user_id: string | null; status: string }>(
      `SELECT user_id::text AS user_id, status::text AS status FROM subscriptions`,
    );
    expect(subscription).toEqual({ user_id: null, status: 'cancelled' });

    const entitlement = await ctx.db.queryOne<{ user_id: string | null; status: string }>(
      `SELECT user_id::text AS user_id, status::text AS status FROM entitlements`,
    );
    expect(entitlement).toEqual({ user_id: null, status: 'revoked' });
  });

  it('после удаления ни одна строка не ссылается на user_id', async () => {
    const { userId } = await seedPersonalData();
    await buyYear(userId, 'charge-resurrect-2');

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    for (const table of ['payments', 'subscriptions', 'entitlements', 'events'] as const) {
      const row = await ctx.db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`,
        [userId],
      );
      expect(Number(row?.count ?? '0'), `${table}.user_id не должен указывать на удалённого`).toBe(0);
    }
  });

  it('возврат по charge_id удалённого платежа работает, событие без владельца', async () => {
    const { userId } = await seedPersonalData();
    await buyYear(userId, 'charge-resurrect-3');

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    // Поддержка возвращает звёзды после удаления: только charge_id и (для
    // Bot API) telegram_id из окна возврата — `user_id` уже NULL.
    const telegram = ctx.app.get(TelegramClient);
    const refundCall = vi.spyOn(telegram, 'refundStarPayment').mockResolvedValue(true);

    try {
      const payments = ctx.app.get(PaymentsService);
      const refunded = await payments.refund('charge-resurrect-3', 'support');

      expect(refunded).toBe(true);
      // Без telegram_id Bot API вернуть звёзды не может — он должен дойти.
      expect(refundCall).toHaveBeenCalledWith(Number(FICTIONAL_USER.id), 'charge-resurrect-3');
    } finally {
      refundCall.mockRestore();
    }

    const payment = await ctx.db.queryOne<{ status: string; refunded_at: Date | null }>(
      `SELECT status::text AS status, refunded_at FROM payments
        WHERE telegram_payment_charge_id = 'charge-resurrect-3'`,
    );
    expect(payment?.status).toBe('refunded');
    expect(payment?.refunded_at).not.toBeNull();

    const event = await ctx.db.queryOne<{ user_id: string | null; name: string }>(
      `SELECT user_id::text AS user_id, name FROM events
        WHERE name = 'refund_issued' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(event?.user_id).toBeNull();
    expect(event?.name).toBe('refund_issued');
  });

  it('full_report после возврата и новой карты — false, карта null', async () => {
    const { userId } = await seedPersonalData();
    await buyYear(userId, 'charge-resurrect-4');

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    const chart = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({
        birth_date: '1991-03-04',
        birth_time: '08:10',
        time_precision: 'exact',
        birth_place: { name: 'Казань', country: 'RU', lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' },
        consent: { accepted: true, version: '2026-11-10' },
      })
      .expect(201);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(me.body.entitlements.full_report).toBe(false);
    expect(me.body.entitlements.full_report_chart_id).toBeNull();

    // И заказ разбора на новую карту упирается в 402, а не в «уже оплачено».
    await request(ctx.app.getHttpServer())
      .post('/api/v1/reports')
      .set(INIT_DATA_HEADER, initDataFor())
      .set('Idempotency-Key', 'resurrect-order-key')
      .send({ chart_id: chart.body.chart.chart_id, type: 'full' })
      .expect(402);
  });
});
