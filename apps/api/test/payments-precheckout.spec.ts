import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { JsonLogger, redact } from '../src/common/logger';
import { PaymentsService, PRECHECKOUT_TARGET_MS } from '../src/modules/billing/payments.service';
import { PlansRepository } from '../src/modules/billing/plans.repository';
import { BillingRepository } from '../src/modules/billing/billing.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

/**
 * Итерация 25: «оплата не доходит до конца».
 *
 * Блокер был не в бизнес-логике, а в том, что `pre_checkout_query` мог
 * остаться без ответа: обработчик не имел ни срока, ни try/catch. Здесь
 * проверяется ровно то, из-за чего человек видел «ошибка оплаты»:
 *   • любой сбой проверки → ответ Telegram всё равно уходит, с текстом;
 *   • сумма сверяется со снимком в счёте, а не с текущей ценой плана;
 *   • аннулированный счёт отклоняется со своей причиной;
 *   • параллельные запросы оба получают ответ;
 *   • `successful_payment`: доступ не теряется ни при исключении, ни при
 *     недоступном Telegram на шаге сообщения; повтор не плодит доступ.
 */

const CHAT_ID = 777_000_222;
const WEBHOOK_PATH = `/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`;
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

let ctx: TestContext;
let telegram: FakeTelegram;
let logger: JsonLogger;
let logLines: string[];

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

/** Перехват логов: проверяем строки, которые реально ушли бы в stdout. */
function spyOnLogs(): void {
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation(((message: string, fields: Record<string, unknown>) => {
      const line = JSON.stringify(redact(fields), (_key, value: unknown) =>
        value instanceof Error ? { name: value.name, message: value.message } : value,
      );
      logLines.push(`${level} ${message} ${line}`);
    }) as never);
  }
}

function logHas(event: string): boolean {
  return logLines.some((line) => line.includes(event));
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

async function createChart(): Promise<string> {
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

  return chart.body.chart.chart_id as string;
}

function preCheckout(input: {
  payload: string;
  amount: number;
  queryId: string;
  currency?: string;
}): unknown {
  return {
    update_id: 10,
    pre_checkout_query: {
      id: input.queryId,
      from: { id: CHAT_ID },
      currency: input.currency ?? 'XTR',
      total_amount: input.amount,
      invoice_payload: input.payload,
    },
  };
}

async function sendWebhook(update: unknown): Promise<number> {
  const response = await request(ctx.app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set({ [SECRET_HEADER]: TEST_WEBHOOK_SECRET })
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
    update_id: 11,
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

async function eventsNamed(name: string): Promise<{ props: Record<string, unknown> }[]> {
  return ctx.db.query<{ props: Record<string, unknown> }>(
    `SELECT props FROM events WHERE name = $1 ORDER BY created_at`,
    [name],
  );
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  // Тестовые тарифы нужны седьмому сценарию (разовый разбор за 1 ⭐).
  // Флаг снимается в `afterAll`: он живёт в `process.env` воркера.
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    env: { PAYMENTS_TEST_PLANS: '1' },
  });
  logger = ctx.app.get(JsonLogger);
});

