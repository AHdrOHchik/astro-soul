import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  PLAN_CODES,
  type Me,
  type SubscriptionGrant,
  entitlementsForPlan,
  isPlanCode,
  isTestPlanCode,
} from '@astro-soul/shared';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { PaymentsService } from '../src/modules/billing/payments.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

/**
 * Тестовый тариф `test_1` (1 ⭐ за неделю).
 *
 * Задача не «поставить цену 1», а «тариф, которого нет в проде ни при каком
 * забытом флаге». Поэтому проверяется не только то, что он работает при
 * включённом `PAYMENTS_TEST_PLANS`, но и что при выключенном ответ неотличим
 * от несуществующего плана, из каталога он не вылезает ни в одном режиме, а
 * права и проверка суммы — те же, что у обычного тарифа.
 */

const BIRTH = {
  birth_date: '1993-07-21',
  birth_time: '09:40',
  time_precision: 'exact',
  birth_place: { name: 'Казань', country: 'RU', lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const WEBHOOK_PATH = `/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`;
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const CHAT_ID = 777_000_111;
const ADMIN_TG_ID = String(FICTIONAL_USER.id);

/** Флаг выключен (окружение по умолчанию): так выглядит прод. */
let off: TestContext;
let offTelegram: FakeTelegram;
/** Флаг включён: так выглядит стенд владельца. */
let on: TestContext;
let onTelegram: FakeTelegram;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

function client(ctx: TestContext): ReturnType<typeof request> {
  return request(ctx.app.getHttpServer());
}

/** Ответ `POST /billing/invoice`: либо инвойс (201), либо `Problem` (422). */
interface InvoiceResponse {
  readonly code?: string;
  readonly message?: string;
  readonly details?: unknown;
  readonly plan_code?: string;
  readonly stars?: number;
  readonly is_subscription?: boolean;
  readonly subscription_period_sec?: number | null;
}

async function invoice(
  ctx: TestContext,
  planCode: string,
  chartId?: string,
): Promise<{ status: number; body: InvoiceResponse }> {
  const response = await client(ctx)
    .post('/api/v1/billing/invoice')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) });

  return { status: response.status, body: response.body as InvoiceResponse };
}

/** Карта через подставной движок: `test_report_1` привязан к конкретной карте. */
async function createChart(ctx: TestContext, birth: typeof BIRTH = BIRTH): Promise<string> {
  const response = await client(ctx)
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(birth)
    .expect(201);

  return response.body.chart.chart_id as string;
}

/** `POST /reports`: 202 — заказ принят, 402 — разбор не оплачен. */
async function orderReport(ctx: TestContext, chartId: string): Promise<number> {
  const response = await client(ctx)
    .post('/api/v1/reports')
    .set(INIT_DATA_HEADER, initDataFor())
    .set('Idempotency-Key', randomUUID())
    .send({ chart_id: chartId, type: 'full' });

  return response.status;
}

async function payloadOf(ctx: TestContext): Promise<string> {
  const row = await ctx.db.queryOne<{ payload: string }>(
    `SELECT payload FROM invoices ORDER BY created_at DESC LIMIT 1`,
  );
  if (row === null) {
    throw new Error('инвойс не найден');
  }
  return row.payload;
}

async function sendPayment(
  ctx: TestContext,
  input: { payload: string; chargeId: string; amount: number; expiresAt?: number },
): Promise<number> {
  const response = await client(ctx)
    .post(WEBHOOK_PATH)
    .set(SECRET_HEADER, TEST_WEBHOOK_SECRET)
    .send({
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
    });

  return response.status;
}

async function me(ctx: TestContext): Promise<Me> {
  const response = await client(ctx).get('/api/v1/me').set(INIT_DATA_HEADER, initDataFor()).expect(200);
  return response.body as Me;
}

beforeAll(async () => {
  // Порядок важен: `createTestContext` выставляет переменные в `process.env`
  // и не откатывает их, поэтому контекст «флаг выключен» создаётся первым.
  offTelegram = makeFakeTelegram();
  off = await createTestContext({ astro: makeFakeAstro(), telegram: offTelegram });

  onTelegram = makeFakeTelegram();
  on = await createTestContext({
    astro: makeFakeAstro(),
    telegram: onTelegram,
    env: { PAYMENTS_TEST_PLANS: '1', ADMIN_TG_ID },
  });
});

afterAll(async () => {
  await on.close();
  await off.close();
});

beforeEach(async () => {
  await truncateAll(off.db);
  for (const telegram of [offTelegram, onTelegram]) {
    telegram.invoiceCalls.length = 0;
    telegram.messages.length = 0;
    telegram.refunds.length = 0;
    telegram.answers.length = 0;
  }
});

