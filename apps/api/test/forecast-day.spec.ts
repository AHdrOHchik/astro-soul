import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro, type FakeAstro } from './fake-astro';

/**
 * `GET /api/v1/forecast/today` (контракт 1.6.6, итерация 30).
 *
 * Главное, что проверяется, — не «прогноз отдаётся», а три обещания продукта:
 *
 *   1. **Одна генерация в сутки на человека.** Два одновременных запроса дают
 *      ровно один вызов модели: это буквально двойные деньги, а не косметика.
 *   2. **Без подписки модель не вызывается вообще** — `facts_only` на фактах
 *      сайдкара.
 *   3. **Вчерашний текст не отдаётся никогда.** Провал генерации — это `503`,
 *      а не вчерашний прогноз под сегодняшней датой: человек читает такое как
 *      прогноз на сегодня и не может отличить.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const ADMIN_TG_ID = String(FICTIONAL_USER.id);

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

/**
 * Текст нужного объёма: разделы собираются из одинаковых предложений и
 * укладываются в [min…max] без обрезки. Запрещённых тем здесь нет намеренно —
 * тест про форму, а не про фильтр содержания.
 */
function pad(min: number, seed: string): string {
  let text = '';
  while (text.length < min) {
    text += `${seed} Держи ровный темп и не спеши с выводами. `;
  }
  return text.trim();
}

function forecastAnswer(): string {
  return JSON.stringify({
    summary: pad(130, 'День ровный и рабочий.'),
    easier: pad(310, 'Легче даются спокойные дела и разговоры один на один.'),
    careful: pad(310, 'Осторожнее со спешкой и лишними обещаниями.'),
    step: pad(210, 'Один шаг: прогулка без телефона.'),
  });
}

interface ScriptedLlm extends LlmProvider {
  readonly calls: LlmRequest[];
  content: string;
  fail: boolean;
  hang: boolean;
  costRub: number;
}

function makeLlm(): ScriptedLlm {
  const llm: ScriptedLlm = {
    name: 'scripted-forecast',
    calls: [],
    content: forecastAnswer(),
    fail: false,
    hang: false,
    costRub: 0.5,
    complete(input: LlmRequest): Promise<LlmResponse> {
      llm.calls.push(input);
      if (llm.hang) {
        return new Promise<LlmResponse>(() => {
          /* никогда: проверяется ожидание и таймаут */
        });
      }
      if (llm.fail) {
        return Promise.reject(new Error('scripted provider: отказ по требованию теста'));
      }
      return Promise.resolve({
        content: llm.content,
        model: llm.name,
        usage: { promptTokens: 900, completionTokens: 300, totalTokens: 1_200, costRub: llm.costRub },
      });
    },
  };
  return llm;
}

interface ForecastBody {
  readonly date: string;
  readonly timezone: string;
  readonly status: string;
  readonly access: string;
  readonly sections: readonly { key: string; title: string; body: string }[];
  readonly chars: number;
  readonly warnings: readonly string[];
  readonly generated_at: string | null;
  readonly facts: { moon_sign: string; moon_phase: string; illumination: number } | null;
  readonly disclaimer: string;
}

let ctx: TestContext;
let llm: ScriptedLlm;
let astro: FakeAstro;

