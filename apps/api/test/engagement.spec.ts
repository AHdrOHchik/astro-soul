import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { EngagementService } from '../src/modules/engagement/engagement.service';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';
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

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

/**
 * «Сейчас» по Москве в заданный час — тесты не подменяют системные часы.
 * Джоб принимает `at` параметром, поэтому ночь и утро проверяются в любой момент.
 */
function atMoscow(hour: number): Date {
  const local = new Date(Date.now() + MOSCOW_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0, 0) -
      MOSCOW_OFFSET_MS,
  );
}

/** Местная дата карты (Москва) для «сегодня». */
function moscowDate(at: Date): string {
  return new Date(at.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

/** Управляемая модель: тесты задают ответ и считают вызовы. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly calls: LlmRequest[] = [];
  content = 'Спокойный день: сначала одно дело, потом отдых. Вечером лучше не спорить.';
  fail = false;

  complete(input: LlmRequest): Promise<LlmResponse> {
    this.calls.push(input);
    if (this.fail) {
      return Promise.reject(new Error('scripted provider: отказ по требованию теста'));
    }
    return Promise.resolve({
      content: this.content,
      model: this.name,
      usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, costRub: 0.5 },
    });
  }
}

interface Fixture {
  readonly chartId: string;
  readonly userId: string;
}

let ctx: TestContext;
let llm: ScriptedLlm;
let telegram: FakeTelegram;
let engagement: EngagementService;

beforeAll(async () => {
  llm = new ScriptedLlm();
  telegram = makeFakeTelegram();
  ctx = await createTestContext({ astro: makeFakeAstro(), telegram, llm });
  engagement = ctx.app.get(EngagementService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  llm.calls.length = 0;
  telegram.pushes.length = 0;
  telegram.pushOutcome = 'sent';
  llm.content = 'Спокойный день: сначала одно дело, потом отдых. Вечером лучше не спорить.';
  llm.fail = false;
});

/** Пользователь с картой — через тот же API, что и в проде. */
async function userWithChart(birth: unknown = BIRTH): Promise<Fixture> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(birth as Record<string, unknown>)
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

async function backdateChart(chartId: string, interval = '2 days'): Promise<void> {
  await ctx.db.query(`UPDATE charts SET created_at = now() - $2::interval WHERE id = $1`, [
    chartId,
    interval,
  ]);
}

describe('GET /api/v1/engagement/forecast', () => {
  // Главное архитектурное требование итерации: прогноз не генерируется в
  // момент запроса. Нет строки в кэше — 404, а не 20 секунд ожидания.
  it('нет прогноза в кэше → 404 и ни одного вызова модели', async () => {
    const fixture = await userWithChart();

    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/engagement/forecast?chart_id=${fixture.chartId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
    expect(llm.calls).toHaveLength(0);
    expect(await ctx.db.query(`SELECT 1 FROM forecasts`)).toHaveLength(0);
  });

  it('отдаёт то, что положил ночной джоб, без вызова модели', async () => {
    const fixture = await userWithChart();
    // Бесплатной карте джоб пишет прогноз только через сутки после создания.
    await backdateChart(fixture.chartId);
    const at = atMoscow(3);
    await engagement.runNightly(at);
    llm.calls.length = 0;

    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/engagement/forecast?chart_id=${fixture.chartId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.text.length).toBeGreaterThan(0);
    expect(response.body.date).toBe(moscowDate(at));
    expect(response.body.is_paid).toBe(false);
    // Чтение кэша модель не дергает — иначе 20 секунд ожидания вернулись бы.
    expect(llm.calls).toHaveLength(0);
  });

  it('чужая карта → 404, прогнозов других карт не отдаём', async () => {
    await userWithChart();

    const other = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id: 777_000_222 } }))
      .send({ ...BIRTH, birth_date: '1990-01-02' })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/engagement/forecast?chart_id=${other.body.chart.chart_id as string}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);
  });
});

