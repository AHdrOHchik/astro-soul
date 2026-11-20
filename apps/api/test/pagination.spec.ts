import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram } from './fake-telegram';

/**
 * Пагинация списков (контракт 1.6.8, итерация 32).
 *
 * Проверяется ровно одно обещание, но его легко сломать позже: **`total`
 * считается до `LIMIT`**. Ошибка «взяли `items.length`» проходит все ручные
 * проверки на первой странице и врёт на последней, поэтому в тесте пять
 * записей и `limit=2`: `items.length = 2`, `total = 5`.
 *
 * Второй сценарий — `offset` за концом списка: там оконная функция
 * (`count(*) over ()`) вернула бы ноль, и `total` обнулился бы именно тогда,
 * когда он нужнее всего (клиент листает до конца).
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

interface QuestionListBody {
  readonly items: readonly { readonly id: string }[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

interface CompatListBody {
  readonly items: readonly { readonly id: string }[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ astro: makeFakeAstro(), telegram: makeFakeTelegram() });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

/** Пользователь с картой: карту создаём настоящим маршрутом, как в проде. */
async function userWithChart(): Promise<{ userId: string; chartId: string }> {
  const created = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);

  return {
    userId: user?.id ?? '',
    chartId: (created.body as { chart: { chart_id: string } }).chart.chart_id,
  };
}

/**
 * Пять вопросов в истории. Вставляются SQL, а не через `POST /questions`:
 * LLM здесь не проверяется, а каждый настоящий вопрос — это вызов модели и
 * квота. Фильтр списка (`ready`/`refused`/`pending`) проверяется ниже отдельно.
 */
async function fiveQuestions(userId: string): Promise<void> {
  for (let index = 1; index <= 5; index += 1) {
    await ctx.db.query(
      `INSERT INTO questions
         (user_id, local_date, timezone, question, question_hash, question_len, topic,
          status, body_md, chars, idem_key, engine_version, prompt_version, created_at)
       VALUES ($1, current_date, 'Europe/Moscow', $2, $3, $4, 'other', 'ready',
               'Ответ карты.', 12, $5, '1.1.0', 'prompts_v1.0', now() - ($6 || ' minutes')::interval)`,
      [userId, `Вопрос номер ${String(index)}?`, `hash-${String(index)}`, 20, `key-${String(index)}`, String(index)],
    );
  }
}

/** Пять заказов совместимости: два готовых и три в работе. */
async function fiveCompat(userId: string, chartId: string): Promise<void> {
  for (let index = 1; index <= 5; index += 1) {
    await ctx.db.query(
      `INSERT INTO reports
         (chart_id, user_id, kind, status, prompt_version, report_structure_version,
          chapters, created_at, updated_at)
       VALUES ($1, $2, 'compat', $3, 'prompts_v1.5', 'structure_v1', NULL,
               now() - ($4 || ' minutes')::interval,
               now() - ($4 || ' minutes')::interval)`,
      [chartId, userId, index <= 2 ? 'ready' : 'writing', String(index)],
    );
  }
}

describe('GET /questions — total до LIMIT', () => {
  it('пять вопросов, limit=2 → two items и total=5', async () => {
    const { userId } = await userWithChart();
    await fiveQuestions(userId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=2')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as QuestionListBody;
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it('offset=4 → один элемент, а total всё ещё пять', async () => {
    const { userId } = await userWithChart();
    await fiveQuestions(userId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=2&offset=4')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as QuestionListBody;
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(5);
    expect(body.offset).toBe(4);
  });

  it('offset за концом списка → пустая страница, total прежний', async () => {
    const { userId } = await userWithChart();
    await fiveQuestions(userId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=2&offset=50')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as QuestionListBody;
    expect(body.items).toHaveLength(0);
    // Ровно то, что сломала бы оконная функция: ноль вместо пяти.
    expect(body.total).toBe(5);
  });

  it('total считает только то, что видно в списке: failed не входит', async () => {
    const { userId } = await userWithChart();
    await fiveQuestions(userId);
    await ctx.db.query(
      `INSERT INTO questions
         (user_id, local_date, timezone, question, question_hash, question_len, topic,
          status, idem_key, engine_version, prompt_version)
       VALUES ($1, current_date, 'Europe/Moscow', 'Провалившийся вопрос?', 'h-fail', 22,
               'other', 'failed', 'key-failed', '1.1.0', 'prompts_v1.0')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=20')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as QuestionListBody;
    expect(body.items).toHaveLength(5);
    expect(body.total).toBe(5);
  });

  it('мусор в limit и offset не даёт 422: параметры приводятся к умолчанию', async () => {
    const { userId } = await userWithChart();
    await fiveQuestions(userId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=abc&offset=-3')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as QuestionListBody;
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(5);
  });

  it('limit больше максимума подрезается до 20, а не отдаёт всё', async () => {
    const { userId } = await userWithChart();
    await fiveQuestions(userId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=1000')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as QuestionListBody;
    expect(body.limit).toBe(20);
    expect(body.total).toBe(5);
  });
});

describe('GET /compatibility — total до LIMIT', () => {
  it('пять заказов, limit=2 → two items и total=5', async () => {
    const { userId, chartId } = await userWithChart();
    await fiveCompat(userId, chartId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/compatibility?limit=2')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as CompatListBody;
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it('refunded и failed не входят ни в список, ни в total', async () => {
    const { userId, chartId } = await userWithChart();
    await fiveCompat(userId, chartId);
    await ctx.db.query(
      `INSERT INTO reports (chart_id, user_id, kind, status, prompt_version, report_structure_version)
       VALUES ($1, $2, 'compat', 'failed', 'prompts_v1.5', 'structure_v1'),
              ($1, $2, 'compat', 'refunded', 'prompts_v1.5', 'structure_v1')`,
      [chartId, userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/compatibility')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as CompatListBody;
    expect(body.items).toHaveLength(5);
    expect(body.total).toBe(5);
  });

  it('offset за концом списка → пусто и total=5', async () => {
    const { userId, chartId } = await userWithChart();
    await fiveCompat(userId, chartId);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/compatibility?limit=2&offset=100')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as CompatListBody;
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(5);
  });
});
