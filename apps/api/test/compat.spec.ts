import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { JsonLogger, redact } from '../src/common/logger';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram } from './fake-telegram';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';
import { factorsOf } from '../src/modules/compat/compat-facts';
import {
  COMPAT_COVERAGE,
  MAX_SECTIONS_PER_FACTOR,
  compatMatrix,
  coverageOf,
  distributeSections,
} from '../src/modules/compat/compat-focus-map';
import { COMPAT_RANGES, firstTermOffset } from '../src/modules/compat/compat-validators';
import { COMPAT_WINDOW_MS, quotaOf, windowStart } from '../src/modules/compat/compat-quota';
import { COMPAT_PROMPT_VERSION } from '../src/modules/compat/compat-prompts';
import { COMPAT_FACTS_VERSION } from '../src/modules/compat/compat-facts';
import { compatFactsPayload } from './fixtures/compat-facts';
import { compatFactsPairPayload } from './fixtures/compat-facts-pair';
import { costRubOf } from '../src/config/llm-models';
import { COMPAT_STUB_SECTIONS, COMPAT_STUB_FORBIDDEN } from './fixtures/compat-sections';

const JOBS_SECRET = 'test-jobs-secret-0123456789';

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

/**
 * Партнёр в тестах. Дата и время намеренно «узнаваемые»: их отсутствие в
 * логах и в промптах проверить иначе нельзя.
 */
const PARTNER = {
  birth_date: '1990-03-02',
  birth_time: '08:15',
  place: { city_id: 'ru-moscow', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
};

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

interface Fixture {
  readonly chartId: string;
  readonly userId: string;
}

let ctx: TestContext;
let prompts: string[];
let logger: JsonLogger;
let logLines: string[];
/**
 * Задержка «модели». Нужна одному тесту: пока совместимость собирается, второй
 * заказ должен получить отказ, а не второй заказ.
 */
let llmDelayMs = 0;
let llmAnswer: ((prompt: string) => string) | null = null;
/** `usage` подставной модели: тест стоимости подменяет числами из задания. */
let llmUsage = { promptTokens: 900, completionTokens: 300 };
/** Цена за 1000 токенов — та же, что у GigaChat 3 Ultra в `config/llm-models.ts`. */
const LLM_PRICE_PER_1K = 0.5;

class CompatLlm implements LlmProvider {
  readonly name = 'compat-stub';

  async complete(input: LlmRequest): Promise<LlmResponse> {
    const prompt = input.messages.map((message) => message.content).join('\n');
    prompts.push(prompt);

    if (llmDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, llmDelayMs));
    }

    const content = llmAnswer?.(prompt) ?? answerFor(prompt);
    return {
      content,
      model: this.name,
      // Стоимость считается той же функцией, что и в проде, — по токенам.
      usage: {
        ...llmUsage,
        totalTokens: llmUsage.promptTokens + llmUsage.completionTokens,
        costRub: costRubOf(llmUsage, LLM_PRICE_PER_1K),
      },
    };
  }
}

/** Раздел определяется по правилам, которые конвейер вписал в промпт. */
function answerFor(prompt: string): string {
  if (prompt.includes('что у вас совпадает так')) {
    return COMPAT_STUB_SECTIONS.clicks;
  }
  if (prompt.includes('где именно вас заедает')) {
    return COMPAT_STUB_SECTIONS.friction;
  }
  if (prompt.includes('как вы разговариваете, когда не согласны')) {
    return COMPAT_STUB_SECTIONS.scenario;
  }
  if (prompt.includes('три конкретных действия на неделю')) {
    return COMPAT_STUB_SECTIONS.steps;
  }
  return COMPAT_STUB_SECTIONS.clicks;
}

beforeAll(async () => {
  prompts = [];
  logLines = [];
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram: makeFakeTelegram(),
    llm: new CompatLlm(),
    env: { ADMIN_TG_ID: String(FICTIONAL_USER.id), INTERNAL_JOB_SECRET: JOBS_SECRET },
  });

  logger = ctx.app.get(JsonLogger);
});

/**
 * Перехват логов. Ставится в каждом тесте заново: `restoreAllMocks` в
 * `afterEach` снимает шпионов, и один раз на файл их ставить нельзя.
 */