afterAll(async () => {
  await ctx.close();
  delete process.env['PAYMENTS_TEST_PLANS'];
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.messages.length = 0;
  telegram.answers.length = 0;
  telegram.refunds.length = 0;
  telegram.invoiceCalls.length = 0;
  telegram.sendMessageError = null;
  logLines = [];
  spyOnLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pre_checkout_query: ответ уходит всегда', () => {
  it('исключение в проверке → ok=false с человеческим текстом, лог и событие', async () => {
    const { payload } = await createInvoice('month_399');

    // Падение внутри проверки — то, что раньше давало молчание в ответ на
    // Telegram (человек видел «ошибка оплаты» без следа в наших логах).
    const plans = ctx.app.get(PlansRepository);
    vi.spyOn(plans, 'getPlan').mockRejectedValueOnce(new Error('pool is closed'));

    expect(await sendWebhook(preCheckout({ payload, amount: 399, queryId: 'pcq-throw' }))).toBe(200);

    expect(telegram.answers).toHaveLength(1);
    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-throw', ok: false });
    expect(telegram.answers[0]?.errorMessage).toBe('Оплата не подтвердилась — попробуй ещё раз');

    expect(logHas('pre_checkout_handler_failed')).toBe(true);
    expect(logHas('pre_checkout_answered')).toBe(true);
    expect(await eventsNamed('pre_checkout_timeout')).toHaveLength(0);
    expect((await eventsNamed('pre_checkout_rejected'))[0]?.props).toMatchObject({
      reason: 'handler_error',
      plan: 'month_399',
    });
  });

  it('сумма равна снимку счёта, даже если цену плана успели поменять', async () => {
    const { payload } = await createInvoice('compat_249');

    // Правка цены «на живом» тарифе: счёт уже выставлен на 249, и человек
    // видит в окне оплаты именно 249. Отклонять его из-за нашей правки нельзя.
    // Цена возвращается в `finally`: `plans` — справочник, его `truncateAll`
    // не чистит, и цена 1 ⭐ пережила бы этот тест.
    await ctx.db.query(`UPDATE plans SET stars = 1 WHERE code = 'compat_249'`);

    try {
      expect(await sendWebhook(preCheckout({ payload, amount: 249, queryId: 'pcq-snapshot' }))).toBe(200);
    } finally {
      await ctx.db.query(`UPDATE plans SET stars = 249 WHERE code = 'compat_249'`);
    }

    expect(telegram.answers).toEqual([{ queryId: 'pcq-snapshot', ok: true }]);
    expect((await eventsNamed('pre_checkout_rejected'))).toHaveLength(0);
    // Цель по времени: все проверки — чтения по индексам.
    const answered = logLines.find((line) => line.includes('pre_checkout_answered'));
    expect(answered).toBeDefined();
    const durationMs = Number(/duration_ms":(\d+)/.exec(answered ?? '')?.[1] ?? Number.NaN);
    expect(durationMs).toBeLessThan(PRECHECKOUT_TARGET_MS);
  });

  it('сумма не совпадает со снимком → ok=false и причина в логе', async () => {
    const { payload } = await createInvoice('month_399');

    expect(await sendWebhook(preCheckout({ payload, amount: 1, queryId: 'pcq-amount' }))).toBe(200);

    expect(telegram.answers[0]).toMatchObject({
      queryId: 'pcq-amount',
      ok: false,
      errorMessage: 'Сумма не совпадает со счётом — начни заново',
    });
    expect(logHas('"reason":"amount_mismatch"')).toBe(true);
    expect((await eventsNamed('pre_checkout_rejected'))[0]?.props).toMatchObject({
      reason: 'amount_mismatch',
      amount: 1,
      expected: 399,
    });
  });

  it('аннулированный счёт → ok=false, отдельная причина invoice_invalidated_price_changed', async () => {
    const { payload } = await createInvoice('month_399');
    await ctx.db.query(`UPDATE invoices SET status = 'invalidated'`);

    expect(await sendWebhook(preCheckout({ payload, amount: 399, queryId: 'pcq-invalid' }))).toBe(200);

    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-invalid', ok: false });
    expect(logHas('invoice_invalidated_price_changed')).toBe(true);
    expect((await eventsNamed('pre_checkout_rejected'))[0]?.props).toMatchObject({
      reason: 'invoice_invalidated_price_changed',
    });
  });

  it('два параллельных pre_checkout_query → отвечены оба', async () => {
    const { payload } = await createInvoice('month_399');

    const [first, second] = await Promise.all([
      sendWebhook(preCheckout({ payload, amount: 399, queryId: 'pcq-parallel-1' })),
      sendWebhook(preCheckout({ payload, amount: 399, queryId: 'pcq-parallel-2' })),
    ]);

    expect([first, second]).toEqual([200, 200]);
    expect(telegram.answers.map((answer) => answer.queryId).sort()).toEqual([
      'pcq-parallel-1',
      'pcq-parallel-2',
    ]);
    expect(telegram.answers.every((answer) => answer.ok)).toBe(true);
  });

  it('период звёздной подписки в счёте — только 2 592 000 секунд', async () => {
    // Тариф, которым проверяется оплата, обязан быть подпиской, которую
    // Telegram принимает: с неделей Bot API отвечает 400 (итерация 25).
    await createInvoice('test_1');
    const call = telegram.invoiceCalls.at(-1);
    expect(call?.subscriptionPeriod).toBe(2_592_000);
    expect([...(call?.title ?? '')].length).toBeLessThanOrEqual(32);
  });
});

describe('successful_payment: доступ не теряется', () => {
  it('исключение при выдаче доступа → платёж принят, лог, повтор не дублирует, джоб доводит', async () => {
    const { payload } = await createInvoice('month_399');
    const update = successfulPayment({ payload, chargeId: 'charge-grant-throw', amount: 399 });

    // Падение внутри транзакции выдачи: деньги уже списаны Telegram.
    const billing = ctx.app.get(BillingRepository);
    const brokenGrant = vi.spyOn(billing, 'markInvoicePaid').mockRejectedValue(new Error('deadlock detected'));

    // 200, а не 500: повтор доставки упрётся в ту же ошибку, а платёж
    // сохранён отдельной транзакцией и его доведёт pending_payments_resolve.
    expect(await sendWebhook(update)).toBe(200);

    const payment = await ctx.db.queryOne<{ status: string; processed: boolean }>(
      `SELECT status, processed FROM payments WHERE telegram_payment_charge_id = 'charge-grant-throw'`,
    );
    expect(payment).toEqual({ status: 'paid', processed: false });
    expect(logHas('payment_grant_failed')).toBe(true);
    expect(await eventsNamed('payment_grant_failed')).toHaveLength(1);

    // Повтор доставки не создаёт вторую строку и не выдаёт доступ дважды.
    expect(await sendWebhook(update)).toBe(200);
    expect(await ctx.db.query(`SELECT 1 FROM payments`)).toHaveLength(1);
    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);

    // Причина ушла — джоб разрешает зависший платёж тем же путём, что и свежий.
    brokenGrant.mockRestore();
    const service = ctx.app.get(PaymentsService);
    expect(await service.resolvePending('charge-grant-throw')).toBe('processed');

    const subscription = await ctx.db.queryOne<{ status: string }>(
      `SELECT status FROM subscriptions`,
    );
    expect(subscription?.status).toBe('active');
    expect(
      await ctx.db.queryOne<{ processed: boolean }>(
        `SELECT processed FROM payments WHERE telegram_payment_charge_id = 'charge-grant-throw'`,
      ),
    ).toEqual({ processed: true });
  });

  it('сообщение в чат не доставлено → платёж и доступ остаются, ошибка в логе', async () => {
    const { payload } = await createInvoice('month_399');
    telegram.sendMessageError = new Error('telegram: 429 Too Many Requests');

    expect(
      await sendWebhook(
        successfulPayment({
          payload,
          chargeId: 'charge-no-message',
          amount: 399,
          expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        }),
      ),
    ).toBe(200);

    expect(logHas('payment_message_failed')).toBe(true);
    expect(await ctx.db.queryOne<{ processed: boolean }>(`SELECT processed FROM payments`)).toEqual({
      processed: true,
    });
    expect(await ctx.db.queryOne<{ status: string }>(`SELECT status FROM subscriptions`)).toEqual({
      status: 'active',
    });

    // Повтор доставки: доступ не продлевается второй раз.
    const before = await ctx.db.queryOne<{ expires_at: Date }>(`SELECT expires_at FROM subscriptions`);
    expect(await sendWebhook(successfulPayment({ payload, chargeId: 'charge-no-message', amount: 399 }))).toBe(200);
    const after = await ctx.db.queryOne<{ expires_at: Date }>(`SELECT expires_at FROM subscriptions`);
    expect(after?.expires_at.toISOString()).toBe(before?.expires_at.toISOString());
    expect(await ctx.db.query(`SELECT 1 FROM payments`)).toHaveLength(1);
  });
});

