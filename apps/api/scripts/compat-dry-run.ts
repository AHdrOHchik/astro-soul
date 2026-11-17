/**
 * Прогон совместимости на подставной модели (`pnpm --filter @astro-soul/api
 * run compat:dry-run`).
 *
 * Зачем скрипт, а не тест: он печатает то, что нужно видеть глазами перед
 * релизом, — объём каждого раздела, стоимость, версию промпта и таблицу
 * «факт × раздел». Тест проверяет то же самое, но падает молча и без чисел.
 *
 * Здесь нет ни одного настоящего платежа и ни одного вызова GigaChat: модель —
 * подставная, факты пары — настоящие (из движка, `test/fixtures/compat-facts.ts`),
 * карта — эталонная.
 *
 * Стоимость считается так же, как в проде: по `usage` провайдера и цене из
 * `config/llm-models.ts` (0,5 ₽ за 1000 **токенов**, вход и выход по одной
 * цене). Подставная модель не знает токенизатора GigaChat, поэтому токены
 * оцениваются как 2,8 знака на токен — это оценка, и она подписана как
 * оценка. Раньше здесь считались знаки по 0,5 ₽/1000 знаков: 18 264 знака
 * давали 9,13 ₽ вместо ~3,3 ₽, то есть завышение почти втрое.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { createTestContext, truncateAll } from '../test/test-app';
import { signInitData } from '../test/init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from '../test/test-env';
import { makeFakeAstro } from '../test/fake-astro';
import { makeFakeTelegram } from '../test/fake-telegram';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';
import { costRubOf, DEFAULT_LLM_MODEL, llmModelSpec } from '../src/config/llm-models';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { COMPAT_STUB_SECTIONS } from '../test/fixtures/compat-sections';
import { compatFactsPairPayload } from '../test/fixtures/compat-facts-pair';
import { factorsOf, parseCompatibilityFacts } from '../src/modules/compat/compat-facts';
import {
  compatMatrix,
  coverageOf,
  distributeSections,
  MAX_SECTIONS_PER_FACTOR,
} from '../src/modules/compat/compat-focus-map';

/**
 * Оценка токенов для подставной модели: у GigaChat кириллица — примерно
 * 2,5–3 знака на токен, берём середину. В проде токены приходят от провайдера
 * (`usage.prompt_tokens` / `usage.completion_tokens`) и не оцениваются.
 */
const CHARS_PER_TOKEN = 2.8;

const MODEL = llmModelSpec(DEFAULT_LLM_MODEL);
if (MODEL === null) {
  throw new Error(`в config/llm-models.ts нет модели ${DEFAULT_LLM_MODEL}`);
}
const PRICE_PER_1K_TOKENS = MODEL.pricePer1kRub;

let promptChars = 0;
let answerChars = 0;

function answerFor(prompt: string): string {
  if (prompt.includes('что у вас совпадает так')) return COMPAT_STUB_SECTIONS.clicks;
  if (prompt.includes('где именно вас заедает')) return COMPAT_STUB_SECTIONS.friction;
  if (prompt.includes('как вы разговариваете, когда не согласны')) return COMPAT_STUB_SECTIONS.scenario;
  return COMPAT_STUB_SECTIONS.steps;
}

const provider: LlmProvider = {
  name: 'stub-llm',
  complete(input: LlmRequest): Promise<LlmResponse> {
    const prompt = input.messages.map((message) => message.content).join('\n');
    const content = answerFor(prompt);
    promptChars += prompt.length;
    answerChars += content.length;

    // Токены — не знаки: подставная модель «списывает» токены, а цену
    // считает та же функция, что и в проде.
    const usage = {
      promptTokens: Math.ceil(prompt.length / CHARS_PER_TOKEN),
      completionTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
    };

    return Promise.resolve({
      content,
      model: 'stub-llm',
      usage: {
        ...usage,
        totalTokens: usage.promptTokens + usage.completionTokens,
        costRub: costRubOf(usage, PRICE_PER_1K_TOKENS),
      },
    });
  },
};

/**
 * Тело ответа с типом. Supertest отдаёт `any`, и без этого cast'а
 * `no-unsafe-member-access` справедливо ругается: в скрипте, который читает
 * люди, `any` — это «а что там точно лежит, никто не знает».
 */
function bodyOf<T>(response: { readonly body: unknown }): T {
  return response.body as T;
}

