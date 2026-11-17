import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import * as shared from '@astro-soul/shared';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_DATABASE_URL, TEST_WEBHOOK_SECRET } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';
import { MAX_STARS, MIN_STARS, parseArgs, setPlanPrice } from '../scripts/set-plan-price';

/**
 * Цена живёт в БД — и только там.
 *
 * Дефект, ради которого написан этот спек (совместимость `compat_249`):
 * цену правили в таблице `plans` — витрина продолжала показывать 249 ⭐;
 * цену правили в `packages/shared/src/plans.ts` — витрина показывала 1 ⭐,
 * а окно Telegram после нажатия «оплатить» — снова 249 ⭐. Три читателя цены.
 *
 * Здесь проверяется, что читатель остался один и что у уже выставленного счёта
 * своя цена — снимок `invoices.stars`:
 *   1. `UPDATE plans SET stars = …` меняет витрину, счёт (ответ и строку в БД)
 *      и `pre_checkout_query` — без перезапуска приложения;
 *   2. числа из `plans.ts` в рантайме не читаются вообще;
 *   3. снимок: счёт на 249 живёт по 249, даже если план уже стоит 1;
 *   4. тестовые тарифы при выключенном флаге не продаются, даже если строка есть;
 *   5. скрипт `plans:set-price` проверяет значение и печатает «было → стало».
 *
 * Шестое — отсутствие цен в коде — отдельным спеком
 * (`plans-single-source.spec.ts`), чтобы падение не требовало поднятой БД.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const CHAT_ID = 777_000_111;
const WEBHOOK_PATH = `/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`;
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

/** Цена `compat_249` «как в каталоле»: её возвращаем после каждой правки. */
const COMPAT_BASE_PRICE = 249;

interface Offer {
  readonly plan_code: string;
  readonly stars: number;
  readonly test: boolean;
}

let ctx: TestContext;
let telegram: FakeTelegram;
let pool: Pool;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

async function fetchPlans(context: TestContext = ctx): Promise<Offer[]> {
  const response = await request(context.app.getHttpServer())
    .get('/api/v1/billing/plans')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  return response.body.plans as Offer[];
}

async function setDbPrice(code: string, stars: number): Promise<void> {
  await ctx.db.query(`UPDATE plans SET stars = $2, updated_at = now() WHERE code = $1`, [code, stars]);
}

async function dbPrice(code: string): Promise<number> {
  const row = await ctx.db.queryOne<{ stars: number }>(`SELECT stars FROM plans WHERE code = $1`, [code]);

  if (row === null) {
    throw new Error(`плана ${code} нет в plans`);
  }

  return row.stars;
}

async function createChart(): Promise<string> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  return response.body.chart.chart_id as string;
}

/** Счёт по коду плана: возвращает ответ и сохранённый в БД снимок суммы. */
async function createInvoice(
  planCode: string,
  options: { readonly chartId?: string; readonly context?: TestContext } = {},
): Promise<{ payload: string; stars: number; snapshot: number }> {
  const context = options.context ?? ctx;
  const response = await request(context.app.getHttpServer())
    .post('/api/v1/billing/invoice')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ plan_code: planCode, ...(options.chartId === undefined ? {} : { chart_id: options.chartId }) })
    .expect(201);

  const invoice = await context.db.queryOne<{ payload: string; stars: number }>(
    `SELECT payload, stars FROM invoices ORDER BY created_at DESC LIMIT 1`,
  );

  if (invoice === null) {
    throw new Error('инвойс не найден');
  }

  return { payload: invoice.payload, stars: response.body.stars as number, snapshot: invoice.stars };
}