beforeAll(async () => {
  llm = makeLlm();
  astro = makeFakeAstro();
  ctx = await createTestContext({
    astro,
    llm,
    env: {
      ADMIN_TG_ID,
      // Таймаут генерации в тестах — 2 с вместо 25: ожидание проверяется, но
      // не съедает полминуты на прогон.
      FORECAST_TIMEOUT_MS: '2000',
      FORECAST_RETRY_SECONDS: '60',
    },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  llm.calls.length = 0;
  llm.content = forecastAnswer();
  llm.fail = false;
  llm.hang = false;
  llm.costRub = 0.5;
});

async function userWithChart(): Promise<{ chartId: string; userId: string }> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
  return { chartId: response.body.chart.chart_id as string, userId: user?.id ?? '' };
}

async function makePaid(userId: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO subscriptions (user_id, plan, status, expires_at)
     VALUES ($1, 'month', 'active', now() + interval '30 days')`,
    [userId],
  );
}

function today(): request.Test {
  return request(ctx.app.getHttpServer())
    .get('/api/v1/forecast/today')
    .set(INIT_DATA_HEADER, initDataFor());
}

describe('GET /forecast/today — доступ', () => {
  it('без подписки отдаёт 200 facts_only и не вызывает модель', async () => {
    await userWithChart();

    const response = await today().expect(200);
    const body = response.body as ForecastBody;

    expect(body.status).toBe('facts_only');
    expect(body.access).toBe('facts_only');
    expect(body.sections).toEqual([]);
    expect(body.chars).toBe(0);
    expect(body.generated_at).toBeNull();
    expect(body.facts?.moon_sign).toBeTruthy();
    expect(body.facts?.moon_phase).toBeTruthy();
    expect(body.facts?.illumination).toBeGreaterThanOrEqual(0);
    expect(body.disclaimer.length).toBeGreaterThan(10);
    // Дата — местная дата места рождения, а не серверная.
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    expect(llm.calls).toHaveLength(0);
    const rows = await ctx.db.query(`SELECT 1 FROM daily_forecasts`);
    expect(rows).toHaveLength(0);
  });

  it('без карты — 404 chart_not_found (приложение ведёт в онбординг)', async () => {
    const response = await today().expect(404);
    expect(response.body.details?.reason).toBe('chart_not_found');
  });
});

describe('GET /forecast/today — генерация', () => {
  it('подписка: четыре раздела, 900–1400 знаков, один вызов модели', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    const response = await today().expect(200);
    const body = response.body as ForecastBody;

    expect(body.status).toBe('ready');
    expect(body.access).toBe('subscription');
    expect(body.sections.map((section) => section.key)).toEqual([
      'summary',
      'easier',
      'careful',
      'step',
    ]);
    expect(body.sections.map((section) => section.title)).toEqual([
      'День в одном предложении',
      'Где будет легче',
      'Где осторожнее',
      'Один шаг',
    ]);
    expect(body.chars).toBeGreaterThanOrEqual(900);
    expect(body.chars).toBeLessThanOrEqual(1400);
    expect(body.warnings).toEqual([]);
    expect(body.generated_at).not.toBeNull();
    expect(body.facts).toBeNull();

    expect(llm.calls).toHaveLength(1);

    // Факты пришли из сайдкара и лежат в строке: модель их не выдумывала.
    const row = await ctx.db.queryOne<{ facts: { moon: { sign: string } }; cost_rub: string }>(
      `SELECT facts, cost_rub::text AS cost_rub FROM daily_forecasts`,
    );
    expect(row?.facts.moon.sign).toBeTruthy();
    expect(Number(row?.cost_rub)).toBeCloseTo(0.5, 4);
  });

  it('повторный запрос в тот же день — из сохранённого, без второго вызова', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    const first = await today().expect(200);
    const second = await today().expect(200);

    expect((second.body as ForecastBody).sections).toEqual((first.body as ForecastBody).sections);
    expect(llm.calls).toHaveLength(1);

    const hits = await ctx.db.queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM events WHERE name = 'forecast_cache_hit'`,
    );
    expect(hits?.total).toBe(1);
  });

  it('новая дата — новая строка и новый вызов (вчерашняя не переиспользуется)', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    await today().expect(200);
    // Сдвигаем существующую строку на вчера: так «наступает» новый день без
    // подмены системных часов.
    await ctx.db.query(
      `UPDATE daily_forecasts SET local_date = local_date - 1, created_at = now() - interval '1 day'`,
    );

    const response = await today().expect(200);
    expect((response.body as ForecastBody).status).toBe('ready');
    expect(llm.calls).toHaveLength(2);

    const rows = await ctx.db.query(`SELECT 1 FROM daily_forecasts`);
    expect(rows).toHaveLength(2);
  });

  it('два одновременных запроса — ровно один вызов модели (single-flight)', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    const [a, b] = await Promise.all([today(), today()]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as ForecastBody).status).toBe('ready');
    expect((b.body as ForecastBody).status).toBe('ready');
    expect((a.body as ForecastBody).sections).toEqual((b.body as ForecastBody).sections);

    expect(llm.calls).toHaveLength(1);
    const rows = await ctx.db.query(`SELECT 1 FROM daily_forecasts`);
    expect(rows).toHaveLength(1);
  });

  it('длинный ответ обрезается по границе предложения, текст всё равно приходит', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    // Каждый раздел вдвое длиннее предела: обрезка обязана пройти по точке.
    llm.content = JSON.stringify({
      summary: pad(400, 'День ровный и рабочий.'),
      easier: pad(900, 'Легче даются спокойные дела.'),
      careful: pad(900, 'Осторожнее со спешкой.'),
      step: pad(600, 'Один шаг: прогулка.'),
    });

    const response = await today().expect(200);
    const body = response.body as ForecastBody;

    expect(body.status).toBe('ready');
    for (const section of body.sections) {
      expect(section.body.length).toBeLessThanOrEqual(450);
      // Никаких обрывков: текст кончается знаком конца предложения.
      expect(section.body).toMatch(/[.!?…]$/u);
    }
    expect(body.warnings).toContain('length_off');
  });
});