async function main(): Promise<void> {
  const ctx = await createTestContext({
    // Факты — настоящий ответ движка на ту самую пару, что в запросе: иначе
    // диагностика «какие семейства дошли до текста» проверяла бы заглушку.
    astro: makeFakeAstro({ facts: compatFactsPairPayload }),
    telegram: makeFakeTelegram(),
    llm: provider,
  });

  try {
    await truncateAll(ctx.db);

    const auth = { [INIT_DATA_HEADER]: signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER }) };
    // `getHttpServer()` возвращает `any` из Nest; приводим к тому, что
    // действительно принимает supertest.
    const server = ctx.app.getHttpServer() as Server;

    const chart = await request(server)
      .post('/api/v1/charts')
      .set(auth)
      .send({
        birth_date: '1994-05-17',
        birth_time: '14:20',
        time_precision: 'exact',
        birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
        consent: { accepted: true, version: '2026-11-10' },
      })
      .expect(201);

    const chartId = bodyOf<{ chart: { chart_id: string } }>(chart).chart.chart_id;
    const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
    await ctx.db.query(`INSERT INTO entitlements (user_id, kind, status) VALUES ($1, 'compat', 'active')`, [
      user?.id,
    ]);

    const accepted = await request(server)
      .post('/api/v1/compatibility')
      .set(auth)
      .set('Idempotency-Key', 'dry-run-1')
      .send({
        chart_id: chartId,
        relationship: 'romantic',
        partner: {
          birth_date: '1990-03-02',
          birth_time: '08:15',
          place: { city_id: 'ru-moscow', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
        },
      })
      .expect(202);

    const id = bodyOf<{ compatibility_id: string }>(accepted).compatibility_id;
    let view: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const response = await request(server)
        .get(`/api/v1/compatibility/${id}`)
        .set(auth);
      view = bodyOf<Record<string, unknown>>(response);
      if (view['status'] === 'ready' || view['status'] === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const row = await ctx.db.queryOne<{
      prompt_version: string;
      report_structure_version: string;
      chart_facts_version: string;
      llm_cost_rub: string;
      status: string;
      error_code: string | null;
    }>(
      `SELECT prompt_version, report_structure_version, chart_facts_version,
              llm_cost_rub::text, status::text, error_code
         FROM reports WHERE id = $1`,
      [id],
    );

    const sections = (view['sections'] ?? []) as { key: string; text: string }[];

    process.stdout.write('\n=== Совместимость: прогон на подставной модели ===\n');
    process.stdout.write(`status: ${String(view['status'])}${row?.error_code ? ` (${row.error_code})` : ''}\n`);
    process.stdout.write(`prompt_version: ${row?.prompt_version} | structure: ${row?.report_structure_version} | facts: ${row?.chart_facts_version}\n`);
    process.stdout.write('\nРазделы:\n');
    for (const section of sections) {
      process.stdout.write(`  ${section.key.padEnd(9)} ${String(section.text.length).padStart(4)} знаков\n`);
    }
    const total = sections.reduce((sum, section) => sum + section.text.length, 0);
    process.stdout.write(`  всего     ${String(total).padStart(4)} знаков\n`);

    // Деньги — по токенам, как в проде: `llm_cost_rub` собран из `usage`,
    // которое вернула (подставная) модель.
    const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
    const completionTokens = Math.ceil(answerChars / CHARS_PER_TOKEN);
    process.stdout.write(
      `\ncost_rub (0,5 ₽/1000 токенов, оценка ${String(CHARS_PER_TOKEN)} знака = 1 токен): ${row?.llm_cost_rub}\n`,
    );
    process.stdout.write(
      `токенов (оценка): вход ${String(promptTokens)}, выход ${String(completionTokens)}, ` +
        `всего ${String(promptTokens + completionTokens)}; знаков ${String(promptChars + answerChars)}\n`,
    );

    const facts = parseCompatibilityFacts(compatFactsPairPayload);
    const factors = factorsOf(facts);
    const distribution = distributeSections(factors);
    const coverage = coverageOf(factors, distribution);
    const matrix = compatMatrix(distribution);

    const families = new Map<string, string[]>();
    for (const factor of factors) {
      families.set(factor.family, [...(families.get(factor.family) ?? []), factor.id]);
    }

    process.stdout.write(`\n=== Список 1: все факты пары (${String(factors.length)}) ===\n`);
    for (const [family, ids] of families) {
      process.stdout.write(`  ${family.padEnd(9)} (${String(ids.length)}): ${ids.join(', ')}\n`);
    }

    process.stdout.write(`\n=== Список 2: факт → разделы ===\n`);
    for (const item of matrix) {
      process.stdout.write(
        `  ${item.factor.padEnd(38)} ${item.family.padEnd(9)} → ${item.sections.join(', ')} (${String(item.count)})\n`,
      );
    }

    process.stdout.write(`\n=== Список 3: факты, не дошедшие до текста (${String(distribution.skipped.length)}) ===\n`);
    for (const item of distribution.skipped) {
      process.stdout.write(`  ${item.id.padEnd(38)} ${item.family.padEnd(9)} — ${item.reason}\n`);
    }

    process.stdout.write(`\nМатрица «факт × раздел» (лимит ${String(MAX_SECTIONS_PER_FACTOR)}):\n`);
    process.stdout.write(`  ${''.padEnd(34)}clicks friction scenario steps\n`);
    for (const item of matrix) {
      const cells = ['clicks', 'friction', 'scenario', 'steps'].map((section) =>
        item.sections.includes(section as 'clicks') ? '  ✓   ' : '  ·   ',
      );
      process.stdout.write(`  ${item.factor.slice(0, 34).padEnd(34)}${cells.join('').trimEnd()}\n`);
    }
    process.stdout.write(
      `\nфактов: ${String(coverage.factors)}, дошло до текста: ${String(coverage.reached)}, ` +
        `семейства в тексте: ${coverage.familiesReached.join(', ')}` +
        `${coverage.familiesMissing.length > 0 ? `, за бортом: ${coverage.familiesMissing.join(', ')}` : ''}, ` +
        `в разделах: ${JSON.stringify(distribution.counts)}\n`,
    );
  } finally {
    await ctx.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
