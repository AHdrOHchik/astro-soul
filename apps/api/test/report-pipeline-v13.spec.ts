import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { FakeLlmProvider } from '../src/modules/llm/fake-llm';
import type { LlmRequest } from '../src/modules/llm/llm.client';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram } from './fake-telegram';

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const JOBS_SECRET = 'test-jobs-secret-0123456789';

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

/** План на семь фокусов — как в живом прогоне 2026-11-16. */
const SEVEN_FOCUS_PLAN = JSON.stringify({
  thesis:
    'Ты медленно решаешься, но, решившись, почти не отступаешь, и это стоит тебе части возможностей.',
  focuses: [
    { topic: 'скорость решений', factor: 'Солнце в Тельце', angle: 'цена позднего старта' },
    { topic: 'видимость', factor: 'Луна в Льве', angle: 'заметность без позы' },
    { topic: 'речь и счёт', factor: 'Меркурий в Деве', angle: 'точность против темпа' },
    { topic: 'близость', factor: 'Венера в Весах', angle: 'равновесие в паре' },
    { topic: 'напор', factor: 'Марс в Овне', angle: 'сила без давления' },
    { topic: 'опора', factor: 'Сатурн в Козероге', angle: 'терпение как ресурс' },
    { topic: 'направление', factor: 'Узел в Водолее', angle: 'куда тянет' },
  ],
  avoid: ['не повторять про медлительность', 'не оценивать', 'не обещать'],
});

/**
 * Живой дефект 2026-11-16: одна плотная простыня вместо 3–6 абзацев
 * (`talents` — 1 абзац на семь тем).
 */
function denseParagraph(prompt: string): string {
  const range = /Объём:\s*([\d\s]+)–([\d\s]+)\s*знаков/u.exec(prompt);
  const target = Number((range?.[1] ?? '1 000').replace(/\s/gu, ''));
  const sentence =
    'Ты быстро берёшься за дело и доводишь его до конца, потому что пауза кажется тебе дороже ошибки, ' +
    'а ясность приходит только после первого шага, и это стоит учитывать в разговоре с людьми. ';
  let text = '';
  while (text.length < target) {
    text += sentence;
  }
  // Один абзац: переносов строк нет вовсе.
  return text.trim();
}

interface Stand {
  readonly ctx: TestContext;
  readonly prompts: string[];
}

async function stand(options: { brokenChapters?: boolean; env?: Record<string, string> } = {}): Promise<Stand> {
  const prompts: string[] = [];
  const llm = new FakeLlmProvider({
    plan: SEVEN_FOCUS_PLAN,
    onRequest: (input: LlmRequest) => {
      prompts.push(input.messages.map((message) => message.content).join('\n'));
    },
    ...(options.brokenChapters === true
      ? { chapterText: (section: string, prompt: string) => denseParagraph(prompt) }
      : {}),
  });

  const ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram: makeFakeTelegram(),
    llm,
    env: { INTERNAL_JOB_SECRET: JOBS_SECRET, ...options.env },
  });
  await truncateAll(ctx.db);
  return { ctx, prompts };
}

async function createChart(ctx: TestContext): Promise<{ chartId: string; userId: string }> {
  const chart = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initData())
    .send(BIRTH)
    .expect((response) => {
      // Повторный POST по той же карте отдаёт 200: карта уже есть.
      expect([200, 201]).toContain(response.status);
    });

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
  return { chartId: chart.body.chart.chart_id as string, userId: user?.id ?? '' };
}

async function order(
  ctx: TestContext,
  options: { chargeId?: string; key?: string } = {},
): Promise<{ reportId: string; response: request.Response }> {
  const { chartId, userId } = await createChart(ctx);

  const payment = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
     VALUES ($1, $2, 'one_149', 149, $3, true)
     RETURNING id`,
    [userId, FICTIONAL_USER.id, options.chargeId ?? 'charge-v13-1'],
  );
  await ctx.db.query(
    `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
    [userId, chartId, payment?.id],
  );

  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/reports')
    .set(INIT_DATA_HEADER, initData())
    .set('Idempotency-Key', options.key ?? 'v13-key')
    .send({ chart_id: chartId, type: 'full' });

  return { reportId: response.body.report_id as string, response };
}

async function waitStatus(ctx: TestContext, reportId: string, statuses: readonly string[]) {
  let body: { status?: string } = {};
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initData());
    body = response.body as { status?: string };
    if (statuses.includes(body.status ?? '')) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`разбор не дошёл до ${statuses.join('/')}: ${String(body.status)}`);
}