describe('PAYMENTS_TEST_PLANS выключен (прод)', () => {
  it('test_1 → 422, неотличимый от несуществующего плана', async () => {
    const test = await invoice(off, 'test_1');
    const unknown = await invoice(off, 'no_such_plan');

    expect(test.status).toBe(422);
    expect(test.body.code).toBe('VALIDATION_FAILED');
    expect(test.body.details).toMatchObject({ field_errors: [{ field: 'plan_code' }] });

    // Тот же ответ, что на код, которого нет: включённый флаг нельзя
    // «нащупать» по тексту ошибки.
    expect(test.body.code).toBe(unknown.body.code);
    expect(test.body.message).toBe(unknown.body.message);
    expect(test.body.details).toEqual(unknown.body.details);

    // Инвойс не создан, Bot API не звали.
    expect(offTelegram.invoiceCalls).toHaveLength(0);
    const count = await off.db.queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM invoices`);
    expect(count?.total).toBe(0);
  });

  it('оплата по уже выставленному счёту проходит — флаг не запирает деньги', async () => {
    // Счёт выставлен на стенде (флаг включён)…
    await invoice(on, 'test_1');
    const payload = await payloadOf(off);

    // …а платёж приходит, когда флаг уже выключили. Отказать здесь значило бы
    // взять звезду и не дать доступ: инвойс настоящий, сумма сходится.
    expect(await sendPayment(off, { payload, chargeId: 'charge-flag-off', amount: 1 })).toBe(200);

    const state = await me(off);
    expect(state.entitlements).toMatchObject({ is_active: true, full_forecast: true });
    expect(state.subscription).toMatchObject({ is_active: true, plan: 'month' });

    const payment = await off.db.queryOne<{ is_test: boolean; status: string }>(
      `SELECT is_test, status FROM payments WHERE telegram_payment_charge_id = 'charge-flag-off'`,
    );
    expect(payment).toMatchObject({ is_test: true, status: 'processed' });
  });
});

describe('PAYMENTS_TEST_PLANS=1 (стенд владельца)', () => {
  it('создаёт счёт на 1 ⭐ с недельным периодом', async () => {
    const created = await invoice(on, 'test_1');

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      plan_code: 'test_1',
      stars: 1,
      is_subscription: true,
      subscription_period_sec: 604_800,
    });

    const call = onTelegram.invoiceCalls[0];
    expect(call?.prices).toEqual([{ label: 'Тест', amount: 1 }]);
    expect(call?.subscriptionPeriod).toBe(604_800);
    // payload тот же, что у обычного тарифа: план + псевдоним + ключ.
    expect(Object.keys(JSON.parse(call?.payload ?? '{}'))).toEqual(['p', 'u', 'k']);
    expect(JSON.parse(call?.payload ?? '{}').p).toBe('test_1');
  });

  it('1 ⭐ даёт права month_399: plan=month, +7 дней, 5 вопросов в день', async () => {
    await invoice(on, 'test_1');
    const payload = await payloadOf(on);
    const before = Date.now();

    await sendPayment(on, { payload, chargeId: 'charge-test-ok', amount: 1 });

    const state = await me(on);
    expect(state.subscription).toMatchObject({ is_active: true, plan: 'month', auto_renew: true });
    // Одна звезда — не одна неделя в базе: срок считается от периода плана.
    const expiresAtIso = state.subscription?.expires_at ?? null;
    expect(expiresAtIso).not.toBeNull();
    const expiresAt = new Date(expiresAtIso ?? 0).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000 - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(before + 7 * 24 * 3600 * 1000 + 60_000);

    expect(state.entitlements).toMatchObject({
      is_active: true,
      full_forecast: true,
      ask_per_day: 5,
      compat_per_month: 1,
      solar_included: false,
    });

    // Права — ровно права месяца: «тестовость» живёт в учёте, не в доступе.
    // Обе строки читаются из БД: в коде прав и цен больше нет.
    const grants = await on.db.query<{ code: string; grants: SubscriptionGrant }>(
      `SELECT code, grants FROM plans WHERE code IN ('month_399', 'test_1')`,
    );
    const byCode = new Map(grants.map((row) => [row.code, row.grants]));
    const rightsOf = (grantsValue: SubscriptionGrant | undefined) =>
      entitlementsForPlan({ kind: 'subscription', subscriptionPlan: 'month', grants: grantsValue });

    expect(rightsOf(byCode.get('test_1'))).toEqual(rightsOf(byCode.get('month_399')));
    expect(rightsOf(byCode.get('test_1'))).toMatchObject({ fullForecast: true, askPerDay: 5 });

    const payment = await on.db.queryOne<{ is_test: boolean; total_amount: number }>(
      `SELECT is_test, total_amount FROM payments WHERE telegram_payment_charge_id = 'charge-test-ok'`,
    );
    expect(payment).toMatchObject({ is_test: true, total_amount: 1 });
  });

  it('проверка суммы не ослаблена: 2 ⭐ за test_1 → отказ amount_mismatch', async () => {
    await invoice(on, 'test_1');
    const payload = await payloadOf(on);

    await sendPayment(on, { payload, chargeId: 'charge-test-wrong', amount: 2 });

    const payment = await on.db.queryOne<{
      status: string;
      reject_reason: string;
      is_test: boolean;
    }>(
      `SELECT status, reject_reason, is_test FROM payments
        WHERE telegram_payment_charge_id = 'charge-test-wrong'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'amount_mismatch', is_test: true });

    const state = await me(on);
    expect(state.entitlements?.is_active).toBe(false);
  });

  it('метрики считают тестовый платёж отдельно: не выручка, не конверсия', async () => {
    await invoice(on, 'test_1');
    const payload = await payloadOf(on);
    await sendPayment(on, { payload, chargeId: 'charge-test-metrics', amount: 1 });

    const response = await client(on)
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.test_payments_30d).toBe(1);
    // Тестовая звезда не выручка и не платящий пользователь.
    expect(response.body.stars_received_30d).toBe(0);
    expect(response.body.paying).toBe(0);
    expect(response.body.conversion_to_paid).toBe(0);
  });

  it('возврат 1 ⭐ работает и отзывает доступ', async () => {
    await invoice(on, 'test_1');
    const payload = await payloadOf(on);
    await sendPayment(on, { payload, chargeId: 'charge-test-refund', amount: 1 });

    const payments = on.app.get(PaymentsService);
    expect(await payments.refund('charge-test-refund', 'qa_support_request')).toBe(true);

    expect(onTelegram.refunds).toEqual([{ userId: CHAT_ID, chargeId: 'charge-test-refund' }]);

    const payment = await on.db.queryOne<{ status: string; is_test: boolean }>(
      `SELECT status, is_test FROM payments WHERE telegram_payment_charge_id = 'charge-test-refund'`,
    );
    expect(payment).toMatchObject({ status: 'refunded', is_test: true });

    const state = await me(on);
    expect(state.entitlements?.is_active).toBe(false);

    // Повторный возврат того же платежа ничего не делает и не зовёт Bot API.
    expect(await payments.refund('charge-test-refund', 'qa_support_request')).toBe(false);
    expect(onTelegram.refunds).toHaveLength(1);
  });
});

