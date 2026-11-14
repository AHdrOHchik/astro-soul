import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { PaymentsService } from '../src/modules/billing/payments.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

const CHAT_ID = 777_000_111;
const WEBHOOK_PATH = `/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`;
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

let ctx: TestContext;
let telegram: FakeTelegram;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

async function createInvoice(
  planCode: string,
  chartId?: string,
): Promise<{ payload: string; invoiceLink: string }> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/billing/invoice')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) })
    .expect(201);

  const invoice = await ctx.db.queryOne<{ payload: string; invoice_link: string }>(
    `SELECT payload, invoice_link FROM invoices ORDER BY created_at DESC LIMIT 1`,
  );

  if (invoice === null) {
    throw new Error('инвойс не найден');
  }

  expect(invoice.invoice_link).toBe(response.body.invoice_link);
  return { payload: invoice.payload, invoiceLink: invoice.invoice_link };
}

async function sendWebhook(update: unknown, headers: Record<string, string> = {}): Promise<number> {
  const response = await request(ctx.app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set({ [SECRET_HEADER]: TEST_WEBHOOK_SECRET, ...headers })
    .send(update as object);

  return response.status;
}

function successfulPayment(input: {
  payload: string;
  chargeId: string;
  amount: number;
  expiresAt?: number;
}): unknown {
  return {
    update_id: 1,
    message: {
      chat: { id: CHAT_ID },
      from: { id: CHAT_ID },
      successful_payment: {
        currency: 'XTR',
        total_amount: input.amount,
        invoice_payload: input.payload,
        telegram_payment_charge_id: input.chargeId,
        provider_payment_charge_id: `provider-${input.chargeId}`,
        ...(input.expiresAt === undefined ? {} : { subscription_expiration_date: input.expiresAt }),
      },
    },
  };
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({ astro: makeFakeAstro(), telegram });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.messages.length = 0;
  telegram.answers.length = 0;
  telegram.refunds.length = 0;
  telegram.invoiceCalls.length = 0;
});