async function sendWebhook(update: unknown): Promise<void> {
  await request(ctx.app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set(SECRET_HEADER, TEST_WEBHOOK_SECRET)
    .send(update as object)
    .expect(200);
}

async function preCheckout(payload: string, amount: number, queryId: string): Promise<void> {
  await sendWebhook({
    update_id: 1,
    pre_checkout_query: {
      id: queryId,
      from: { id: CHAT_ID },
      currency: 'XTR',
      total_amount: amount,
      invoice_payload: payload,
    },
  });
}

async function successfulPayment(input: {
  readonly payload: string;
  readonly amount: number;
  readonly chargeId: string;
}): Promise<void> {
  await sendWebhook({
    update_id: 2,
    message: {
      chat: { id: CHAT_ID },
      from: { id: CHAT_ID },
      successful_payment: {
        currency: 'XTR',
        total_amount: input.amount,
        invoice_payload: input.payload,
        telegram_payment_charge_id: input.chargeId,
        provider_payment_charge_id: `provider-${input.chargeId}`,
      },
    },
  });
}

async function paymentRow(
  chargeId: string,
): Promise<{ status: string; total_amount: number; reject_reason: string | null } | null> {
  return ctx.db.queryOne<{ status: string; total_amount: number; reject_reason: string | null }>(
    `SELECT status, total_amount, reject_reason FROM payments WHERE telegram_payment_charge_id = $1`,
    [chargeId],
  );
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({ astro: makeFakeAstro(), telegram });
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.invoiceCalls.length = 0;
  telegram.answers.length = 0;
  telegram.messages.length = 0;
});

afterEach(async () => {
  // Таблицу `plans` тесты не чистят (это каталог, а не данные сценария),
  // поэтому цену возвращаем руками — иначе один тест ломает следующий.
  await setDbPrice('compat_249', COMPAT_BASE_PRICE);
  await setDbPrice('test_report_1', 1);
});

describe('цена берётся из строки `plans` — на всех четырёх путях', () => {
  it('UPDATE plans не требует перезапуска: витрина, счёт и pre_checkout видят новую цену', async () => {
    // Ровно то, что делал владелец: правил цену в таблице.
    await setDbPrice('compat_249', 1);

    const plans = await fetchPlans();
    expect(plans.find((plan) => plan.plan_code === 'compat_249')).toMatchObject({ stars: 1 });

    const invoice = await createInvoice('compat_249');
    // Цена в ответе и снимок в БД — одна и та же единица, а не 249.
    expect(invoice.stars).toBe(1);
    expect(invoice.snapshot).toBe(1);
    expect(telegram.invoiceCalls[0]?.prices).toEqual([{ label: 'Совместимость', amount: 1 }]);

    await preCheckout(invoice.payload, 1, 'pcq-ok');
    await preCheckout(invoice.payload, COMPAT_BASE_PRICE, 'pcq-stale');

    expect(telegram.answers[0]).toMatchObject({ queryId: 'pcq-ok', ok: true });
    expect(telegram.answers[1]).toMatchObject({ queryId: 'pcq-stale', ok: false });
  });

  it('числа из plans.ts в рантайме не читаются: цену, которой нет в коде, сервер отдаёт как есть', async () => {
    // Такой цены нет ни в одном файле проекта — значит взять её можно только
    // из БД. Заодно это проверка на кэш: правка видна на следующем запросе.
    await setDbPrice('compat_249', 137);

    const plans = await fetchPlans();
    expect(plans.find((plan) => plan.plan_code === 'compat_249')?.stars).toBe(137);

    const invoice = await createInvoice('compat_249');
    expect(invoice.stars).toBe(137);
    expect(invoice.snapshot).toBe(137);

    // В общем пакете не осталось ни каталога, ни функции цены — читать нечего.
    const runtime = shared as unknown as Record<string, unknown>;
    expect(runtime['PLANS']).toBeUndefined();
    expect(runtime['PLANS_ORDERED']).toBeUndefined();
    expect(runtime['priceOf']).toBeUndefined();
    expect(shared.isPlanCode('compat_249')).toBe(true);
  });

  it('снимок счёта: выставленный на 249 принимает 249, даже когда план уже стоит 1', async () => {
    const invoice = await createInvoice('compat_249');
    expect(invoice.stars).toBe(COMPAT_BASE_PRICE);

    // Владелец подешевил тариф, пока окно оплаты было открыто.
    await setDbPrice('compat_249', 1);
    expect(await dbPrice('compat_249')).toBe(1);

    // Честный платёж по уже показанному счёту не отклоняется из-за нашей правки.
    await successfulPayment({ payload: invoice.payload, amount: COMPAT_BASE_PRICE, chargeId: 'charge-snapshot-ok' });
    expect(await paymentRow('charge-snapshot-ok')).toMatchObject({
      status: 'processed',
      total_amount: COMPAT_BASE_PRICE,
    });

    // А платёж на новую цену по старому счёту — отклоняется: счёт не переписан.
    await successfulPayment({ payload: invoice.payload, amount: 1, chargeId: 'charge-snapshot-stale' });
    expect(await paymentRow('charge-snapshot-stale')).toMatchObject({
      status: 'rejected',
      reject_reason: 'amount_mismatch',
      total_amount: 1,
    });
  });

  it('счёт переиспользуется со своей суммой: новая цена не подменяет открытый счёт', async () => {
    const first = await createInvoice('compat_249');
    await setDbPrice('compat_249', 1);

    // Второй POST попадает в окно переиспользования: сумма — снимок, а не 1.
    const second = await createInvoice('compat_249');
    expect(second.stars).toBe(COMPAT_BASE_PRICE);
    expect(second.snapshot).toBe(COMPAT_BASE_PRICE);
    expect(second.payload).toBe(first.payload);
  });
});