describe('GET /forecast/today — провалы', () => {
  it('падение модели — 503 forecast_failed, вчерашний текст не отдаётся', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    // Вчерашний готовый прогноз существует.
    await today().expect(200);
    await ctx.db.query(
      `UPDATE daily_forecasts
          SET local_date = local_date - 1, created_at = now() - interval '1 day'`,
    );

    llm.fail = true;
    const response = await today().expect(503);

    expect(response.body.details?.reason).toBe('forecast_failed');
    // `code` уточняет причину для поддержки: обычный отказ провайдера — это
    // `forecast_failed`, а не отдельный публичный код.
    expect(['forecast_failed', 'llm_error']).toContain(response.body.details?.code);
    // Тела прогноза в ошибке нет ни в каком виде.
    expect(JSON.stringify(response.body)).not.toContain('##');
    expect(llm.calls).toHaveLength(2);

    const failed = await ctx.db.queryOne<{ status: string }>(
      `SELECT status FROM daily_forecasts ORDER BY created_at DESC LIMIT 1`,
    );
    expect(failed?.status).toBe('failed');
  });

  it('после провала повтор в течение минуты не тратит второй вызов', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    llm.fail = true;
    await today().expect(503);
    await today().expect(503);

    expect(llm.calls).toHaveLength(1);
  });

  it('три провала подряд открывают брейкер и не вызывают модель', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    // Три провала — три разные даты, иначе сработает пауза повтора, а не брейкер.
    for (let day = 0; day < 3; day += 1) {
      llm.fail = true;
      await today().expect(503);
      await ctx.db.query(
        `UPDATE daily_forecasts SET local_date = local_date - 1, created_at = now() - interval '1 day'`,
      );
    }

    const callsBefore = llm.calls.length;
    llm.fail = false;
    const response = await today().expect(503);

    expect(response.body.details?.reason).toBe('forecast_breaker_open');
    expect(llm.calls).toHaveLength(callsBefore);
  });

  it('неразобранный ответ модели — 503, а не «почти прогноз»', async () => {
    const { userId } = await userWithChart();
    await makePaid(userId);

    llm.content = 'Сегодня хороший день, чтобы начать.';
    const response = await today().expect(503);
    expect(response.body.details?.reason).toBe('forecast_failed');
  });
});
