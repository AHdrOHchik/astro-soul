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
 * карта — эталонная. Поэтому «стоимость» считается по цене владельца
 * 0,5 ₽/1000 знаков, а не по usage провайдера.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { createTestContext, truncateAll } from '../test/test-app';
import { signInitData } from '../test/init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from '../test/test-env';
import { makeFakeAstro } from '../test/fake-astro';
import { makeFakeTelegram } from '../test/fake-telegram';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { COMPAT_STUB_SECTIONS } from '../test/fixtures/compat-sections';
import { compatFactsPayload } from '../test/fixtures/compat-facts';
import { factorsOf } from '../src/modules/compat/compat-facts';
import { distributeSections, MAX_SECTIONS_PER_FACTOR } from '../src/modules/compat/compat-focus-map';

/** Цена владельца: 0,5 ₽ за 1000 знаков (GigaChat 3 Ultra). */
const RUB_PER_1000_CHARS = 0.5;

let totalChars = 0;

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
    totalChars += prompt.length + content.length;
    return Promise.resolve({
      content,
      model: 'stub-llm',
      usage: {
        promptTokens: prompt.length,
        completionTokens: content.length,
        totalTokens: prompt.length + content.length,
        costRub: Math.round(((prompt.length + content.length) / 1000) * RUB_PER_1000_CHARS * 10_000) / 10_000,
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
    astro: makeFakeAstro(),
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
    process.stdout.write(`\ncost_rub (по 0,5 ₽/1000 знаков): ${row?.llm_cost_rub}\n`);
    process.stdout.write(`знаков в промптах и ответах: ${totalChars}\n`);

    const factors = factorsOf(compatFactsPayload);
    const distribution = distributeSections(factors);
    const ids = [...new Set(Object.values(distribution.bySection).flat().map((factor) => factor.id))];

    process.stdout.write(`\nМатрица «факт × раздел» (лимит ${String(MAX_SECTIONS_PER_FACTOR)}):\n`);
    process.stdout.write(`  ${''.padEnd(34)}clicks friction scenario steps\n`);
    for (const id of ids) {
      const row = ['clicks', 'friction', 'scenario', 'steps'].map((section) =>
        distribution.bySection[section as 'clicks'].some((factor) => factor.id === id) ? '  ✓   ' : '  ·   ',
      );
      process.stdout.write(`  ${id.slice(0, 34).padEnd(34)}${row.join('').trimEnd()}\n`);
    }
    process.stdout.write(
      `\nфактов: ${String(factors.length)}, использовано: ${String(ids.length)}, ` +
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