describe('test_report_1 — разовый разбор за 1 ⭐', () => {
  it('без флага — 422, как на несуществующий план', async () => {
    const created = await createChart(off);
    const test = await invoice(off, 'test_report_1', created);
    const unknown = await invoice(off, 'no_such_plan', created);

    expect(test.status).toBe(422);
    expect(test.body.details).toEqual(unknown.body.details);
    expect(test.body.message).toBe(unknown.body.message);
    expect(offTelegram.invoiceCalls).toHaveLength(0);
  });

  it('с флагом — обычный разовый счёт: 1 ⭐, без subscription_period', async () => {
    const chartId = await createChart(on);
    const created = await invoice(on, 'test_report_1', chartId);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      plan_code: 'test_report_1',
      stars: 1,
      is_subscription: false,
      subscription_period_sec: null,
    });

    const call = onTelegram.invoiceCalls[0];
    expect(call?.prices).toEqual([{ label: 'Тест-разбор', amount: 1 }]);
    // Ключевое: без периода Telegram не сделает из разового товара подписку.
    expect(call?.subscriptionPeriod).toBeUndefined();
  });

  it('оплата 1 ⭐: доступ к разбору только на эту карту, вторая — цена', async () => {
    const paidChart = await createChart(on);
    const otherChart = await createChart(on, {
      ...BIRTH,
      birth_date: '1990-02-11',
      birth_place: { name: 'Сочи', country: 'RU', lat: 43.5855, lon: 39.7231, tz: 'Europe/Moscow' },
    });

    const created = await invoice(on, 'test_report_1', paidChart);
    const payload = await payloadOf(on);
    expect(created.status).toBe(201);

    await sendPayment(on, { payload, chargeId: 'charge-report-ok', amount: 1 });

    const state = await me(on);
    expect(state.entitlements).toMatchObject({
      full_report: true,
      full_report_chart_id: paidChart,
    });

    // «К разбору» — только на оплаченной карте; на второй цена (402).
    expect(await orderReport(on, paidChart)).toBe(202);
    expect(await orderReport(on, otherChart)).toBe(402);

    const payment = await on.db.queryOne<{ status: string; is_test: boolean; plan_code: string }>(
      `SELECT status, is_test, plan_code FROM payments WHERE telegram_payment_charge_id = 'charge-report-ok'`,
    );
    expect(payment).toMatchObject({ status: 'processed', is_test: true, plan_code: 'test_report_1' });
  });

  it('вторая покупка того же разбора: 422 и ни одного второго entitlement', async () => {
    const chartId = await createChart(on);
    await invoice(on, 'test_report_1', chartId);
    await sendPayment(on, { payload: await payloadOf(on), chargeId: 'charge-report-first', amount: 1 });

    const again = await invoice(on, 'test_report_1', chartId);
    expect(again.status).toBe(422);
    expect(again.body.details).toMatchObject({ field_errors: [{ field: 'chart_id' }] });

    const grants = await on.db.queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM entitlements WHERE kind = 'report' AND status = 'active'`,
    );
    expect(grants?.total).toBe(1);
  });

  it('защита от двойной покупки не привязана к цене: one_149 ведёт себя так же', async () => {
    const chartId = await createChart(on);
    await invoice(on, 'one_149', chartId);
    await sendPayment(on, { payload: await payloadOf(on), chargeId: 'charge-one-paid', amount: 149 });

    const again = await invoice(on, 'one_149', chartId);
    expect(again.status).toBe(422);
    expect(again.body.details).toMatchObject({ field_errors: [{ field: 'chart_id' }] });

    const grants = await on.db.queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM entitlements WHERE kind = 'report' AND status = 'active'`,
    );
    expect(grants?.total).toBe(1);
  });

  it('проверка суммы не ослаблена: 2 ⭐ за test_report_1 → отказ', async () => {
    const chartId = await createChart(on);
    await invoice(on, 'test_report_1', chartId);

    await sendPayment(on, { payload: await payloadOf(on), chargeId: 'charge-report-wrong', amount: 2 });

    const payment = await on.db.queryOne<{ status: string; reject_reason: string; is_test: boolean }>(
      `SELECT status, reject_reason, is_test FROM payments
        WHERE telegram_payment_charge_id = 'charge-report-wrong'`,
    );
    expect(payment).toMatchObject({ status: 'rejected', reject_reason: 'amount_mismatch', is_test: true });

    const state = await me(on);
    expect(state.entitlements?.full_report).toBe(false);
  });

  it('возврат 1 ⭐ отзывает доступ и разрешает покупку снова', async () => {
    const chartId = await createChart(on);
    await invoice(on, 'test_report_1', chartId);
    await sendPayment(on, { payload: await payloadOf(on), chargeId: 'charge-report-refund', amount: 1 });

    const payments = on.app.get(PaymentsService);
    expect(await payments.refund('charge-report-refund', 'qa_support_request')).toBe(true);

    const state = await me(on);
    expect(state.entitlements?.full_report).toBe(false);
    expect(state.entitlements?.full_report_chart_id).toBeNull();
    expect(await orderReport(on, chartId)).toBe(402);

    // После возврата доступ отозван — тот же разбор можно купить заново.
    const again = await invoice(on, 'test_report_1', chartId);
    expect(again.status).toBe(201);
  });

  it('метрики: тестовый разбор отдельно и вне выручки', async () => {
    const chartId = await createChart(on);
    await invoice(on, 'test_report_1', chartId);
    await sendPayment(on, { payload: await payloadOf(on), chargeId: 'charge-report-metrics', amount: 1 });

    const response = await client(on)
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.test_payments_30d).toBe(1);
    expect(response.body.stars_received_30d).toBe(0);
  });
});

