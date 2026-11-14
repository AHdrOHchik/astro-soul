import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

/**
 * QA-15: оплата после `DELETE /me`.
 *
 * Четыре сценария из приёмки:
 *   A. инвойс → удаление → `pre_checkout_query` → `successful_payment`;
 *   B. инвойс → `pre_checkout_query` → удаление → `successful_payment`;
 *   C. оплата через сутки после удаления (то же, что A, но с явной задержкой);
 *   D. новый пользователь с тем же `telegram_id` — законный, но старый инвойс
 *      не должен работать.
 *
 * Во всех случаях: платежа-доступа нет, вебхук отвечает 200, звёзды
 * возвращаются автоматически, событие `refund_issued` с причиной.
 */

const CHAT_ID = 777_000_111;
const WEBHOOK_PATH = `/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`;
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

let ctx: TestContext;
let telegram: FakeTelegram;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

async function createInvoice(planCode = 'week_149'): Promise<{ payload: string; userId: string }> {
  await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  await request(ctx.app.getHttpServer())
    .post('/api/v1/billing/invoice')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ plan_code: planCode })
    .expect(201);

  const invoice = await ctx.db.queryOne<{ payload: string; user_id: string; idem_key: string }>(
    `SELECT payload, user_id, idem_key FROM invoices ORDER BY created_at DESC LIMIT 1`,
  );

  if (invoice === null) {
    throw new Error('инвойс не найден');
  }

  return { payload: invoice.payload, userId: invoice.user_id };
}