describe('вебхук Telegram', () => {
  it('без правильного секрета → 403, обработка не запускается', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/telegram/webhook/wrong-secret')
      .set(SECRET_HEADER, TEST_WEBHOOK_SECRET)
      .send({ update_id: 1 })
      .expect(403);

    await request(ctx.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send({ update_id: 1 })
      .expect(403);

    await request(ctx.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set(SECRET_HEADER, 'wrong-header-value')
      .send({ update_id: 1 })
      .expect(403);
  });

  it('pre_checkout_query: валидный payload → ok=true, битый → ok=false', async () => {
    const { payload } = await createInvoice('month_399');

    expect(
      await sendWebhook({
        update_id: 1,
        pre_checkout_query: {
          id: 'pcq-1',
          from: { id: CHAT_ID },
          currency: 'XTR',
          total_amount: 399,
          invoice_payload: payload,
        },
      }),
    ).toBe(200);

    expect(
      await sendWebhook({
        update_id: 2,
        pre_checkout_query: {
          id: 'pcq-2',
          from: { id: CHAT_ID },
          currency: 'XTR',
          total_amount: 399,
          invoice_payload: '{"p":"не-план"}',
        },
      }),
    ).toBe(200);

    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-1', ok: true });
    expect(telegram.answers[1]).toMatchObject({ queryId: 'pcq-2', ok: false });
  });

  it('successful_payment подписки: платёж, подписка, инвойс, сообщение', async () => {
    const { payload } = await createInvoice('month_399');
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

    expect(
      await sendWebhook(
        successfulPayment({ payload, chargeId: 'charge-month-1', amount: 399, expiresAt }),
      ),
    ).toBe(200);

    const payment = await ctx.db.queryOne<{ processed: boolean; status: string; telegram_id: string }>(
      `SELECT processed, status, telegram_id::text AS telegram_id FROM payments WHERE telegram_payment_charge_id = 'charge-month-1'`,
    );
    expect(payment).toMatchObject({ processed: true, status: 'processed' });

    const subscription = await ctx.db.queryOne<{ plan: string; status: string; expires_at: Date }>(
      `SELECT plan, status, expires_at FROM subscriptions`,
    );
    expect(subscription?.plan).toBe('month');
    expect(subscription?.status).toBe('active');
    expect(subscription?.expires_at.getTime()).toBe(expiresAt * 1000);

    const invoice = await ctx.db.queryOne<{ status: string }>(`SELECT status FROM invoices`);
    expect(invoice?.status).toBe('paid');

    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]?.text).toContain('399');

    const event = await ctx.db.queryOne<{ name: string }>(
      `SELECT name FROM events WHERE name = 'payment_processed'`,
    );
    expect(event?.name).toBe('payment_processed');

    // Доступ в /me подтверждается только через getEntitlements.
    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(me.body.subscription).toMatchObject({ plan: 'month', is_active: true });
  });

  it('повторная доставка того же charge_id не выдаёт доступ второй раз', async () => {
    const { payload } = await createInvoice('week_149');
    const update = successfulPayment({
      payload,
      chargeId: 'charge-week-1',
      amount: 149,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    });

    expect(await sendWebhook(update)).toBe(200);
    const firstExpires = (
      await ctx.db.queryOne<{ expires_at: Date }>(`SELECT expires_at FROM subscriptions`)
    )?.expires_at.getTime();

    expect(await sendWebhook(update)).toBe(200);

    const payments = await ctx.db.query(`SELECT 1 FROM payments`);
    expect(payments).toHaveLength(1);
    expect(telegram.messages).toHaveLength(1);

    const secondExpires = (
      await ctx.db.queryOne<{ expires_at: Date }>(`SELECT expires_at FROM subscriptions`)
    )?.expires_at.getTime();
    expect(secondExpires).toBe(firstExpires);
  });

  it('продление: новый срок сдвигает expires_at вперёд и пишет событие', async () => {
    const first = await createInvoice('month_399');
    await sendWebhook(
      successfulPayment({
        payload: first.payload,
        chargeId: 'charge-month-2',
        amount: 399,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      }),
    );

    const second = await createInvoice('year_2990');
    const laterExpiry = Math.floor(Date.now() / 1000) + 400 * 24 * 3600;
    await sendWebhook(
      successfulPayment({
        payload: second.payload,
        chargeId: 'charge-year-1',
        amount: 2990,
        expiresAt: laterExpiry,
      }),
    );

    const subscription = await ctx.db.queryOne<{ plan: string; expires_at: Date }>(
      `SELECT plan, expires_at FROM subscriptions`,
    );
    expect(subscription?.plan).toBe('year');
    expect(subscription?.expires_at.getTime()).toBe(laterExpiry * 1000);

    const renewed = await ctx.db.queryOne<{ name: string }>(
      `SELECT name FROM events WHERE name = 'subscription_renewed'`,
    );
    expect(renewed?.name).toBe('subscription_renewed');
  });

  it('разовый разбор создаёт entitlement на карту', async () => {
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
    const { payload } = await createInvoice('one_149', chartId);

    await sendWebhook(
      successfulPayment({ payload, chargeId: 'charge-report-1', amount: 149 }),
    );

    const entitlement = await ctx.db.queryOne<{ kind: string; chart_id: string | null; status: string }>(
      `SELECT kind, chart_id, status FROM entitlements`,
    );
    expect(entitlement).toMatchObject({ kind: 'report', status: 'active', chart_id: chartId });
  });

  it('битый payload (не UUID): 200, платёж записан как rejected, без 500', async () => {
    const status = await sendWebhook(
      successfulPayment({
        payload: '{"p":"month_399","u":"не-uuid","k":"тоже"}',
        chargeId: 'charge-malformed',
        amount: 399,
      }),
    );

    expect(status).toBe(200);
    // QA-11: отказ по деньгам обязан быть виден, а не теряться в логах.
    const payment = await ctx.db.queryOne<{ status: string; reject_reason: string; processed: boolean }>(
      `SELECT status, reject_reason, processed FROM payments WHERE telegram_payment_charge_id = 'charge-malformed'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'unknown_plan', processed: false });
    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);
    expect(telegram.messages).toHaveLength(0);
  });

  it('неизвестный план в payload: 200, доступ не выдан, платёж записан как rejected', async () => {
    expect(
      await sendWebhook(
        successfulPayment({ payload: '{"p":"nope","u":"00000000-0000-4000-8000-000000000000","k":"1"}', chargeId: 'charge-bad', amount: 1 }),
      ),
    ).toBe(200);

    const payment = await ctx.db.queryOne<{ status: string; reject_reason: string }>(
      `SELECT status, reject_reason FROM payments WHERE telegram_payment_charge_id = 'charge-bad'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'unknown_plan' });
  });
});