describe('тестовые тарифы при выключенном флаге', () => {
  it('строки в БД есть, но витрина их не показывает и счёт по ним не создаётся', async () => {
    const row = await ctx.db.queryOne<{ test_only: boolean }>(
      `SELECT test_only FROM plans WHERE code = 'test_report_1'`,
    );
    // Строка физически в таблице — сценарий «включил флаг, потестил, выключил».
    expect(row).toEqual({ test_only: true });

    const plans = await fetchPlans();
    expect(plans.some((plan) => plan.test)).toBe(false);
    expect(JSON.stringify(plans)).not.toContain('test_report_1');

    const chartId = await createChart();
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'test_report_1', chart_id: chartId })
      .expect(422);

    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field_errors: [{ field: 'plan_code' }] },
    });
    expect(telegram.invoiceCalls).toHaveLength(0);
  });
});

describe('pnpm plans:set-price', () => {
  it('меняет цену и печатает «было → стало» с событием plan_price_changed', async () => {
    const result = await setPlanPrice(pool, { code: 'compat_249', stars: 1 }, { testPlansEnabled: false });

    expect(result).toEqual({ code: 'compat_249', from: COMPAT_BASE_PRICE, to: 1, testOnly: false });
    expect(await dbPrice('compat_249')).toBe(1);
  });

  it('не создаёт тариф по опечатке в коде', async () => {
    await expect(
      setPlanPrice(pool, { code: 'compat_24', stars: 250 }, { testPlansEnabled: false }),
    ).rejects.toThrow(/нет в таблице plans/);

    const count = await ctx.db.queryOne<{ count: string }>(`SELECT count(*) FROM plans WHERE code = 'compat_24'`);
    expect(count).toEqual({ count: '0' });
  });

  it('тестовый тариф без PAYMENTS_TEST_PLANS не трогает', async () => {
    await expect(
      setPlanPrice(pool, { code: 'test_report_1', stars: 2 }, { testPlansEnabled: false }),
    ).rejects.toThrow(/тестовый тариф/);

    expect(await dbPrice('test_report_1')).toBe(1);
  });

  it('отвергает 0, отрицательное, дробное и больше 10 000', () => {
    for (const raw of ['0', '-1', '1.5', '10001', 'девять', '']) {
      expect(() => parseArgs(['--code=compat_249', `--stars=${raw}`]), raw).toThrow();
    }

    expect(parseArgs(['--code=compat_249', `--stars=${String(MIN_STARS)}`])).toEqual({
      code: 'compat_249',
      stars: MIN_STARS,
    });
    expect(parseArgs(['--code=compat_249', `--stars=${String(MAX_STARS)}`])).toEqual({
      code: 'compat_249',
      stars: MAX_STARS,
    });
    expect(() => parseArgs(['--code=compat_249'])).toThrow(/нужны оба аргумента/);
  });
});
