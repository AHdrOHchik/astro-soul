import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { FakeLlmProvider } from '../src/modules/llm/fake-llm';
import type { LlmRequest } from '../src/modules/llm/llm.client';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const JOBS_SECRET = 'test-jobs-secret-0123456789';

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

interface Fixture {
  readonly chartId: string;
  readonly userId: string;
}

let ctx: TestContext;
let telegram: FakeTelegram;
let prompts: string[];
let provider: FakeLlmProvider;

beforeAll(async () => {
  telegram = makeFakeTelegram();
  prompts = [];
  provider = new FakeLlmProvider({
    onRequest: (input: LlmRequest) => {
      prompts.push(input.messages.map((message) => message.content).join('\n'));
    },
  });
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    llm: provider,
    env: { INTERNAL_JOB_SECRET: JOBS_SECRET },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  prompts.length = 0;
});

afterEach(() => {
  delete process.env['LLM_REPORT_CAP_RUB'];
});

/** Пользователь с картой: карта строится тем же API, что и в проде. */
async function userWithChart(): Promise<Fixture> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
  return { chartId: response.body.chart.chart_id as string, userId: user?.id ?? '' };
}

/** Покупка разбора: платёж + запись доступа, как после успешного webhook. */
async function grantReport(fixture: Fixture, chargeId = 'charge-report-1'): Promise<void> {
  const payment = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
     VALUES ($1, $2, 'one_149', 149, $3, true)
     RETURNING id`,
    [fixture.userId, FICTIONAL_USER.id, chargeId],
  );
  await ctx.db.query(
    `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
    [fixture.userId, fixture.chartId, payment?.id],
  );
}

function orderReport(
  fixture: Fixture,
  key = 'order-key-1',
  idempotency: string | null = key,
) {
  const call = request(ctx.app.getHttpServer()).post('/api/v1/reports').set(INIT_DATA_HEADER, initDataFor());
  return idempotency === null
    ? call.send({ chart_id: fixture.chartId, type: 'full' })
    : call.set('Idempotency-Key', idempotency).send({ chart_id: fixture.chartId, type: 'full' });
}

/** Ждём готовности разбора: конвейер асинхронный, как в проде. */
async function waitFor(
  reportId: string,
  statuses: readonly string[],
): Promise<Response> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor());

    if (statuses.includes(response.body.status as string)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`разбор ${reportId} не дошёл до ${statuses.join('/')}`);
}

describe('POST /api/v1/reports', () => {
  it('без Idempotency-Key → 422 с полем заголовка', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    const response = await orderReport(fixture, 'key', null).expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toEqual([
      { field: 'Idempotency-Key', message: expect.stringContaining('ключ идемпотентности') },
    ]);
  });

  it('без оплаты → 402 и ни одного разбора', async () => {
    const fixture = await userWithChart();

    const response = await orderReport(fixture).expect(402);

    expect(response.body.code).toBe('PAYMENT_REQUIRED');
    expect(await ctx.db.query(`SELECT 1 FROM reports`)).toHaveLength(0);
  });

  it('три заказа с одним ключом дают один разбор', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    const first = await orderReport(fixture, 'same-key').expect(202);
    const second = await orderReport(fixture, 'same-key').expect(202);
    const third = await orderReport(fixture, 'same-key').expect(202);

    expect(second.body.report_id).toBe(first.body.report_id);
    expect(third.body.report_id).toBe(first.body.report_id);
    expect(await ctx.db.query(`SELECT 1 FROM reports`)).toHaveLength(1);

    const ready = await waitFor(first.body.report_id as string, ['ready']);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.progress).toBe(100);
  });
});

describe('GET /api/v1/reports/{report_id}', () => {
  it('собирает семь глав, отдаёт дисклеймер и тизер', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    const order = await orderReport(fixture).expect(202);
    const ready = await waitFor(order.body.report_id as string, ['ready', 'failed']);

    expect(ready.body.status).toBe('ready');
    expect(ready.body.is_paid).toBe(true);
    expect(ready.body.type).toBe('full');

    const sections = ready.body.sections as { key: string; title: string; body_md: string }[];
    expect(sections.map((section) => section.key)).toEqual([
      'core',
      'emotions',
      'talents',
      'relations',
      'money',
      'purpose',
      'summary',
    ]);
    for (const section of sections) {
      expect(section.body_md.length).toBeGreaterThan(300);
    }
    expect(sections.at(-1)?.body_md).toContain(
      'Разбор — инструмент саморефлексии, а не предсказание и не замена специалисту.',
    );
    // Тизер — первые 400 знаков «Ядра»: он же показывается до оплаты.
    expect(ready.body.teaser).toBe(sections[0]?.body_md.slice(0, 400));

    const report = await ctx.db.queryOne<{ attempts: number; llm_cost_rub: string }>(
      `SELECT attempts, llm_cost_rub FROM reports`,
    );
    expect(report?.attempts).toBeGreaterThanOrEqual(8);
    expect(Number(report?.llm_cost_rub)).toBeGreaterThan(0);
  });

  it('в промпт не попадают ПДн — только факты карты', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    const order = await orderReport(fixture).expect(202);
    const ready = await waitFor(order.body.report_id as string, ['ready', 'failed']);
    expect(ready.body.status).toBe('ready');

    const joined = prompts.join('\n');
    for (const secret of ['1994-05-17', '14:20', 'Москва', '55.75', '37.61', '777000111', 'Тест', 'test_user']) {
      expect(joined).not.toContain(secret);
    }
    // Факты при этом на месте: карта в промпте есть.
    expect(joined).toContain('Солнце');
    expect(joined).toContain('planets:');
  });
});