describe('полный путь оплаты на подменённом Bot API', () => {
  it('подписка month_399: счёт → pre_checkout → successful_payment', async () => {
    const { payload, invoiceLink } = await createInvoice('month_399');
    expect(invoiceLink).toContain('$invoice-');

    const call = telegram.invoiceCalls.at(-1);
    // Валюта не передаётся: клиент всегда шлёт `XTR` для звёзд.
    expect(call).toMatchObject({ prices: [{ label: 'Месяц', amount: 399 }] });
    expect(call?.subscriptionPeriod).toBe(2_592_000);

    expect(await sendWebhook(preCheckout({ payload, amount: 399, queryId: 'pcq-path-month' }))).toBe(200);
    expect(telegram.answers[0]).toMatchObject({ ok: true });

    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    expect(
      await sendWebhook(successfulPayment({ payload, chargeId: 'charge-path-month', amount: 399, expiresAt })),
    ).toBe(200);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(me.body.subscription).toMatchObject({ plan: 'month', is_active: true });
    expect(telegram.messages).toHaveLength(1);
    expect(await ctx.db.queryOne<{ status: string }>(`SELECT status FROM invoices`)).toEqual({
      status: 'paid',
    });
  });

  it('разовый тестовый разбор test_report_1: счёт по карте → pre_checkout → доступ', async () => {
    const chartId = await createChart();
    const { payload } = await createInvoice('test_report_1', chartId);

    const call = telegram.invoiceCalls.at(-1);
    expect(call).toMatchObject({ prices: [{ label: 'Тест-разбор', amount: 1 }] });
    // Разовый товар: периода подписки в запросе быть не должно.
    expect(call?.subscriptionPeriod).toBeUndefined();

    expect(await sendWebhook(preCheckout({ payload, amount: 1, queryId: 'pcq-path-report' }))).toBe(200);
    expect(telegram.answers[0]).toMatchObject({ ok: true });

    expect(
      await sendWebhook(successfulPayment({ payload, chargeId: 'charge-path-report', amount: 1 })),
    ).toBe(200);

    const entitlement = await ctx.db.queryOne<{ kind: string; chart_id: string | null; status: string }>(
      `SELECT kind, chart_id, status FROM entitlements`,
    );
    expect(entitlement).toEqual({ kind: 'report', chart_id: chartId, status: 'active' });

    const payment = await ctx.db.queryOne<{ is_test: boolean; processed: boolean }>(
      `SELECT is_test, processed FROM payments`,
    );
    // Тестовая звезда не выручка, но платёж проведён как обычный.
    expect(payment).toEqual({ is_test: true, processed: true });
  });
});
