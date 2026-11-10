import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

let ctx: TestContext;
let telegram: FakeTelegram;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
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
  telegram.invoiceCalls.length = 0;
});

describe('POST /api/v1/billing/invoice', () => {
  it('создаёт инвойс в XTR по цене из плана, payload ≤ 128 байт', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'month_399' })
      .expect(201);

    expect(response.body).toMatchObject({
      plan_code: 'month_399',
      stars: 399,
      is_subscription: true,
      subscription_period_sec: 2_592_000,
    });
    expect(response.body.invoice_link).toMatch(/^https:\/\/t\.me\//);

    const call = telegram.invoiceCalls[0];
    expect(call?.prices).toEqual([{ label: 'Месяц', amount: 399 }]);
    expect(call?.subscriptionPeriod).toBe(2_592_000);
    expect(Buffer.byteLength(call?.payload ?? '', 'utf8')).toBeLessThanOrEqual(128);
    // В payload нет ПДн: только план, псевдонимный id и ключ идемпотентности.
    expect(call?.payload ?? '').not.toContain('Тест');
    expect(Object.keys(JSON.parse(call?.payload ?? '{}'))).toEqual(['p', 'u', 'k']);

    const invoice = await ctx.db.queryOne<{ payload: string; status: string }>(
      `SELECT payload, status FROM invoices`,
    );
    expect(invoice?.status).toBe('created');
  });

  it('двойной тап: тот же план в пределах 5 минут отдаёт ту же ссылку', async () => {
    const first = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'one_149' })
      .expect(201);

    const second = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'one_149' })
      .expect(201);

    expect(second.body.invoice_link).toBe(first.body.invoice_link);
    expect(telegram.invoiceCalls).toHaveLength(1);
    const invoices = await ctx.db.query(`SELECT 1 FROM invoices`);
    expect(invoices).toHaveLength(1);
  });

  it('разовый товар: без subscription_period', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'solar_590' })
      .expect(201);

    expect(telegram.invoiceCalls[0]?.subscriptionPeriod).toBeUndefined();
  });

  it('антифрод: четвёртый инвойс за час → 429 RATE_LIMITED', async () => {
    for (const plan of ['one_149', 'compat_249', 'solar_590'] as const) {
      await request(ctx.app.getHttpServer())
        .post('/api/v1/billing/invoice')
        .set(INIT_DATA_HEADER, initDataFor())
        .send({ plan_code: plan })
        .expect(201);
    }

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'week_149' })
      .expect(429);

    expect(response.body.code).toBe('RATE_LIMITED');
  });

  it('неизвестный план → 422 VALIDATION_FAILED', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'free_0' })
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('чужая карта в chart_id → 404', async () => {
    const strangerChartId = '11111111-1111-4111-8111-111111111111';

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'one_149', chart_id: strangerChartId })
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('без initData → 401', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .send({ plan_code: 'month_399' })
      .expect(401);
  });
});

describe('GET /api/v1/billing/subscription', () => {
  it('без оплаты — plan none, не активна', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/billing/subscription')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body).toMatchObject({ plan: 'none', is_active: false, expires_at: null });
  });
});