function spyOnLogs(): void {
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation(((message: string, fields: Record<string, unknown>) => {
      // Пишем ровно то, что ушло бы в stdout: с редукцией ПДн, как в проде.
      const line = JSON.stringify(redact(fields), (_key, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack }
          : value,
      );
      logLines.push(`${level} ${message} ${line}`);
    }) as never);
  }
}

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  prompts.length = 0;
  logLines.length = 0;
  llmDelayMs = 0;
  llmAnswer = null;
  llmUsage = { promptTokens: 900, completionTokens: 300 };
  spyOnLogs();
});

afterEach(() => {
  delete process.env['COMPAT_BREAKER_ENABLED'];
  vi.restoreAllMocks();
});

/** Пользователь с картой — тем же API, что и в проде. */
async function userWithChart(): Promise<Fixture> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
  return { chartId: response.body.chart.chart_id as string, userId: user?.id ?? '' };
}

/** Разовая покупка совместимости (как после оплаты `compat_249`). */
async function grantCompat(fixture: Fixture): Promise<string> {
  const row = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO entitlements (user_id, kind, status) VALUES ($1, 'compat', 'active') RETURNING id`,
    [fixture.userId],
  );
  return row?.id ?? '';
}

async function grantSubscription(fixture: Fixture, startedAt = 'now()'): Promise<void> {
  await ctx.db.query(
    `INSERT INTO subscriptions (user_id, plan, status, created_at, expires_at)
     VALUES ($1, 'month', 'active', ${startedAt}, now() + interval '20 days')`,
    [fixture.userId],
  );
}

function orderCompat(fixture: Fixture, key = 'compat-key-1', body: unknown = null) {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/compatibility')
    .set(INIT_DATA_HEADER, initDataFor())
    .set('Idempotency-Key', key)
    .send(body ?? { chart_id: fixture.chartId, relationship: 'romantic', partner: PARTNER });
}

async function waitFor(compatibilityId: string, statuses: readonly string[]): Promise<Response> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/compatibility/${compatibilityId}`)
      .set(INIT_DATA_HEADER, initDataFor());

    if (statuses.includes(response.body.status as string)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`совместимость ${compatibilityId} не дошла до ${statuses.join('/')}`);
}

describe('POST /api/v1/synastry (контракт фактов)', () => {
  it('фикстура посчитана движком и проходит проверку формы', () => {
    // Числа в фикстуре — из `packages/astro`, а не придуманные: если движок
    // поменяет формат, упадёт здесь, а не в проде.
    expect(compatFactsPayload.version).toBe(COMPAT_FACTS_VERSION);
    expect(compatFactsPayload.cross_aspects.length).toBeGreaterThan(20);
    expect(compatFactsPayload.luminaries.map((block) => block.pair)).toEqual([
      'sun-moon',
      'moon-moon',
      'venus-mars',
      'sun-sun',
    ]);
    expect(compatFactsPayload.house_overlays).toBeDefined();
  });
});

describe('раскладка фактов: не больше двух разделов на факт', () => {
  it('лимит закреплён константой', () => {
    expect(MAX_SECTIONS_PER_FACTOR).toBe(2);
  });

  it('фактор, годный во все четыре раздела, звучит ровно в двух', () => {
    const sections = Object.values(COMPAT_COVERAGE['aspect_venus_mars'] ?? {});
    // Не пустая проверка: без лимита тот же фактор уходит во все четыре.
    expect(sections).toHaveLength(4);

    const factor = {
      id: 'aspect:venus-mars',
      category: 'aspect_venus_mars',
      family: 'aspect' as const,
      label: 'Венера — квадрат — Марс, орб 1,2°',
      significance: 1,
    };

    const capped = distributeSections([factor]);
    const uncapped = distributeSections([factor], { maxPerFactor: 4 });

    const countCapped = Object.values(capped.bySection).filter((list) =>
      list.some((item) => item.id === factor.id),
    ).length;
    const countUncapped = Object.values(uncapped.bySection).filter((list) =>
      list.some((item) => item.id === factor.id),
    ).length;

    expect(countCapped).toBe(MAX_SECTIONS_PER_FACTOR);
    expect(countUncapped).toBe(4);
  });

  it('на живых фактах пары ни один факт не выходит за лимит', () => {
    const factors = factorsOf(compatFactsPayload);
    const distribution = distributeSections(factors);

    const usage = new Map<string, string[]>();
    for (const [section, list] of Object.entries(distribution.bySection)) {
      for (const factor of list) {
        usage.set(factor.id, [...(usage.get(factor.id) ?? []), section]);
      }
    }

    for (const [id, sections] of usage) {
      expect(sections.length, `факт ${id} звучит в ${sections.join(', ')}`).toBeLessThanOrEqual(
        MAX_SECTIONS_PER_FACTOR,
      );
    }

    // Раскладка не вырождена: факты вообще дошли до разделов.
    expect(usage.size).toBeGreaterThan(4);
  });
});

