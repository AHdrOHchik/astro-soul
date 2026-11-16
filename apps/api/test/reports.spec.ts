import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { FakeLlmProvider } from '../src/modules/llm/fake-llm';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { FORMA_BLOCK, PROMPT_VERSION } from '../src/modules/reports/prompts';
import { MAX_ATTEMPTS, MISSING_SECTIONS_NOTE } from '../src/modules/reports/reports.service';
import { DISCLAIMER, STRUCTURE_VERSION } from '../src/modules/reports/validators';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';

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
    env: { INTERNAL_JOB_SECRET: JOBS_SECRET, ADMIN_TG_ID: String(FICTIONAL_USER.id) },
  });
});

/**
 * Провайдер, который пишет одну плотную простыню — ровно так ответила живая
 * модель на главу `talents` 16.11.2026 (`paragraphs: 1 вне 3–6`).
 */
class DenseParagraphProvider implements LlmProvider {
  readonly name = 'dense-stub';
  calls = 0;

  complete(input: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
    const prompt = input.messages.map((message) => message.content).join('\n');

    if (prompt.includes('Ответ — строго JSON')) {
      return Promise.resolve(this.answer(JSON.stringify({
        thesis: 'Ты быстро связываешь факты, но не считаешь это достижением.',
        focuses: [
          { topic: 'скорость ума', factor: 'Меркурий в Близнецах', angle: 'связи на ходу' },
          { topic: 'триггер', factor: 'Марс в Овне', angle: 'реакция на давление' },
        ],
        avoid: ['не повторять про скорость'],
      })));
    }

    const sentences = [
      'Ты держишь в голове сразу несколько линий и переключаешься между ними без усилия.',
      'Информация у тебя не копится, а сразу превращается в связку между людьми и темами.',
      'Такую скорость легко принять за суету, и ты сам иногда считаешь её недостатком.',
      'Когда тебя торопят, ответ становится резче, чем ты хотел.',
      'Сарказм в этот момент работает как короткий выход для раздражения.',
      'Вода в балансе даётся дорого: чувства приходят позже, чем выводы.',
      'Ясность для тебя важнее тепла, и это видно по тому, как ты выбираешь слова.',
    ];
    return Promise.resolve(this.answer(sentences.join(' ')));
  }

  private answer(content: string): LlmResponse {
    return {
      content,
      model: this.name,
      usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, costRub: 0.5 },
    };
  }
}

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  prompts.length = 0;
});

afterEach(() => {
  delete process.env['LLM_REPORT_CAP_RUB'];
  delete process.env['REPORT_BREAKER_ENABLED'];
});

/** Пользователь с картой: карта строится тем же API, что и в проде. */
async function userWithChart(birth: typeof BIRTH = BIRTH): Promise<Fixture> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(birth)
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

  it('одна покупка не открывает разбор по другой карте', async () => {
    const first = await userWithChart();
    await grantReport(first);

    await orderReport(first, 'chart-one').expect(202);

    // Вторая карта того же пользователя: другой вход, другой chart_id.
    const second = await userWithChart({ ...BIRTH, birth_date: '1990-01-02' });
    expect(second.chartId).not.toBe(first.chartId);

    const response = await orderReport(second, 'chart-two').expect(402);
    expect(response.body.code).toBe('PAYMENT_REQUIRED');
    expect(await ctx.db.query(`SELECT 1 FROM reports`)).toHaveLength(1);
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

// Б-4 (итерация 10): повтор с известным `Idempotency-Key` — это тот же
// объект, что `GET /reports/{id}`. Раньше повтор отдавал `is_paid:false` без
// `sections`, и фронт показывал оплаченный разбор как пустой.
describe('POST /api/v1/reports — повтор ключа (Б-4)', () => {
  it('повтор после готовности совпадает с GET, включая is_paid и sections', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture, 'charge-replay');

    const first = await orderReport(fixture, 'replay-key').expect(202);
    const reportId = first.body.report_id as string;
    await waitFor(reportId, ['ready']);

    const replay = await orderReport(fixture, 'replay-key').expect(202);
    const fetched = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(replay.body).toEqual(fetched.body);
    expect(replay.body.is_paid).toBe(true);
    expect(Array.isArray(replay.body.sections)).toBe(true);
    expect(replay.body.sections.length).toBeGreaterThan(0);
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

    const report = await ctx.db.queryOne<{
      attempts: number;
      llm_cost_rub: string;
      llm_tokens_in: number;
      llm_tokens_out: number;
      prompt_version: string;
      report_structure_version: string;
      chart_facts_version: string;
    }>(
      `SELECT attempts, llm_cost_rub, llm_tokens_in, llm_tokens_out,
              prompt_version, report_structure_version, chart_facts_version
         FROM reports`,
    );
    expect(report?.attempts).toBeGreaterThanOrEqual(8);
    // QA-002, задача 2: подставной провайдер ничего не стоит, поэтому рублей
    // ноль, но токены записаны — сумма и объём больше не расходятся.
    expect(Number(report?.llm_cost_rub)).toBe(0);
    expect(report?.llm_tokens_in ?? 0).toBeGreaterThan(0);
    expect(report?.llm_tokens_out ?? 0).toBeGreaterThan(0);
    // Контент v1.1: новые разборы пишут новую версию структуры и промптов.
    // Версия промптов — из единственного источника (`prompts.ts`), а не
    // строкой в тесте: иначе тест закрепляет ровно ту ошибку, из-за которой
    // прогон 16.11.2026 записал `prompts_v1.1` вместо текущей версии.
    expect(report?.prompt_version).toBe(PROMPT_VERSION);
    expect(report?.report_structure_version).toBe(STRUCTURE_VERSION);
    // Версия блока фактов: без неё «дешёвый разбор» не отличить от сломанного
    // отбора (задача C, п. 2).
    expect(report?.chart_facts_version).toBe('v1.2');
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
    // Факты при этом на месте: в промпте отобранные факторы v1.2, а не полная
    // карта (задача C). Солнце и Луна в отборе есть всегда.
    expect(joined).toContain('chart_facts: v1.2');
    expect(joined).toContain('Солнце');
    expect(joined).toContain('sun|');
    expect(joined).toContain('moon|');
  });
});