describe('GET /api/v1/engagement/forecast — машинные причины 404 (контракт 1.5.6)', () => {
  it('карты нет → 404 details.reason = no_chart', async () => {
    await userWithChart();

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/engagement/forecast?chart_id=11111111-1111-4111-8111-111111111111')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.body.details).toMatchObject({ reason: 'no_chart' });
  });

  it('карта есть, прогноза ещё нет → 404 details.reason = not_ready', async () => {
    const fixture = await userWithChart();

    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/engagement/forecast?chart_id=${fixture.chartId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.body.details).toMatchObject({ reason: 'not_ready' });
  });

  it('полный текст выдаётся только при активном праве на момент чтения', async () => {
    const fixture = await userWithChart();
    await makePaid(fixture.userId);
    await backdateChart(fixture.chartId);
    const at = atMoscow(3);
    await engagement.runNightly(at);

    const paid = await request(ctx.app.getHttpServer())
      .get(`/api/v1/engagement/forecast?chart_id=${fixture.chartId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(paid.body.is_paid).toBe(true);
    expect(paid.body.text.length).toBeGreaterThan(0);

    // Подписку отменили между генерацией и чтением: `forecast.is_paid` в строке
    // остался true, но права уже нет — человек получает урезанный прогноз.
    await ctx.db.query(`UPDATE subscriptions SET status = 'cancelled'`);

    const afterCancel = await request(ctx.app.getHttpServer())
      .get(`/api/v1/engagement/forecast?chart_id=${fixture.chartId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(afterCancel.body.is_paid).toBe(false);
    const row = await ctx.db.queryOne<{ teaser: string | null }>(
      `SELECT teaser FROM forecasts WHERE chart_id = $1`,
      [fixture.chartId],
    );
    expect(afterCancel.body.text).toBe(row?.teaser ?? '');
  });
});

describe('POST /api/v1/engagement/ask — 404 без карты (контракт 1.5.6)', () => {
  it('карты нет → 404 details.reason = no_chart, модель не вызывается', async () => {
    await userWithChart();

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/engagement/ask')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({
        chart_id: '11111111-1111-4111-8111-111111111111',
        question: 'Что мне поможет сосредоточиться на работе?',
      })
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.body.details).toMatchObject({ reason: 'no_chart' });
    expect(llm.calls).toHaveLength(0);
  });
});