describe('сбои конвейера', () => {
  it('падение провайдера → failed, затем report_refund возвращает звёзды', async () => {
    const failing = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      llm: new FakeLlmProvider({ fail: true }),
      env: { INTERNAL_JOB_SECRET: JOBS_SECRET },
    });

    try {
      const chart = await request(failing.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor())
        .send(BIRTH)
        .expect(201);
      const chartId = chart.body.chart.chart_id as string;
      const user = await failing.db.queryOne<{ id: string }>(`SELECT id FROM users`);
      const userId = user?.id ?? '';

      const payment = await failing.db.queryOne<{ id: string }>(
        `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
         VALUES ($1, $2, 'one_149', 149, 'charge-failed-1', true)
         RETURNING id`,
        [userId, FICTIONAL_USER.id],
      );
      await failing.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
        [userId, chartId, payment?.id],
      );

      const order = await request(failing.app.getHttpServer())
        .post('/api/v1/reports')
        .set(INIT_DATA_HEADER, initDataFor())
        .set('Idempotency-Key', 'fail-key')
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      let status = '';
      for (let attempt = 0; attempt < 200 && status !== 'failed'; attempt += 1) {
        const response = await request(failing.app.getHttpServer())
          .get(`/api/v1/reports/${order.body.report_id as string}`)
          .set(INIT_DATA_HEADER, initDataFor());
        status = response.body.status as string;
        if (status !== 'failed') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(status).toBe('failed');

      const failedRow = await failing.db.queryOne<{ error_code: string }>(
        `SELECT error_code FROM reports`,
      );
      expect(failedRow?.error_code).toBe('provider');

      const refund = await request(failing.app.getHttpServer())
        .post('/api/v1/internal/jobs/run?job=report_refund')
        .set('X-Jobs-Secret', JOBS_SECRET)
        .expect(202);
      expect(refund.body).toMatchObject({ report_refunds_done: 1 });
      expect(telegram.refunds).toEqual([{ userId: FICTIONAL_USER.id, chargeId: 'charge-failed-1' }]);

      const refunded = await request(failing.app.getHttpServer())
        .get(`/api/v1/reports/${order.body.report_id as string}`)
        .set(INIT_DATA_HEADER, initDataFor());
      expect(refunded.body.status).toBe('refunded');
    } finally {
      await failing.close();
    }
  });

  it('перерасход по лимиту разбора → failed без повторной попытки', async () => {
    process.env['LLM_REPORT_CAP_RUB'] = '0.1';
    const capped = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      llm: new FakeLlmProvider({ tokensPerCall: 1_000, pricePer1kRub: 0.5 }),
      env: { INTERNAL_JOB_SECRET: JOBS_SECRET },
    });

    try {
      const chart = await request(capped.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor())
        .send(BIRTH)
        .expect(201);
      const chartId = chart.body.chart.chart_id as string;
      const user = await capped.db.queryOne<{ id: string }>(`SELECT id FROM users`);
      const userId = user?.id ?? '';

      const payment = await capped.db.queryOne<{ id: string }>(
        `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
         VALUES ($1, $2, 'one_149', 149, 'charge-cap-1', true)
         RETURNING id`,
        [userId, FICTIONAL_USER.id],
      );
      await capped.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
        [userId, chartId, payment?.id],
      );

      const order = await request(capped.app.getHttpServer())
        .post('/api/v1/reports')
        .set(INIT_DATA_HEADER, initDataFor())
        .set('Idempotency-Key', 'cap-key')
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      let body: { status?: string } = {};
      for (let attempt = 0; attempt < 200 && body.status !== 'failed'; attempt += 1) {
        const response = await request(capped.app.getHttpServer())
          .get(`/api/v1/reports/${order.body.report_id as string}`)
          .set(INIT_DATA_HEADER, initDataFor());
        body = response.body as { status?: string };
        if (body.status !== 'failed') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      expect(body.status).toBe('failed');
      const row = await capped.db.queryOne<{ error_code: string; attempts: number }>(
        `SELECT error_code, attempts FROM reports`,
      );
      expect(row?.error_code).toBe('cost_cap');
      // Лимит сработал после первого вызова: второго не было.
      expect(row?.attempts).toBe(1);
    } finally {
      await capped.close();
    }
  });
});