describe('сбои конвейера', () => {
  it('падение провайдера → failed, затем report_refund возвращает звёзды', async () => {
    const failing = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      llm: new FakeLlmProvider({ fail: true }),
      // Возврат за неудавшийся разбор по умолчанию выключен (решение
      // владельца): здесь он включается флагом, чтобы проверить сам джоб.
      env: { INTERNAL_JOB_SECRET: JOBS_SECRET, REFUND_ON_REPORT_FAILED: '1' },
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

describe('наблюдаемость конвейера (итерация 17)', () => {
  /** Блок фокусов конкретной главы из собранного промпта. */
  function focusLinesOf(chapter: string): string[] {
    const prompt = prompts.find((text) => text.includes(`Глава: ${chapter}.`));
    expect(prompt).toBeDefined();
    const block = /Фокусы этой главы \(только они, остальные темы плана — не твои\):\n([\s\S]*?)\n\nФорма:/u.exec(
      prompt ?? '',
    )?.[1];
    expect(block).toBeDefined();
    return (block ?? '').split('\n').filter((line) => line !== '');
  }

  it('каждая глава получает свою долю фокусов и блок «Форма» дословно', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    const order = await orderReport(fixture).expect(202);
    const ready = await waitFor(order.body.report_id as string, ['ready', 'failed']);
    expect(ready.body.status).toBe('ready');

    for (const chapter of ['core', 'emotions', 'talents', 'relations', 'money', 'purpose']) {
      const lines = focusLinesOf(chapter);
      // Было: весь план (в живом прогоне — семь тем). Стало: 2–3 свои.
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(3);

      const prompt = prompts.find((text) => text.includes(`Глава: ${chapter}.`)) ?? '';
      expect(prompt).toContain(FORMA_BLOCK);
    }
  });

  it('недобор материала остаётся провалом: код too_short, сырой ответ, две попытки', async () => {
    const dense = new DenseParagraphProvider();
    const failing = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      llm: dense,
      env: { INTERNAL_JOB_SECRET: JOBS_SECRET, ADMIN_TG_ID: String(FICTIONAL_USER.id) },
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
         VALUES ($1, $2, 'one_149', 149, 'charge-dense-1', true)
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
        .set('Idempotency-Key', 'dense-key')
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      const reportId = order.body.report_id as string;
      let status = '';
      for (let attempt = 0; attempt < 200 && status !== 'failed'; attempt += 1) {
        const response = await request(failing.app.getHttpServer())
          .get(`/api/v1/reports/${reportId}`)
          .set(INIT_DATA_HEADER, initDataFor());
        status = response.body.status as string;
        if (status !== 'failed') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(status).toBe('failed');

      const row = await failing.db.queryOne<{
        error_code: string;
        attempts: number;
        validation: { key: string; attempt: number; code: string; raw_excerpt: string }[];
      }>(`SELECT error_code, attempts, validation FROM reports WHERE id = $1`, [reportId]);

      // Семь предложений — это ~500 знаков при минимуме «Ядра» 1200: формы
      // тут мало, материала тоже. Нормализация такие случаи не выдумывает,
      // поэтому код — `too_short`, а не `paragraphs`.
      expect(row?.error_code).toBe('too_short');
      // План + две попытки одной главы: третьей быть не может.
      expect(row?.attempts).toBe(1 + MAX_ATTEMPTS);
      expect(row?.validation).toHaveLength(MAX_ATTEMPTS);
      expect(row?.validation.map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(row?.validation[0]?.key).toBe('core');
      expect(row?.validation[0]?.code).toBe('too_short');
      // Сырой ответ модели сохранён — по нему можно разобрать провал.
      expect(row?.validation[0]?.raw_excerpt).toContain('Ты держишь в голове сразу несколько линий');
    } finally {
      await failing.close();
    }
  });

  it('circuit breaker: три провала подряд закрывают приём разборов и это видно в метриках', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    for (let index = 0; index < 3; index += 1) {
      await ctx.db.query(
        `INSERT INTO reports (chart_id, user_id, status, error_code, prompt_version, report_structure_version)
         VALUES ($1, $2, 'failed', 'paragraphs', $3, $4)`,
        [fixture.chartId, fixture.userId, PROMPT_VERSION, STRUCTURE_VERSION],
      );
    }

    const blocked = await orderReport(fixture, 'breaker-key').expect(503);
    expect(blocked.body.code).toBe('UPSTREAM_LLM');
    expect(blocked.body.details.reason).toBe('report_breaker_open');
    expect(blocked.body.details.retry_after_ms).toBeGreaterThan(0);

    const metrics = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(metrics.body.reports_validation_streak).toBe(3);
    expect(metrics.body.reports_breaker_open).toBe(true);
    expect(metrics.body.reports_breaker_last_failed_at).not.toBeNull();
  });

  it('два провала подряд приём не закрывают', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    for (let index = 0; index < 2; index += 1) {
      await ctx.db.query(
        `INSERT INTO reports (chart_id, user_id, status, error_code, prompt_version, report_structure_version)
         VALUES ($1, $2, 'failed', 'paragraphs', $3, $4)`,
        [fixture.chartId, fixture.userId, PROMPT_VERSION, STRUCTURE_VERSION],
      );
    }

    const order = await orderReport(fixture, 'two-failures-key').expect(202);
    await waitFor(order.body.report_id as string, ['ready', 'failed']);
  });
});

describe('приёмка разбора целиком (итерация 17)', () => {
  /** Астрологические термины в тизере запрещены (`llm-prompts.md` §3.1). */
  const TEASER_TERMS =
    /солн|лун|меркур|венер|марс|юпитер|сатурн|уран|нептун|плутон|узел|асцендент|дом[аеу]?\b|аспект|трин|квадрат|оппозиц|стихи|крест|овен|телец|близнец|рак|лев\b|дев[аеы]|весы|скорпион|стрелец|козерог|водолей|рыб[аы]/iu;

  it('7/7 глав ok, у каждой 3–6 абзацев по 2–4 предложения, тизер без терминов', async () => {
    const fixture = await userWithChart();
    await grantReport(fixture);

    const order = await orderReport(fixture, 'acceptance-key').expect(202);
    const ready = await waitFor(order.body.report_id as string, ['ready', 'failed']);
    expect(ready.body.status).toBe('ready');

    const sections = ready.body.sections as { key: string; body_md: string }[];
    expect(sections.map((section) => section.key)).toEqual([
      'core',
      'emotions',
      'talents',
      'relations',
      'money',
      'purpose',
      'summary',
    ]);

    const report = await ctx.db.queryOne<{
      section_status: Record<string, string>;
      validation: unknown[] | null;
      llm_tokens_in: number;
      llm_tokens_out: number;
      attempts: number;
    }>(
      `SELECT section_status, validation, llm_tokens_in, llm_tokens_out, attempts FROM reports WHERE id = $1`,
      [ready.body.report_id],
    );

    for (const section of sections) {
      expect(report?.section_status[section.key]).toBe('ok');
      const paragraphs = section.body_md.split(/\n\s*\n/u).filter((block) => block.trim() !== '');
      expect(paragraphs.length).toBeGreaterThanOrEqual(3);
      expect(paragraphs.length).toBeLessThanOrEqual(6);
      for (const paragraph of paragraphs) {
        const sentences = paragraph
          .split(/(?<=[.!?…])\s+/u)
          .filter((sentence) => sentence.trim() !== '');
        expect(sentences.length).toBeGreaterThanOrEqual(2);
        expect(sentences.length).toBeLessThanOrEqual(4);
      }
    }

    // Все семь глав прошли с первой попытки: провалов нет (`[]` — так пишет
    // `saveProgress`, `null` бывает только у разбора, который вообще не дошёл
    // до сохранения диагностики).
    expect(report?.validation ?? []).toEqual([]);
    // Тизер — первые 400 знаков «Ядра», без названий планет, знаков, домов,
    // аспектов и стихий (проверка регуляркой; глазами — в отчёте итерации).
    const teaser = ready.body.teaser as string;
    expect(teaser).toHaveLength(400);
    expect(TEASER_TERMS.test(teaser)).toBe(false);
  });
});

/**
 * Запас предложений для «плотного» провайдера: 16 штук по ~90 знаков дают
 * нужный объём главы, но одной простынёй — ровно то, что модель отдавала
 * в живом прогоне.
 */
const POOL = [
  'Ты быстро собираешь связи между людьми и темами, не задерживаясь на одной линии.',
  'Скорость для тебя не трюк, а способ не застрять в чужой нерешительности надолго.',
  'Когда тебя торопят, ответ становится резче, чем ты собирался сказать вслух при всех.',
  'Раздражение уходит в сарказм, и это самый короткий путь выпустить пар без потерь.',
  'Выводы приходят раньше чувств, поэтому близкие иногда не успевают за твоим темпом.',
  'Ясность ты ценишь выше тепла, но тепла всё равно хочется, и это не противоречие.',
  'В работе тебе важнее видеть движение, чем получить готовую оценку своих усилий.',
  'Пауза в разговоре тебя не пугает: ты умеешь ждать, если видишь смысл в ожидании.',
  'Новые люди тянутся к тебе за конкретикой, а не за участием, и это стоит помнить.',
  'Усталость ты замечаешь поздно, обычно уже на стадии, когда всё вокруг раздражает.',
  'Просьбу о помощи ты формулируешь как задачу, и это работает лучше любой жалобы.',
  'Тебе легче начать, чем закончить, поэтому финал стоит назначать себе заранее.',
  'Резкие решения даются тебе проще постепенных: пока тянешь, ты теряешь интерес.',
  'Объяснять очевидное ты не любишь, но объясняешь хорошо, когда видишь собеседника.',
  'Ошибку ты признаёшь быстро и без торга, и это экономит тебе много времени.',
  'Тишина для тебя рабочее состояние, а не пустота, которую нужно чем-то заполнить.',
];

/** Провайдер с заданным текстом по главам: план и «Итог» — из одного места. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted-stub';
  calls = 0;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly render: (key: string, attempt: number) => string) {}

  complete(input: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
    const prompt = input.messages.map((message) => message.content).join('\n');

    if (prompt.includes('Ответ — строго JSON')) {
      return Promise.resolve(
        this.answer(
          JSON.stringify({
            thesis: 'Ты быстро связываешь факты, но не считаешь это достижением.',
            focuses: [
              { topic: 'скорость ума', factor: 'Меркурий в Близнецах', angle: 'связи на ходу' },
              { topic: 'триггер', factor: 'Марс в Овне', angle: 'реакция на давление' },
            ],
            avoid: ['не повторять про скорость'],
          }),
        ),
      );
    }

    const key = prompt.includes('заключительную главу «Итог')
      ? 'summary'
      : (/Глава: ([a-z]+)\./u.exec(prompt)?.[1] ?? 'core');

    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    return Promise.resolve(this.answer(this.render(key, attempt)));
  }

  private answer(content: string): LlmResponse {
    return {
      content,
      model: this.name,
      usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, costRub: 0.5 },
    };
  }
}

/** Одна простыня из 16 предложений: 1440 знаков, ни одного деления на абзацы. */
function denseBody(): string {
  return POOL.join(' ');
}

/** «Итог» с дисклеймером отдельным абзацем — как требует контракт. */
function summaryBody(): string {
  return [POOL.slice(1, 4).join(' '), POOL.slice(5, 8).join(' '), POOL.slice(9, 12).join(' '), DISCLAIMER].join(
    '\n\n',
  );
}

describe('валидация больше не убивает разбор (итерация 18)', () => {
  /** Заказ разбора в отдельном приложении со своим провайдером. */
  async function reportWith(
    llm: LlmProvider,
    key: string,
    env: Readonly<Record<string, string>> = {},
  ): Promise<{
    readonly ready: Response;
    readonly row: {
      section_status: Record<string, string> | null;
      validation: { key: string; attempt: number; code: string }[] | null;
      normalization: Record<string, { normalized: string[]; warnings: string[] }> | null;
      attempts: number;
      error_code: string | null;
    } | null;
    readonly db: TestContext['db'];
  }> {
    const local = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      llm,
      env: { INTERNAL_JOB_SECRET: JOBS_SECRET, ADMIN_TG_ID: String(FICTIONAL_USER.id), ...env },
    });

    try {
      const chart = await request(local.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor())
        .send(BIRTH)
        .expect(201);
      const chartId = chart.body.chart.chart_id as string;
      const user = await local.db.queryOne<{ id: string }>(`SELECT id FROM users`);
      const userId = user?.id ?? '';

      const payment = await local.db.queryOne<{ id: string }>(
        `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
         VALUES ($1, $2, 'one_149', 149, $3, true) RETURNING id`,
        [userId, FICTIONAL_USER.id, `charge-${key}`],
      );
      await local.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
        [userId, chartId, payment?.id],
      );

      const order = await request(local.app.getHttpServer())
        .post('/api/v1/reports')
        .set(INIT_DATA_HEADER, initDataFor())
        .set('Idempotency-Key', key)
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      const ready = await waitForOn(local, order.body.report_id as string, ['ready', 'failed']);
      const row = await local.db.queryOne<{
        section_status: Record<string, string> | null;
        validation: { key: string; attempt: number; code: string }[] | null;
        normalization: Record<string, { normalized: string[]; warnings: string[] }> | null;
        attempts: number;
        error_code: string | null;
      }>(
        `SELECT section_status, validation, normalization, attempts, error_code FROM reports WHERE id = $1`,
        [order.body.report_id],
      );

      return { ready, row, db: local.db };
    } finally {
      await local.close();
    }
  }

  it('плотная простыня проходит с первой попытки: форма правится кодом', async () => {
    const scripted = new ScriptedProvider((key) => (key === 'summary' ? summaryBody() : denseBody()));
    const { ready, row } = await reportWith(scripted, 'dense-normalized');

    expect(ready.body.status).toBe('ready');
    const sections = ready.body.sections as { key: string; body_md: string }[];
    expect(sections).toHaveLength(7);

    // Главное: ни одного жёсткого провала — модель ответила «плохо по форме».
    expect(row?.validation ?? []).toEqual([]);
    expect(row?.error_code).toBeNull();
    // Перегенераций не было: план + семь глав по одному вызову.
    expect(row?.attempts).toBe(1 + 7);
    expect(Object.values(row?.section_status ?? {}).every((status) => status === 'ok')).toBe(true);

    // В БД видно, что именно поправила нормализация.
    expect(row?.normalization?.['core']?.normalized).toContain('paragraphs_split');

    // И форма действительно приведена: 3–6 абзацев по 2–4 предложения.
    for (const section of sections.filter((item) => item.key !== 'summary')) {
      const paragraphs = section.body_md.split(/\n\s*\n/u).filter((block) => block.trim() !== '');
      expect(paragraphs.length).toBeGreaterThanOrEqual(3);
      expect(paragraphs.length).toBeLessThanOrEqual(6);
      for (const paragraph of paragraphs) {
        const sentences = paragraph.split(/(?<=[.!?…])\s+/u).filter((item) => item.trim() !== '');
        expect(sentences.length).toBeGreaterThanOrEqual(2);
        expect(sentences.length).toBeLessThanOrEqual(4);
      }
    }

    // Полный разбор: ничего не потеряно, пометок о нехватке глав нет.
    expect(ready.body.missing_sections).toEqual([]);
  });

  it('одна несобранная глава → ready, missing_sections и хвост про пересборку', async () => {
    const scripted = new ScriptedProvider((key) => {
      if (key === 'summary') {
        return summaryBody();
      }
      // `talents` недобирает материал даже после нормализации.
      return key === 'talents' ? POOL.slice(0, 4).join(' ') : denseBody();
    });
    const { ready, row } = await reportWith(scripted, 'partial-one');

    expect(ready.body.status).toBe('ready');
    const sections = ready.body.sections as { key: string; body_md: string }[];
    expect(sections.map((section) => section.key)).toEqual([
      'core',
      'emotions',
      'relations',
      'money',
      'purpose',
      'summary',
    ]);

    // Контракт 1.5.11: чего не хватает — сказано явно.
    expect(ready.body.missing_sections).toEqual(['talents']);
    expect(Array.isArray(ready.body.warnings)).toBe(true);

    // «Итог» закрывается фразой владельца, а не обрывом на шестой главе.
    const summary = sections.find((section) => section.key === 'summary');
    expect(summary?.body_md.endsWith(MISSING_SECTIONS_NOTE)).toBe(true);
    expect(summary?.body_md).toContain(DISCLAIMER);

    // Диагностика: глава помечена failed, попытки и код сохранены.
    expect(row?.section_status?.['talents']).toBe('failed');
    expect(row?.section_status?.['core']).toBe('ok');
    expect((row?.validation ?? []).map((entry) => entry.code)).toEqual(['too_short', 'too_short']);
    expect((row?.validation ?? []).every((entry) => entry.key === 'talents')).toBe(true);
    // План + пять живых глав + две попытки `talents` + «Итог».
    expect(row?.attempts).toBe(1 + 5 + 2 + 1);
    expect(row?.error_code).toBeNull();
  });

  it('меньше трёх живых глав → failed, а не пустой разбор', async () => {
    const scripted = new ScriptedProvider((key) =>
      key === 'core' ? denseBody() : POOL.slice(0, 4).join(' '),
    );
    const { ready, row } = await reportWith(scripted, 'too-few');

    expect(ready.body.status).toBe('failed');
    expect(row?.error_code).toBe('too_short');
    // «Ядро» живо, остальные пять — по две попытки каждая.
    expect(row?.section_status?.['core']).toBe('ok');
    expect(row?.section_status?.['emotions']).toBe('failed');
  });

  it('REPORT_BREAKER_ENABLED=0: серия провалов растёт, но запуск не блокируется', async () => {
    const local = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      llm: provider,
      env: {
        INTERNAL_JOB_SECRET: JOBS_SECRET,
        ADMIN_TG_ID: String(FICTIONAL_USER.id),
        REPORT_BREAKER_ENABLED: '0',
      },
    });

    try {
      const chart = await request(local.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor())
        .send(BIRTH)
        .expect(201);
      const chartId = chart.body.chart.chart_id as string;
      const user = await local.db.queryOne<{ id: string }>(`SELECT id FROM users`);
      const userId = user?.id ?? '';

      for (let index = 0; index < 3; index += 1) {
        await local.db.query(
          `INSERT INTO reports (chart_id, user_id, status, error_code, prompt_version, report_structure_version)
           VALUES ($1, $2, 'failed', 'too_short', $3, $4)`,
          [chartId, userId, PROMPT_VERSION, STRUCTURE_VERSION],
        );
      }

      // Метрика серии считается и при выключенном флаге: провалы никуда не делись.
      const metricsBefore = await request(local.app.getHttpServer())
        .get('/api/v1/admin/metrics')
        .set(INIT_DATA_HEADER, initDataFor())
        .expect(200);
      expect(metricsBefore.body.reports_validation_streak).toBe(3);
      expect(metricsBefore.body.reports_breaker_open).toBe(false);

      const payment = await local.db.queryOne<{ id: string }>(
        `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
         VALUES ($1, $2, 'one_149', 149, 'charge-breaker-off', true) RETURNING id`,
        [userId, FICTIONAL_USER.id],
      );
      await local.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
        [userId, chartId, payment?.id],
      );

      // Не 503: запуск разрешён, хотя брейкер открыт.
      const order = await request(local.app.getHttpServer())
        .post('/api/v1/reports')
        .set(INIT_DATA_HEADER, initDataFor())
        .set('Idempotency-Key', 'breaker-off-key')
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      const ready = await waitForOn(local, order.body.report_id as string, ['ready', 'failed']);
      expect(ready.body.status).toBe('ready');
      expect(ready.body.missing_sections).toEqual([]);
    } finally {
      await local.close();
    }
  });
});

/** Ожидание статуса в конкретном контексте (а не в общем `ctx`). */
async function waitForOn(
  local: TestContext,
  reportId: string,
  statuses: readonly string[],
): Promise<Response> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(local.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor());

    if (statuses.includes(response.body.status as string)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`разбор ${reportId} не дошёл до ${statuses.join('/')}`);
}