describe('каталог', () => {
  it('test_1 нет ни в каталоге, ни в порядке пейволла, ни в контракте', () => {
    expect(PLAN_CODES).not.toContain('test_1');
    expect(isPlanCode('test_1')).toBe(false);
    expect(isTestPlanCode('test_1')).toBe(true);

    // Контракт — источник правды для клиента: расширять его ради теста нельзя,
    // иначе код тестового тарифа появится в сгенерированных типах фронта.
    const contract = readFileSync(join(__dirname, '../../../api.openapi.yaml'), 'utf8');
    const planCodeEnum = /^ {4}PlanCode:\n(?:.*\n)*? {6}enum: \[([^\]]*)\]/m.exec(contract)?.[1] ?? '';
    expect(planCodeEnum).not.toBe('');
    expect(planCodeEnum).not.toContain('test_1');
  });

  it('строка plans: test_only = true, is_active = false (сид)', async () => {
    const row = await off.db.queryOne<{ test_only: boolean; is_active: boolean; stars: number }>(
      `SELECT test_only, is_active, stars FROM plans WHERE code = 'test_1'`,
    );
    // Строка нужна: на `plans.code` ссылаются invoices и payments.
    expect(row).toMatchObject({ test_only: true, is_active: false, stars: 1 });
  });
});