describe('квота совместимости: покупка и подписка', () => {
  const NOW = new Date('2026-11-16T12:00:00.000Z');

  it('разовая покупка даёт одну совместимость', () => {
    expect(
      quotaOf({ purchaseCredit: true, subscription: null, lastReadyAt: null, now: NOW }),
    ).toEqual({ kind: 'purchase', left: 1, resets_at: null });
  });

  it('без покупки и подписки прав нет', () => {
    expect(
      quotaOf({ purchaseCredit: false, subscription: null, lastReadyAt: null, now: NOW }),
    ).toEqual({ kind: 'none', left: 0, resets_at: null });
  });

  it('подписка без готовых: одна совместимость доступна сразу', () => {
    const subscription = {
      startedAt: new Date('2026-11-01T09:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    };

    expect(
      quotaOf({ purchaseCredit: false, subscription, lastReadyAt: null, now: NOW }),
    ).toEqual({ kind: 'subscription', left: 1, resets_at: null });
  });

  it('окно считается от последней готовой: `resets_at` = она + 30 дней', () => {
    const subscription = {
      startedAt: new Date('2026-10-01T09:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    };
    const lastReadyAt = new Date('2026-11-06T09:00:00.000Z');

    // Готовая 10 дней назад: при якоре «30 дней назад от сейчас» окно
    // открылось бы через 20 дней, а не через 30.
    const used = quotaOf({ purchaseCredit: false, subscription, lastReadyAt, now: NOW });
    expect(used.kind).toBe('subscription');
    expect(used.left).toBe(0);
    expect(used.resets_at).toBe(new Date(lastReadyAt.getTime() + COMPAT_WINDOW_MS).toISOString());
    expect(windowStart(subscription, lastReadyAt)).toEqual(lastReadyAt);

    // Через 30 дней и минуту после готовой окно открыто.
    const later = new Date(lastReadyAt.getTime() + COMPAT_WINDOW_MS + 60_000);
    expect(quotaOf({ purchaseCredit: false, subscription, lastReadyAt, now: later })).toEqual({
      kind: 'subscription',
      left: 1,
      resets_at: null,
    });
  });

  it('готовая по прошлой подписке не тратит новую', () => {
    const subscription = {
      startedAt: new Date('2026-11-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    };
    // Готовая собрана до начала текущей подписки — окно не начинается.
    expect(windowStart(subscription, new Date('2026-10-20T00:00:00.000Z'))).toBeNull();
  });
});

describe('POST /api/v1/compatibility', () => {
  it('без права → 402 и ни одного заказа', async () => {
    const fixture = await userWithChart();

    const response = await orderCompat(fixture).expect(402);

    expect(response.body.code).toBe('PAYMENT_REQUIRED');
    expect(response.body.details.reason).toBe('compat_not_paid');
    expect(await ctx.db.query(`SELECT 1 FROM reports`)).toHaveLength(0);
  });

  it('без Idempotency-Key → 422 с полем заголовка', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/compatibility')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ chart_id: fixture.chartId, relationship: 'romantic', partner: PARTNER })
      .expect(422);

    expect(response.body.details.field_errors[0].field).toBe('Idempotency-Key');
  });

  it('свободный текст о партнёре запрещён: лишнее поле — 422, а не тишина', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const response = await orderCompat(fixture, 'with-name', {
      chart_id: fixture.chartId,
      relationship: 'romantic',
      partner: { ...PARTNER, name: 'Аня' },
    }).expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(await ctx.db.query(`SELECT 1 FROM compat_partners`)).toHaveLength(0);
  });

  it('полный прогон: четыре раздела, версии и стоимость в БД', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    expect(accepted.body).toEqual({
      compatibility_id: expect.any(String),
      status: 'pending',
    });

    const ready = await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);
    expect(ready.body.status, JSON.stringify(ready.body.error_code)).toBe('ready');
    const sections = ready.body.sections as { key: string; title: string; text: string }[];
    expect(sections).toHaveLength(4);
    expect(sections.map((section) => section.key)).toEqual([
      'clicks',
      'friction',
      'scenario',
      'steps',
    ]);

    for (const section of sections) {
      const range = COMPAT_RANGES.find((item) => item.key === section.key);
      expect(range, `раздел ${section.key}`).toBeDefined();
      // Подпись-дисклеймер в объём не входит — считаем так же, как валидатор.
      const text = section.text.replace(
        '\n\nРазбор — инструмент саморефлексии, а не предсказание и не замена специалисту.',
        '',
      );
      expect(text.length, `${section.key}: ${text.length}`).toBeGreaterThanOrEqual(
        (range?.min ?? 0) * 0.7,
      );
      expect(text.length).toBeLessThanOrEqual((range?.max ?? 0) * 1.3);
    }

    // Первые 200 знаков — без астрологических терминов (как у тизера).
    for (const section of sections) {
      const offset = firstTermOffset(section.text);
      expect(offset === null || offset >= 200, `${section.key}: термин на ${offset}`).toBe(true);
    }

    const row = await ctx.db.queryOne<{
      prompt_version: string;
      chart_facts_version: string;
      model: string;
      llm_cost_rub: string;
      status: string;
    }>(
      `SELECT prompt_version, chart_facts_version, model, llm_cost_rub::text, status::text
         FROM reports WHERE id = $1`,
      [accepted.body.compatibility_id],
    );
    expect(row?.prompt_version).toBe(COMPAT_PROMPT_VERSION);
    expect(row?.prompt_version).toBe('prompts_v1.5');
    expect(row?.chart_facts_version).toBe(COMPAT_FACTS_VERSION);
    expect(row?.model).toBe('compat-stub');
    // Четыре раздела по 1 200 токенов (900 вход + 300 выход) по 0,5 ₽/1000
    // токенов — 0,6 ₽ за вызов, 2,4 ₽ за разбор, без перегенераций.
    expect(Number(row?.llm_cost_rub)).toBe(2.4);

    // Кредит израсходован вместе со статусом `ready`.
    const credit = await ctx.db.queryOne<{ used_at: Date | null }>(
      `SELECT used_at FROM entitlements WHERE kind = 'compat'`,
    );
    expect(credit?.used_at).not.toBeNull();
  });

  it('пока совместимость собирается, второй заказ → 422 compat_already_owned', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);
    llmDelayMs = 40;

    const first = await orderCompat(fixture, 'key-one').expect(202);
    const second = await orderCompat(fixture, 'key-two').expect(422);

    expect(second.body.details.reason).toBe('compat_already_owned');
    expect(second.body.details.field_errors[0].field).toBe('chart_id');

    await waitFor(first.body.compatibility_id as string, ['ready', 'failed']);
    expect(
      await ctx.db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM compat_partners`,
      ),
    ).toEqual({ count: '1' });
  });

  it('после готовой разовой покупки новых прав нет → 402', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture, 'key-one').expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    const again = await orderCompat(fixture, 'key-two').expect(402);
    expect(again.body.details.reason).toBe('compat_not_paid');
  });

  it('провал не списывает кредит и не пишет разделы', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);
    llmAnswer = () => COMPAT_STUB_FORBIDDEN;

    const accepted = await orderCompat(fixture).expect(202);
    const failed = await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    expect(failed.body.status).toBe('failed');
    expect(failed.body.sections).toEqual([]);
    expect(typeof failed.body.error_code).toBe('string');

    const credit = await ctx.db.queryOne<{ used_at: Date | null }>(
      `SELECT used_at FROM entitlements WHERE kind = 'compat'`,
    );
    expect(credit?.used_at).toBeNull();

    // Следующий заказ возможен: кредит на месте.
    const retry = await orderCompat(fixture, 'key-two').expect(202);
    expect(retry.body.status).toBe('pending');
  });
});

describe('покупка `compat_249`: второй раз не продаём', () => {
  it('неизрасходованная покупка → 422 compat_already_owned, а не второй счёт', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'compat_249' })
      .expect(422);

    expect(response.body.details.reason).toBe('compat_already_owned');
    expect(response.body.details.field_errors[0].field).toBe('chart_id');
  });

  it('после израсходованной покупки счёт выставляется снова', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'compat_249' })
      .expect(201);
  });
});

describe('подписка: одна совместимость в 30 дней', () => {
  /**
   * Замок окна подписки — дословно по заданию: подписка активна и не
   * израсходована → 202; заказ доходит до `ready`; сразу второй заказ → 422
   * с `resets_at` = **дата первой готовой + 30 дней** (не «+20» и не «месяц
   * от начала подписки»); часы на `resets_at` + 1 минуту → снова 202.
   *
   * Часы сдвигаются не подменой `Date.now`, а сдвигом якоря окна в БД:
   * окно считается от `finished_at` готовой совместимости, поэтому «сдвинуть
   * время вперёд» и «сдвинуть якорь назад» — одно и то же действие (см.
   * `compat-quota.ts#windowStart`).
   */
  it('замок: 202 → ready → 422 с `resets_at` = первая готовая + 30 дней → 202', async () => {
    const fixture = await userWithChart();
    await grantSubscription(fixture, `now() - interval '2 days'`);

    const accepted = await orderCompat(fixture, 'lock-one').expect(202);
    const id = accepted.body.compatibility_id as string;
    await waitFor(id, ['ready']);

    const report = await ctx.db.queryOne<{ finished_at: Date }>(
      `SELECT finished_at FROM reports WHERE id = $1`,
      [id],
    );
    const readyAt = report?.finished_at as Date;
    const resetsAt = new Date(readyAt.getTime() + COMPAT_WINDOW_MS);

    const second = await orderCompat(fixture, 'lock-two').expect(422);
    expect(second.body.details.reason).toBe('compat_quota_exhausted');
    expect(second.body.details.resets_at).toBe(resetsAt.toISOString());
    // Не «20 дней от сейчас» и не «месяц от начала подписки»: разница ровно 30 дней.
    expect(resetsAt.getTime() - readyAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);

    // Подписка началась 40 дней назад: якорем остаётся готовая, а не дата оплаты.
    await ctx.db.query(`UPDATE subscriptions SET created_at = now() - interval '40 days'`);

    // Через 20 дней окно ещё закрыто (а не «уже открыто», как было бы при
    // якоре «30 дней назад от сейчас»).
    await ctx.db.query(
      `UPDATE reports SET finished_at = now() - interval '20 days' WHERE id = $1`,
      [id],
    );
    const stillClosed = await orderCompat(fixture, 'lock-three').expect(422);
    expect(stillClosed.body.details.reason).toBe('compat_quota_exhausted');

    // Часы на `resets_at` + 1 минуту — то есть якорь на 30 дней и минуту назад.
    await ctx.db.query(
      `UPDATE reports SET finished_at = now() - interval '30 days' - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await orderCompat(fixture, 'lock-four').expect(202);
  });

  it('первый заказ проходит, второй → 422 с `resets_at`, список показывает остаток', async () => {
    const fixture = await userWithChart();
    await grantSubscription(fixture, `now() - interval '2 days'`);

    const before = await request(ctx.app.getHttpServer())
      .get('/api/v1/compatibility')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(before.body.quota).toMatchObject({ kind: 'subscription', left: 1, resets_at: null });

    const accepted = await orderCompat(fixture, 'sub-one').expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    const exhausted = await orderCompat(fixture, 'sub-two').expect(422);
    expect(exhausted.body.details.reason).toBe('compat_quota_exhausted');
    expect(exhausted.body.details.field_errors[0].field).toBe('chart_id');
    expect(typeof exhausted.body.details.resets_at).toBe('string');

    const after = await request(ctx.app.getHttpServer())
      .get('/api/v1/compatibility')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].titles_only).toHaveLength(4);
    expect(after.body.quota.kind).toBe('subscription');
    expect(after.body.quota.left).toBe(0);
    expect(after.body.quota.resets_at).toBe(exhausted.body.details.resets_at);
  });

  it('сдвиг времени на 31 день открывает окно', async () => {
    const fixture = await userWithChart();
    await grantSubscription(fixture, `now() - interval '40 days'`);

    const accepted = await orderCompat(fixture, 'sub-one').expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    await orderCompat(fixture, 'sub-two').expect(422);

    // Та же подписка, но готовая совместимость — 31 день назад.
    await ctx.db.query(
      `UPDATE reports SET finished_at = now() - interval '31 days' WHERE kind = 'compat'`,
    );

    await orderCompat(fixture, 'sub-three').expect(202);
  });

  it('подписка кончилась → 402, а не 422', async () => {
    const fixture = await userWithChart();
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, created_at, expires_at)
       VALUES ($1, 'month', 'expired', now() - interval '40 days', now() - interval '1 day')`,
      [fixture.userId],
    );

    const response = await orderCompat(fixture).expect(402);
    expect(response.body.details.reason).toBe('compat_not_paid');
  });
});

describe('ПДн партнёра', () => {
  it('не уходят в промпт: модель видит факты пары, а не дату и место', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).not.toContain(PARTNER.birth_date);
      expect(prompt).not.toContain(PARTNER.birth_time);
      expect(prompt).not.toContain('55.7558');
      expect(prompt).not.toContain(fixture.userId);
      // В промпте — углы и следствия, а не «Москва».
      expect(prompt).not.toContain('Москва');
    }
  });

  it('не уходят в логи: только идентификаторы и тип отношений', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    const compatibilityId = accepted.body.compatibility_id as string;
    await waitFor(compatibilityId, ['ready', 'failed']);

    const logged = logLines.join('\n');
    expect(logged).not.toContain(PARTNER.birth_date);
    expect(logged).not.toContain(PARTNER.birth_time);
    expect(logged).not.toContain('55.7558');
    expect(logged).not.toContain('37.6173');
    // Идентификаторы в логах есть — иначе разбор инцидента невозможен.
    expect(logged).toContain(compatibilityId);
    expect(logged).toContain('romantic');
  });

  it('свободного текста нет ни в одной колонке `compat_partners`', async () => {
    const columns = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'compat_partners'
        ORDER BY column_name`,
    );

    expect(columns.map((row) => row.column_name)).toEqual([
      'birth_date',
      'birth_time',
      'city_id',
      'created_at',
      'id',
      'lat',
      'lon',
      'relationship',
      'tz',
      'user_id',
    ]);
  });
});

describe('DELETE /api/v1/me: данные партнёра удаляются той же транзакцией', () => {
  it('после удаления в БД нет ни совместимостей, ни партнёров', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    const before = await ctx.db.queryOne<{ reports: string; partners: string }>(
      `SELECT
         (SELECT count(*)::text FROM reports WHERE kind = 'compat') AS reports,
         (SELECT count(*)::text FROM compat_partners) AS partners`,
    );
    expect(before).toEqual({ reports: '1', partners: '1' });

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    // Проверяем запросом к БД, а не ответом API: ответ 204 говорит только о
    // том, что ручка отработала.
    const after = await ctx.db.queryOne<{ reports: string; partners: string }>(
      `SELECT
         (SELECT count(*)::text FROM reports WHERE kind = 'compat') AS reports,
         (SELECT count(*)::text FROM compat_partners) AS partners`,
    );
    expect(after).toEqual({ reports: '0', partners: '0' });

    const orphans = await ctx.db.query(
      `SELECT 1 FROM reports WHERE compat_partner_id IS NOT NULL`,
    );
    expect(orphans).toHaveLength(0);
  });
});

describe('срок хранения: данные партнёра удаляются существующим джобом', () => {
  it('через 24 месяца партнёр удалён, а оплаченный текст остаётся', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    const id = accepted.body.compatibility_id as string;
    await waitFor(id, ['ready', 'failed']);

    // Состарили данные партнёра, не трогая сам заказ.
    await ctx.db.query(
      `UPDATE compat_partners SET created_at = now() - interval '25 months'`,
    );

    const run = await request(ctx.app.getHttpServer())
      .post('/api/v1/internal/jobs/run')
      .set('X-Jobs-Secret', JOBS_SECRET)
      .query({ job: 'pdn_retention_cleanup' })
      .expect(202);

    expect(run.body.pdn_compat_partners_deleted).toBe(1);

    const partners = await ctx.db.query(`SELECT 1 FROM compat_partners`);
    expect(partners).toHaveLength(0);

    // Текст покупки не пропал: ПДн партнёра в нём нет, удалять его незачем.
    const report = await ctx.db.queryOne<{ id: string; partner_id: string | null }>(
      `SELECT id, compat_partner_id::text AS partner_id FROM reports WHERE id = $1`,
      [id],
    );
    expect(report?.id).toBe(id);
    expect(report?.partner_id).toBeNull();
  });
});

describe('брейкер совместимости отдельный от брейкера разбора', () => {
  it('три провала совместимости закрывают совместимость и не трогают разбор', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    for (let index = 0; index < 3; index += 1) {
      await ctx.db.query(
        `INSERT INTO reports (chart_id, user_id, kind, status, idempotency_key, error_code,
                              model, prompt_version, report_structure_version, chart_facts_version)
         VALUES ($1, $2, 'compat', 'failed', $3, 'paragraphs', 'stub', 'prompts_v1.5',
                 'compat_structure_v1', '1.0')`,
        [fixture.chartId, fixture.userId, `broken-${String(index)}`],
      );
    }

    const blocked = await orderCompat(fixture, 'after-breaks').expect(503);
    expect(blocked.body.details.reason).toBe('compat_breaker_open');

    const metrics = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(metrics.body.compat_validation_streak).toBe(3);
    expect(metrics.body.compat_breaker_open).toBe(true);
    // Разбор этим закрыт не был.
    expect(metrics.body.reports_breaker_open).toBe(false);
    expect(metrics.body.reports_validation_streak).toBe(0);
  });

  it('три провала разбора не закрывают совместимость', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    for (let index = 0; index < 3; index += 1) {
      await ctx.db.query(
        `INSERT INTO reports (chart_id, user_id, kind, status, idempotency_key, error_code,
                              model, prompt_version, report_structure_version, chart_facts_version)
         VALUES ($1, $2, 'report', 'failed', $3, 'paragraphs', 'stub', 'prompts_v1.4',
                 'structure_v1', 'v1.2')`,
        [fixture.chartId, fixture.userId, `report-broken-${String(index)}`],
      );
    }

    const accepted = await orderCompat(fixture, 'compat-ok').expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    const metrics = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(metrics.body.reports_breaker_open).toBe(true);
    expect(metrics.body.compat_breaker_open).toBe(false);
    expect(metrics.body.compat_ready_30d).toBe(1);
  });

  it('метрики совместимости считаются по своим строкам', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    const accepted = await orderCompat(fixture).expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready', 'failed']);

    const metrics = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(metrics.body.compat_ready_30d).toBe(1);
    expect(metrics.body.compat_failed_30d).toBe(0);
    // Кредит израсходован — свободных совместимостей не осталось.
    expect(metrics.body.compat_credits_left).toBe(0);
  });
});

describe('стоимость: токены, а не знаки', () => {
  it('1 000 вход + 500 выход токенов по 0,5 ₽/1000 — ровно 0,75 ₽', () => {
    // Точное значение без плавающей пыли: 1 500 токенов — полтора «пакета».
    expect(costRubOf({ promptTokens: 1_000, completionTokens: 500 }, 0.5)).toBe(0.75);
    expect(costRubOf({ promptTokens: 18_264, completionTokens: 0 }, 0.5)).toBe(9.132);
  });

  it('в базе `llm_cost_rub` = сумма по `usage` провайдера, а не по длине строки', async () => {
    const fixture = await userWithChart();
    await grantCompat(fixture);

    // Подставная модель «тратит» 1 000 + 500 токенов за вызов. Длина промпта
    // в знаках при этом втрое больше — если бы стоимость считалась по знакам,
    // число в базе было бы другим.
    llmUsage = { promptTokens: 1_000, completionTokens: 500 };

    const accepted = await orderCompat(fixture, 'cost-one').expect(202);
    await waitFor(accepted.body.compatibility_id as string, ['ready']);

    const row = await ctx.db.queryOne<{ llm_cost_rub: string }>(
      `SELECT llm_cost_rub::text FROM reports WHERE id = $1`,
      [accepted.body.compatibility_id],
    );

    // Четыре раздела по одному вызову без перегенераций: 4 × 0,75 = 3,00 ₽.
    expect(Number(row?.llm_cost_rub)).toBe(3);
    expect(prompts).toHaveLength(4);
    // Промпты действительно длиннее 1 500 знаков: счёт по знакам дал бы другое число.
    expect(prompts.every((prompt) => prompt.length > 1_500)).toBe(true);
  });
});

describe('факты пары: четыре семейства доходят до текста', () => {
  const facts = compatFactsPairPayload;

  it('в фактах пары есть все четыре семейства', () => {
    const families = new Set(factorsOf(facts).map((factor) => factor.family));
    expect([...families].sort()).toEqual(['aspect', 'balance', 'luminary', 'overlay']);
  });

  it('в матрице есть минимум по одному факту каждого семейства', () => {
    const list = factorsOf(facts);
    const distribution = distributeSections(list);
    const matrix = compatMatrix(distribution);

    for (const family of ['aspect', 'luminary', 'balance', 'overlay'] as const) {
      expect(
        matrix.filter((row) => row.family === family).length,
        `семейство ${family} в тексте`,
      ).toBeGreaterThan(0);
    }

    // Лимит не ослаблен: ни один факт не звучит больше двух раз.
    expect(matrix.every((row) => row.count <= MAX_SECTIONS_PER_FACTOR)).toBe(true);

    // Светила — отдельными фактами, а не только подписью к аспекту.
    expect(matrix.some((row) => row.factor.startsWith('luminary:'))).toBe(true);
    // Оверлеи дошли до текста, и это не единственный их раздел.
    expect(matrix.filter((row) => row.family === 'overlay').length).toBeGreaterThan(0);

    const coverage = coverageOf(list, distribution);
    expect(coverage.familiesMissing).toEqual([]);
    expect(coverage.reached).toBeGreaterThan(6);
  });

  it('без времени рождения оверлеев нет ни в фактах, ни в матрице', () => {
    const withoutOverlays = { ...facts } as Record<string, unknown>;
    delete withoutOverlays['house_overlays'];

    const list = factorsOf(withoutOverlays as never);
    const distribution = distributeSections(list);
    const matrix = compatMatrix(distribution);

    expect(list.some((factor) => factor.family === 'overlay')).toBe(false);
    expect(matrix.some((row) => row.family === 'overlay')).toBe(false);
    expect(coverageOf(list, distribution).familiesMissing).toEqual(['overlay']);
    // Остальные три семейства на месте: отсутствие домов не обнуляет текст.
    expect(coverageOf(list, distribution).familiesReached).toEqual([
      'aspect',
      'luminary',
      'balance',
    ]);
  });

  it('разница меньше 8 п.п. фактом не считается: у одинаковых карт балансов нет', () => {
    const list = factorsOf(compatFactsPayload);
    expect(list.some((factor) => factor.family === 'balance')).toBe(false);
    expect(list.some((factor) => factor.family === 'luminary')).toBe(true);
  });

  it('не дошедшие до текста факты объяснены, а не просто пропущены', () => {
    const distribution = distributeSections(factorsOf(facts));
    expect(distribution.skipped.length).toBeGreaterThan(0);
    for (const skipped of distribution.skipped) {
      expect(skipped.reason.length).toBeGreaterThan(0);
    }
  });
});