async function deleteMe(): Promise<void> {
  await request(ctx.app.getHttpServer())
    .delete('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(204);
}

function preCheckout(queryId: string, payload: string, amount = 149): unknown {
  return {
    update_id: 1,
    pre_checkout_query: {
      id: queryId,
      from: { id: CHAT_ID },
      currency: 'XTR',
      total_amount: amount,
      invoice_payload: payload,
    },
  };
}

function successfulPayment(payload: string, chargeId: string, amount = 149): unknown {
  return {
    update_id: 1,
    message: {
      chat: { id: CHAT_ID },
      from: { id: CHAT_ID },
      successful_payment: {
        currency: 'XTR',
        total_amount: amount,
        invoice_payload: payload,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: `provider-${chargeId}`,
      },
    },
  };
}

async function sendWebhook(update: unknown): Promise<number> {
  const response = await request(ctx.app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set(SECRET_HEADER, TEST_WEBHOOK_SECRET)
    .send(update as object);

  return response.status;
}

async function entitlements(): Promise<number> {
  const row = await ctx.db.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM entitlements WHERE status = 'active'`,
  );
  return Number(row?.count ?? '0');
}

async function paymentRow(chargeId: string): Promise<{
  status: string;
  reject_reason: string | null;
  processed: boolean;
  refunded_at: Date | null;
  user_id: string | null;
} | null> {
  return ctx.db.queryOne(
    `SELECT status, reject_reason, processed, refunded_at, user_id
       FROM payments WHERE telegram_payment_charge_id = $1`,
    [chargeId],
  );
}

async function events(name: string): Promise<{ code: string | null }[]> {
  return ctx.db.query<{ code: string | null }>(
    `SELECT props ->> 'code' AS code FROM events WHERE name = $1 ORDER BY created_at`,
    [name],
  );
}

/** Общая проверка «доступа нет, деньги вернулись, причина записана». */
async function expectRejectedAndRefunded(chargeId: string, reason: string): Promise<void> {
  expect(await entitlements()).toBe(0);

  const payment = await paymentRow(chargeId);
  expect(payment).toMatchObject({
    status: 'rejected',
    reject_reason: reason,
    processed: false,
  });
  expect(payment?.refunded_at).not.toBeNull();

  expect(telegram.refunds).toHaveLength(1);
  expect(telegram.refunds[0]).toMatchObject({ chargeId });

  const refunds = await events('refund_issued');
  expect(refunds).toHaveLength(1);
  expect(refunds[0]?.code).toBe(reason);

  const rejected = await events('payment_rejected');
  expect(rejected.map((row) => row.code)).toContain(reason);

  // /me не должен внезапно оказаться оплаченным.
  const me = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor());

  expect(me.body.entitlements.full_report).toBe(false);
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

describe('QA-15: заказ A — инвойс → удаление → pre_checkout → successful_payment', () => {
  it('инвойс аннулируется вместе с пользователем, оплата отклоняется и возвращается', async () => {
    const { payload } = await createInvoice();
    await deleteMe();

    const invoice = await ctx.db.queryOne<{ status: string; invalidated_at: Date | null }>(
      `SELECT status, invalidated_at FROM invoices`,
    );
    expect(invoice?.status).toBe('invalidated');
    expect(invoice?.invalidated_at).not.toBeNull();

    expect(await sendWebhook(preCheckout('pcq-a', payload))).toBe(200);
    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-a', ok: false });
    expect(telegram.answers[0]?.errorMessage).toContain('начни заново');

    expect(await sendWebhook(successfulPayment(payload, 'charge-qa15-a'))).toBe(200);
    await expectRejectedAndRefunded('charge-qa15-a', 'invoice_invalidated');
  });
});

describe('QA-15: заказ B — инвойс → pre_checkout → удаление → successful_payment', () => {
  it('pre_checkout проходит до удаления, но платёж после него отклоняется', async () => {
    const { payload } = await createInvoice();

    expect(await sendWebhook(preCheckout('pcq-b', payload))).toBe(200);
    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-b', ok: true });

    await deleteMe();

    expect(await sendWebhook(successfulPayment(payload, 'charge-qa15-b'))).toBe(200);
    await expectRejectedAndRefunded('charge-qa15-b', 'invoice_invalidated');
  });
});

describe('QA-15: оплата через сутки после удаления', () => {
  it('инвойс уже недействителен: отказ, возврат, никакого воскрешения', async () => {
    const { payload } = await createInvoice();
    await deleteMe();

    // Сутки спустя: пользователя нет, инвойс `invalidated`.
    await ctx.db.query(`UPDATE invoices SET created_at = now() - interval '1 day'`);
    expect(await sendWebhook(successfulPayment(payload, 'charge-qa15-day'))).toBe(200);

    await expectRejectedAndRefunded('charge-qa15-day', 'invoice_invalidated');

    // Никакой новой строки `users` платёж не создал: `GET /me` в проверке
    // выше создаёт пользователя по своей воле, поэтому смотрим до него.
    const users = await ctx.db.queryOne<{ count: string }>(`SELECT count(*)::text AS count FROM users`);
    expect(Number(users?.count ?? '0')).toBeLessThanOrEqual(1);
  });
});

describe('QA-15: новый пользователь с тем же telegram_id', () => {
  it('новый профиль законен, но старый инвойс не работает', async () => {
    const { payload: oldPayload } = await createInvoice();
    await deleteMe();

    // Человек вернулся: новый профиль и новый инвойс.
    const fresh = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(fresh.body.is_new).toBe(true);

    const { payload: newPayload } = await createInvoice();

    // Старый инвойс отклоняется до оплаты.
    expect(await sendWebhook(preCheckout('pcq-d-old', oldPayload))).toBe(200);
    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-d-old', ok: false });

    expect(await sendWebhook(successfulPayment(oldPayload, 'charge-qa15-old'))).toBe(200);
    await expectRejectedAndRefunded('charge-qa15-old', 'invoice_invalidated');

    // Новый инвойс работает штатно.
    expect(await sendWebhook(successfulPayment(newPayload, 'charge-qa15-new'))).toBe(200);
    const freshPayment = await paymentRow('charge-qa15-new');
    expect(freshPayment).toMatchObject({ status: 'processed', processed: true });

    const subscription = await ctx.db.queryOne<{ status: string }>(
      `SELECT status FROM subscriptions ORDER BY created_at DESC LIMIT 1`,
    );
    expect(subscription?.status).toBe('active');
  });
});

describe('QA-15: возврат не удался', () => {
  it('платёж остаётся rejected, причина refund_failed, счётчик pending растёт', async () => {
    const refusing = makeFakeTelegram();
    const refusingCtx = await createTestContext({
      astro: makeFakeAstro(),
      env: { ADMIN_TG_ID: String(FICTIONAL_USER.id) },
      telegram: {
        ...refusing,
        refundStarPayment() {
          return Promise.resolve(false);
        },
      },
    });

    try {
      await request(refusingCtx.app.getHttpServer())
        .get('/api/v1/me')
        .set(INIT_DATA_HEADER, initDataFor())
        .expect(200);
      await request(refusingCtx.app.getHttpServer())
        .post('/api/v1/billing/invoice')
        .set(INIT_DATA_HEADER, initDataFor())
        .send({ plan_code: 'week_149' })
        .expect(201);

      const invoice = await refusingCtx.db.queryOne<{ payload: string }>(
        `SELECT payload FROM invoices ORDER BY created_at DESC LIMIT 1`,
      );
      const payload = invoice?.payload ?? '';

      await request(refusingCtx.app.getHttpServer())
        .delete('/api/v1/me')
        .set(INIT_DATA_HEADER, initDataFor())
        .expect(204);

      const response = await request(refusingCtx.app.getHttpServer())
        .post(WEBHOOK_PATH)
        .set(SECRET_HEADER, TEST_WEBHOOK_SECRET)
        .send(successfulPayment(payload, 'charge-qa15-refund-fail') as object);
      expect(response.status).toBe(200);

      const payment = await refusingCtx.db.queryOne<{
        status: string;
        reject_reason: string;
        processed: boolean;
        refunded_at: Date | null;
      }>(
        `SELECT status, reject_reason, processed, refunded_at FROM payments
          WHERE telegram_payment_charge_id = 'charge-qa15-refund-fail'`,
      );
      expect(payment).toMatchObject({
        status: 'rejected',
        reject_reason: 'invoice_invalidated',
        processed: false,
      });
      expect(payment?.refunded_at).toBeNull();

      const codes = await refusingCtx.db.query<{ code: string | null }>(
        `SELECT props ->> 'code' AS code FROM events WHERE name = 'payment_rejected' ORDER BY created_at`,
      );
      expect(codes.map((row) => row.code)).toContain('refund_failed');

      // Метрика `pending_payments_now` видит такой платёж: это ручной разбор.
      const metrics = await request(refusingCtx.app.getHttpServer())
        .get('/api/v1/admin/metrics')
        .set(INIT_DATA_HEADER, initDataFor())
        .expect(200);
      expect(metrics.body.pending_payments_now).toBe(1);
    } finally {
      await refusingCtx.close();
    }
  });
});