describe('POST /api/v1/engagement/ask', () => {
  function ask(fixture: Fixture, question: string) {
    return request(ctx.app.getHttpServer())
      .post('/api/v1/engagement/ask')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ chart_id: fixture.chartId, question });
  }

  it('бесплатный лимит 1/сутки: второй вопрос → 429 QUOTA_EXCEEDED с reset_at', async () => {
    const fixture = await userWithChart();

    await ask(fixture, 'Что мне поможет сосредоточиться на работе?').expect(200);

    const response = await ask(fixture, 'А что скажет карта про деньги?').expect(429);

    expect(response.body.code).toBe('QUOTA_EXCEEDED');
    expect(response.body.details.quota_code).toBe('ask_daily');
    expect(typeof response.body.details.reset_at).toBe('string');
    expect(Number.isNaN(Date.parse(response.body.details.reset_at as string))).toBe(false);
    // Модель вызвана ровно один раз: отказ не должен стоить токенов.
    expect(llm.calls).toHaveLength(1);
  });

  it('подписка даёт 5 вопросов в сутки', async () => {
    const fixture = await userWithChart();
    await makePaid(fixture.userId);

    for (let index = 0; index < 5; index += 1) {
      await ask(fixture, 'Что важно знать про эту неделю?').expect(200);
    }

    await ask(fixture, 'И ещё один вопрос?').expect(429);
    expect(llm.calls).toHaveLength(5);
  });

  it('запрещённая тема → 200 с мягким отказом, based_on пуст и модель не звалась', async () => {
    const fixture = await userWithChart();

    const response = await ask(fixture, 'Когда я умру и что будет после?').expect(200);

    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.answer).not.toMatch(/через \d+/u);
    expect(response.body.based_on).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('based_on — только реальные позиции карты', async () => {
    const fixture = await userWithChart();
    llm.content = JSON.stringify({
      answer: 'Луна в Льве просит признания, а Солнце в Тельце — устойчивости.',
      based_on: ['Луна в Льве, 11-й дом', 'Солнце в Тельце, 9-й дом', 'Лилит в 8-м доме'],
    });

    const response = await ask(fixture, 'Как мне вести себя с коллегами?').expect(200);

    expect(response.body.based_on).toEqual(['Луна в Льве, 11-й дом', 'Солнце в Тельце, 9-й дом']);
  });

  it('ответ обрезается до 1500 знаков', async () => {
    const fixture = await userWithChart();
    llm.content = 'а'.repeat(2_500);

    const response = await ask(fixture, 'Расскажи подробно про этот год?').expect(200);

    expect(response.body.answer.length).toBe(1_500);
  });

  // ПДн: в БД нет текста вопроса, в событиях — тоже. Только длина и тема.
  it('вопрос не сохраняется: в asks только длина и тема, в events — без текста', async () => {
    const fixture = await userWithChart();
    // Не запрещённая тема (иначе модель не зовётся и строки в `asks` нет),
    // но текст чувствительный — именно такие вопросы нельзя хранить.
    const question = 'Муж изменил, как мне это пережить по карте?';

    await ask(fixture, question).expect(200);

    const row = await ctx.db.queryOne<Record<string, unknown>>(
      `SELECT * FROM asks WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(row).not.toBeNull();
    expect(Object.keys(row ?? {})).not.toContain('question');
    expect(row?.['question_length']).toBe(question.length);
    expect(typeof row?.['topic']).toBe('string');

    const events = await ctx.db.query<{ props: unknown }>(
      `SELECT props FROM events WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(JSON.stringify(events)).not.toContain('изменил');
  });

  it('падение модели возвращает списанную квоту', async () => {
    const fixture = await userWithChart();
    llm.fail = true;

    await ask(fixture, 'Что говорит карта про эту неделю?').expect(500);

    const quota = await ctx.db.queryOne<{ used: number }>(
      `SELECT used FROM quotas WHERE user_id = $1 AND code = 'ask_daily'`,
      [fixture.userId],
    );
    expect(quota?.used ?? 0).toBe(0);
  });

  it('вопрос вне диапазона 3..500 → 422 с field_errors', async () => {
    const fixture = await userWithChart();

    const response = await ask(fixture, 'ok').expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors[0].field).toBe('question');
  });
});