describe('QA-11: доступ только за платёж, который выставлял сервер', () => {
  /** `/me` глазами пользователя: подписка и entitlements считаются сервером. */
  async function meBody(): Promise<{
    subscription: { plan: string; is_active: boolean };
    entitlements: { is_active: boolean; full_forecast: boolean };
  }> {
    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    return me.body as { subscription: { plan: string; is_active: boolean }; entitlements: { is_active: boolean; full_forecast: boolean } };
  }

  /** Внутренний UUID пользователя: в payload инвойса едет именно он. */
  async function internalUserId(): Promise<string> {
    const row = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    if (row === null) {
      throw new Error('пользователь не создан: сначала нужен любой запрос от него');
    }
    return row.id;
  }

  async function rejectionEvents(): Promise<{ props: { code?: string } }[]> {
    return ctx.db.query<{ props: { code?: string } }>(
      `SELECT props FROM events WHERE name = 'payment_rejected' ORDER BY created_at`,
    );
  }

  it('инвойса нет: доступ не выдан, платёж rejected (no_invoice), /me без подписки', async () => {
    await meBody();
    const payload = JSON.stringify({
      p: 'year_2990',
      u: await internalUserId(),
      k: '00000000-0000-4000-8000-00000000dead',
    });

    expect(
      await sendWebhook(
        successfulPayment({ payload, chargeId: 'charge-no-invoice', amount: 1, expiresAt: Math.floor(Date.now() / 1000) + 31_536_000 }),
      ),
    ).toBe(200);

    const payment = await ctx.db.queryOne<{ status: string; reject_reason: string; processed: boolean }>(
      `SELECT status, reject_reason, processed FROM payments WHERE telegram_payment_charge_id = 'charge-no-invoice'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'no_invoice', processed: false });

    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);
    expect(await ctx.db.query(`SELECT 1 FROM entitlements`)).toHaveLength(0);
    expect(await meBody()).toMatchObject({
      subscription: { plan: 'none', is_active: false },
      entitlements: { is_active: false, full_forecast: false },
    });
    expect(telegram.messages).toHaveLength(0);
    expect(await rejectionEvents()).toEqual([{ props: expect.objectContaining({ code: 'no_invoice' }) }]);
  });

  it('сумма меньше цены плана: rejected (amount_mismatch), доступа нет', async () => {
    const { payload } = await createInvoice('month_399');

    expect(
      await sendWebhook(successfulPayment({ payload, chargeId: 'charge-underpaid', amount: 1 })),
    ).toBe(200);

    const payment = await ctx.db.queryOne<{ status: string; reject_reason: string }>(
      `SELECT status, reject_reason FROM payments WHERE telegram_payment_charge_id = 'charge-underpaid'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'amount_mismatch' });
    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);
    expect((await meBody()).subscription.is_active).toBe(false);
    expect(await rejectionEvents()).toEqual([{ props: expect.objectContaining({ code: 'amount_mismatch' }) }]);
  });

  it('сумма больше цены плана: rejected (amount_mismatch), доступа нет', async () => {
    const { payload } = await createInvoice('month_399');

    expect(
      await sendWebhook(successfulPayment({ payload, chargeId: 'charge-overpaid', amount: 400 })),
    ).toBe(200);

    const payment = await ctx.db.queryOne<{ status: string; reject_reason: string }>(
      `SELECT status, reject_reason FROM payments WHERE telegram_payment_charge_id = 'charge-overpaid'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'amount_mismatch' });
    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);
    expect((await meBody()).subscription.is_active).toBe(false);
  });

  it('обычный платёж по выставленному инвойсу: доступ есть, платёж processed', async () => {
    const { payload } = await createInvoice('month_399');
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

    expect(
      await sendWebhook(successfulPayment({ payload, chargeId: 'charge-honest', amount: 399, expiresAt })),
    ).toBe(200);

    const payment = await ctx.db.queryOne<{ status: string; processed: boolean; reject_reason: string | null }>(
      `SELECT status, processed, reject_reason FROM payments WHERE telegram_payment_charge_id = 'charge-honest'`,
    );
    expect(payment).toMatchObject({ status: 'processed', processed: true, reject_reason: null });
    expect((await meBody()).subscription).toMatchObject({ plan: 'month', is_active: true });
    expect(await rejectionEvents()).toHaveLength(0);
  });

  it('повторная доставка rejected-платежа не выдаёт доступ и не плодит строки', async () => {
    const { payload } = await createInvoice('week_149');
    const update = successfulPayment({ payload, chargeId: 'charge-retry-rejected', amount: 1 });

    expect(await sendWebhook(update)).toBe(200);
    expect(await sendWebhook(update)).toBe(200);

    const payments = await ctx.db.query<{ status: string; reject_reason: string }>(
      `SELECT status, reject_reason FROM payments`,
    );
    expect(payments).toEqual([{ status: 'rejected', reject_reason: 'amount_mismatch' }]);
    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);
    expect(await rejectionEvents()).toHaveLength(1);
    expect(telegram.messages).toHaveLength(0);
  });
});

describe('R-1: продление без subscription_expiration_date', () => {
  it('три оплаты без даты от Telegram дают три периода, а не один', async () => {
    const { payload } = await createInvoice('month_399');

    for (const n of [1, 2, 3]) {
      expect(
        await sendWebhook(successfulPayment({ payload, chargeId: `charge-no-expiry-${n}`, amount: 399 })),
      ).toBe(200);
    }

    const subscription = await ctx.db.queryOne<{ expires_at: Date }>(`SELECT expires_at FROM subscriptions`);
    const days = (subscription!.expires_at.getTime() - Date.now()) / (24 * 3600 * 1000);
    // 3 × 30 дней, допуск на часы прогона: раньше было бы ровно 30.
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });
});

describe('возвраты', () => {
  it('refundStarPayment + отзыв доступа', async () => {
    // С 1.5.2 разовый разбор покупается на конкретную карту.
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

    const { payload } = await createInvoice('one_149', chart.body.chart.chart_id as string);
    await sendWebhook(successfulPayment({ payload, chargeId: 'charge-refund-1', amount: 149 }));

    const service = ctx.app.get(PaymentsService);
    const ok = await service.refund('charge-refund-1', 'not_delivered');

    expect(ok).toBe(true);
    expect(telegram.refunds).toEqual([{ userId: CHAT_ID, chargeId: 'charge-refund-1' }]);

    const payment = await ctx.db.queryOne<{ status: string; refunded_at: Date | null }>(
      `SELECT status, refunded_at FROM payments`,
    );
    expect(payment?.status).toBe('refunded');
    expect(payment?.refunded_at).not.toBeNull();

    const entitlement = await ctx.db.queryOne<{ status: string }>(
      `SELECT status FROM entitlements`,
    );
    expect(entitlement?.status).toBe('refunded');

    // Повторный возврат не проходит: платёж уже refunded.
    expect(await service.refund('charge-refund-1', 'again')).toBe(false);
    expect(telegram.refunds).toHaveLength(1);
  });
});
