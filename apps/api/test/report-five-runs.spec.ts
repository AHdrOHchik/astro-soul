import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { DISCLAIMER } from '../src/modules/reports/validators';
import { MISSING_SECTIONS_NOTE } from '../src/modules/reports/reports.service';
import { splitParagraphs, splitSentences } from '../src/modules/reports/validators';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  // время меняется по прогонам: одна карта не даёт заказать второй разбор
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

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

class DenseProvider implements LlmProvider {
  readonly name = 'harness-dense';
  calls = 0;

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

    if (prompt.includes('заключительную главу «Итог')) {
      return Promise.resolve(
        this.answer(
          [
            POOL.slice(1, 4).join(' '),
            POOL.slice(5, 8).join(' '),
            POOL.slice(9, 12).join(' '),
          ].join('\n\n'),
        ),
      );
    }

    // Ровно то, на чём падал живой прогон: одна простыня без абзацев.
    return Promise.resolve(this.answer(POOL.join(' ')));
  }

  private answer(content: string): LlmResponse {
    return {
      content,
      model: this.name,
      usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, costRub: 0.5 },
    };
  }
}

let ctx: TestContext;
let telegram: FakeTelegram;

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    llm: new DenseProvider(),
    env: { INTERNAL_JOB_SECRET: 'test-jobs-secret-0123456789', ADMIN_TG_ID: String(FICTIONAL_USER.id) },
  });
});

afterAll(async () => {
  await ctx.close();
});

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

/**
 * Приёмка итерации 18: пять разборов подряд на провайдере, который отдаёт
 * ровно тот дефект, из-за которого падал живой прогон 16.11.2026, — одну
 * простыню без абзацев и без дисклеймера в «Итоге».
 *
 * Результат печатается таблицей: по каждому прогону видно число живых глав,
 * `attempts` (перегенераций нет), `validation` (жёстких провалов нет) и
 * форму каждой главы: `core:4п(4/4/4/4)` — четыре абзаца по четыре
 * предложения, в скобках — правки нормализатора.
 */
describe('прогон: пять разборов подряд', () => {
  it('5/5 ready, у каждой ≥6 глав ok, форма в норме', async () => {
    await truncateAll(ctx.db);
    const runs: string[] = [];

    for (let run = 1; run <= 5; run += 1) {
      const chart = await request(ctx.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initData())
        .send({ ...BIRTH, birth_time: `1${run}:20` })
        .expect(201);
      const chartId = chart.body.chart.chart_id as string;
      const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
      const userId = user?.id ?? '';

      const payment = await ctx.db.queryOne<{ id: string }>(
        `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id, processed)
         VALUES ($1, $2, 'one_149', 149, $3, true) RETURNING id`,
        [userId, FICTIONAL_USER.id, `charge-harness-${run}`],
      );
      await ctx.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
        [userId, chartId, payment?.id],
      );

      const order = await request(ctx.app.getHttpServer())
        .post('/api/v1/reports')
        .set(INIT_DATA_HEADER, initData())
        .set('Idempotency-Key', `harness-${run}`)
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      const reportId = order.body.report_id as string;
      let ready = order;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        ready = await request(ctx.app.getHttpServer())
          .get(`/api/v1/reports/${reportId}`)
          .set(INIT_DATA_HEADER, initData());
        if (['ready', 'failed'].includes(ready.body.status as string)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const sections = ready.body.sections as { key: string; body_md: string }[];
      const row = await ctx.db.queryOne<{
        section_status: Record<string, string>;
        normalization: Record<string, { normalized: string[]; warnings: string[] }> | null;
        validation: unknown[] | null;
        attempts: number;
        llm_cost_rub: string;
      }>(
        `SELECT section_status, normalization, validation, attempts, llm_cost_rub FROM reports WHERE id = $1`,
        [reportId],
      );

      const okChapters = Object.values(row?.section_status ?? {}).filter((status) => status === 'ok').length;
      const shape = sections.map((section) => {
        const paragraphs = splitParagraphs(section.body_md);
        const counts = paragraphs.map((paragraph) => splitSentences(paragraph).length);
        return `${section.key}:${paragraphs.length}п(${counts.join('/')}) [${(row?.normalization?.[section.key]?.normalized ?? []).join(',')}]`;
      });

      runs.push(
        `#${run} ${ready.body.status as string} глав_ok=${okChapters} missing=${JSON.stringify(ready.body.missing_sections)} warnings=${JSON.stringify(ready.body.warnings)} attempts=${row?.attempts ?? 0} ₽=${row?.llm_cost_rub ?? '0'} validation=${JSON.stringify(row?.validation ?? [])}\n    ${shape.join(' ')}\n    хвост: ${(sections.find((s) => s.key === 'summary')?.body_md ?? '').endsWith(MISSING_SECTIONS_NOTE) ? 'есть (частичный)' : 'нет'}`,
      );

      expect(ready.body.status).toBe('ready');
      expect(okChapters).toBeGreaterThanOrEqual(6);
      expect(ready.body.missing_sections).toEqual([]);
      // Жёстких провалов нет: `validation` пуст, `attempts` = план + 7 глав,
      // то есть ни одной перегенерации (MAX_ATTEMPTS остаётся 2, но не нужен).
      expect(row?.validation ?? []).toEqual([]);
      expect(row?.attempts).toBe(8);

      // Форма всех глав, включая «Итог»: 3–6 абзацев по 2–4 предложения.
      const summary = sections.find((section) => section.key === 'summary');
      expect(summary?.body_md).toContain(DISCLAIMER);
      for (const section of sections) {
        const paragraphs = splitParagraphs(section.body_md);
        expect(paragraphs.length).toBeGreaterThanOrEqual(3);
        expect(paragraphs.length).toBeLessThanOrEqual(6);
        for (const paragraph of paragraphs) {
          const count = splitSentences(paragraph).length;
          expect(count).toBeGreaterThanOrEqual(2);
          expect(count).toBeLessThanOrEqual(4);
        }
      }

      // Пометки — только про повторы: стаб отдаёт одинаковый текст всем
      // главам, и это единственное, что нормализация не правит (и не должна:
      // повтор — вопрос содержания, а не формы).
      const codes = new Set(
        (ready.body.warnings as { code: string }[]).map((warning) => warning.code),
      );
      for (const code of codes) {
        expect(code).toBe('repeats');
      }
    }

    // Таблица прогонов — в вывод теста: это и есть доказательство приёмки.
    process.stdout.write(
      `\nПЯТЬ ПРОГОНОВ (провайдер: одна простыня 16 предложений)\n${runs.join('\n')}\n\n`,
    );
  }, 120_000);
});