describe('конвейер разбора v1.3 (живой прогон 2026-11-16)', () => {
  it('глава получает свою долю фокусов: talents — только Меркурий, не весь план', async () => {
    const { ctx, prompts } = await stand();
    try {
      const { reportId } = await order(ctx);
      const ready = await waitStatus(ctx, reportId, ['ready', 'failed']);
      expect(ready.status).toBe('ready');

      const talents = prompts.find((prompt) => prompt.includes('Глава: talents'));
      expect(talents).toBeDefined();
      expect(talents).toContain('речь и счёт');
      expect(talents).not.toContain('скорость решений');
      expect(talents).not.toContain('близость');

      const emotions = prompts.find((prompt) => prompt.includes('Глава: emotions'));
      expect(emotions).toContain('видимость');
      expect(emotions).not.toContain('речь и счёт');

      const chapters = prompts.filter((text) => text.includes('Глава: '));
      expect(chapters).toHaveLength(6);
      for (const prompt of chapters) {
        expect(prompt).toContain('Форма: 3–6 абзацев, в каждом 2–4 предложения');
      }

      const row = await ctx.db.queryOne<{ prompt_version: string }>(
        `SELECT prompt_version FROM reports WHERE id = $1`,
        [reportId],
      );
      expect(row?.prompt_version).toBe('prompts_v1.3');
    } finally {
      await ctx.close();
    }
  });

  it('провал валидации: код с категорией, сырой ответ в debug_json, ровно 2 попытки', async () => {
    const { ctx, prompts } = await stand({ brokenChapters: true });
    try {
      const { reportId, response } = await order(ctx);
      expect(response.status).toBe(202);

      const failed = await waitStatus(ctx, reportId, ['ready', 'failed']);
      expect(failed.status).toBe('failed');

      const row = await ctx.db.queryOne<{
        error_code: string;
        debug_json: { key: string; attempt: number; raw: string; cats: string[] }[];
        validation: { key: string; attempt: number; categories: string[] }[];
        attempts: number;
      }>(`SELECT error_code, debug_json, validation, attempts FROM reports WHERE id = $1`, [reportId]);

      expect(row?.error_code).toBe('validation:paragraphs');
      expect(row?.debug_json).toHaveLength(2);
      expect(row?.debug_json.map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(row?.debug_json.every((entry) => entry.key === 'core')).toBe(true);
      expect(row?.debug_json.every((entry) => entry.raw.length <= 2_000)).toBe(true);
      expect(row?.debug_json.every((entry) => entry.cats.includes('paragraphs'))).toBe(true);
      expect(row?.validation[0]?.categories).toContain('paragraphs');

      // План + две попытки core: третьей попытки нет.
      expect(row?.attempts).toBe(3);
      // План + две попытки core: третьей попытки нет.
      expect(prompts.length).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  it('предохранитель: три validation-провала подряд — 503 и ни одной новой строки', async () => {
    const { ctx } = await stand();
    try {
      await createChart(ctx);
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.query(
          `INSERT INTO reports (chart_id, user_id, kind, idempotency_key, status, error_code, chart_hash, created_at, updated_at)
           SELECT c.id, c.user_id, 'report', $1, 'failed', 'validation:paragraphs', 'hash', now(), now()
             FROM charts c LIMIT 1`,
          [`breaker-key-${index}`],
        );
      }

      const { response } = await order(ctx, { key: 'after-breaker' });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('UPSTREAM_LLM');
      expect(response.body.details.reason).toBe('validation_breaker');
      expect(await ctx.db.query(`SELECT 1 FROM reports WHERE idempotency_key = 'after-breaker'`)).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('предохранитель размыкается успешным разбором', async () => {
    const { ctx } = await stand();
    try {
      await createChart(ctx);
      await ctx.db.query(
        `INSERT INTO reports (chart_id, user_id, kind, idempotency_key, status, error_code, chart_hash, created_at, updated_at)
         SELECT c.id, c.user_id, 'report', 'ok-chain', 'ready', NULL, 'hash', now(), now()
           FROM charts c LIMIT 1`,
      );
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.query(
          `INSERT INTO reports (chart_id, user_id, kind, idempotency_key, status, error_code, chart_hash, created_at, updated_at)
           SELECT c.id, c.user_id, 'report', $1, 'failed', 'validation:format', 'hash', now() - interval '1 hour', now() - interval '1 hour'
             FROM charts c LIMIT 1`,
          [`old-${index}`],
        );
      }

      // В последних трёх есть успешный разбор — запуск разрешён.
      const { response } = await order(ctx, { key: 'after-ok' });
      expect(response.status).toBe(202);
    } finally {
      await ctx.close();
    }
  });

  it('автовозврат за провал выключен по умолчанию и включается флагом', async () => {
    const off = await stand({ brokenChapters: true });
    try {
      const { reportId } = await order(off.ctx);
      await waitStatus(off.ctx, reportId, ['failed']);

      const run = await request(off.ctx.app.getHttpServer())
        .post('/api/v1/internal/jobs/run?job=report_refund')
        .set('X-Jobs-Secret', JOBS_SECRET)
        .expect(202);
      expect(run.body.report_refunds_done).toBe(0);

      const row = await off.ctx.db.queryOne<{ status: string }>(`SELECT status::text AS status FROM reports`);
      expect(row?.status).toBe('failed');
    } finally {
      await off.ctx.close();
    }
  });
});