describe('forecast_nightly', () => {
  const at = atMoscow(3);

  it('подписчику пишет полный прогноз, ровно одна строка на карту в сутки', async () => {
    const fixture = await userWithChart();
    await makePaid(fixture.userId);

    const first = await engagement.runNightly(at);
    expect(first.generated).toBe(1);
    expect(first.failed).toBe(0);

    const rows = await ctx.db.query<{ full_text: string | null; is_paid: boolean; date: string }>(
      `SELECT full_text, is_paid, date::text AS date FROM forecasts WHERE chart_id = $1`,
      [fixture.chartId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_paid).toBe(true);
    expect(rows[0]?.full_text).not.toBeNull();
    expect(rows[0]?.date).toBe(moscowDate(at));

    // Повторный запуск идемпотентен: ON CONFLICT DO NOTHING на (chart_id, date).
    const second = await engagement.runNightly(at);
    expect(second.generated).toBe(0);
    expect(await ctx.db.query(`SELECT 1 FROM forecasts`)).toHaveLength(1);
  });

  it('бесплатному — урезанный вариант, и только если карта старше суток', async () => {
    const fresh = await userWithChart();
    expect((await engagement.runNightly(at)).generated).toBe(0);
    expect(await ctx.db.query(`SELECT 1 FROM forecasts WHERE chart_id = $1`, [fresh.chartId])).toHaveLength(0);

    await backdateChart(fresh.chartId);
    await engagement.runNightly(at);

    const row = await ctx.db.queryOne<{ full_text: string | null; teaser: string | null; is_paid: boolean }>(
      `SELECT full_text, teaser, is_paid FROM forecasts WHERE chart_id = $1`,
      [fresh.chartId],
    );
    expect(row?.is_paid).toBe(false);
    expect(row?.full_text).toBeNull();
    expect(row?.teaser).not.toBeNull();
  });

  it('падение модели по одной карте не роняет прогон', async () => {
    llm.content = '';
    const fixture = await userWithChart();
    await makePaid(fixture.userId);

    const result = await engagement.runNightly(at);
    expect(result.failed).toBe(1);
    expect(result.generated).toBe(0);
  });
});

describe('forecast_push', () => {
  const at = atMoscow(8);

  async function forecastFor(fixture: Fixture, text = 'Сегодня лучше начать с одного дела.'): Promise<void> {
    await ctx.db.query(
      `INSERT INTO forecasts (chart_id, date, teaser, full_text, is_paid)
       VALUES ($1, $2::date, $3, $3, true)`,
      [fixture.chartId, moscowDate(at), text],
    );
  }

  it('шлёт 1–2 предложения с кнопкой «Открыть» и ставит отметку', async () => {
    const fixture = await userWithChart();
    await forecastFor(
      fixture,
      'Утро спокойное, но к обеду появится повод ответить резко. Вечером лучше не начинать новых споров. Третий абзац в пуш не попадает.',
    );

    const result = await engagement.runPush(at);

    expect(result.sent).toBe(1);
    expect(telegram.pushes).toHaveLength(1);
    const push = telegram.pushes[0];
    expect(push?.button?.text).toBe('Открыть');
    expect(push?.button?.webAppUrl).toContain(fixture.chartId);
    expect(push?.text).not.toContain('Третий абзац');
    expect(push?.text).not.toContain('Сегодня лучше начать с одного дела.');

    const row = await ctx.db.queryOne<{ push_sent_at: Date | null }>(
      `SELECT push_sent_at FROM forecasts WHERE chart_id = $1`,
      [fixture.chartId],
    );
    expect(row?.push_sent_at).not.toBeNull();

    // Второй прогон в тот же день ничего не отправляет.
    expect((await engagement.runPush(at)).sent).toBe(0);
  });

  it('403 → карта помечается и больше не пушится', async () => {
    const fixture = await userWithChart();
    await forecastFor(fixture);
    telegram.pushOutcome = 'blocked';

    const result = await engagement.runPush(at);
    expect(result.blocked).toBe(1);

    const chart = await ctx.db.queryOne<{ push_blocked_at: Date | null }>(
      `SELECT push_blocked_at FROM charts WHERE id = $1`,
      [fixture.chartId],
    );
    expect(chart?.push_blocked_at).not.toBeNull();

    telegram.pushOutcome = 'sent';
    expect((await engagement.runPush(at)).sent).toBe(0);
  });

  it('429 → pushes_deferred и никакого ретрая в этом прогоне', async () => {
    const fixture = await userWithChart();
    await forecastFor(fixture);
    telegram.pushOutcome = 'rate_limited';

    const result = await engagement.runPush(at);

    expect(result.deferred).toBe(1);
    expect(result.sent).toBe(0);
    const row = await ctx.db.queryOne<{ push_sent_at: Date | null }>(
      `SELECT push_sent_at FROM forecasts WHERE chart_id = $1`,
      [fixture.chartId],
    );
    expect(row?.push_sent_at).toBeNull();
  });

  it('не активному 7 дней не пишем: pushes_skipped_inactive', async () => {
    const fixture = await userWithChart();
    await forecastFor(fixture);
    await ctx.db.query(`DELETE FROM events WHERE user_id = $1`, [fixture.userId]);
    await ctx.db.query(`UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, [
      fixture.userId,
    ]);

    const result = await engagement.runPush(at);

    expect(result.sent).toBe(0);
    expect(result.skippedInactive).toBe(1);
    expect(telegram.pushes).toHaveLength(0);
  });
});
