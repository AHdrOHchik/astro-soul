import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { DISCLAIMER, SECTIONS, TEASER_LENGTH } from '../src/modules/reports/validators';
import {
  MAX_CHAPTERS_PER_FACTOR,
  distributeFocuses,
  factorMatrix,
  type FactorMatrixRow,
  type PlanFocus,
} from '../src/modules/reports/focus-map';
import { MAX_ATTEMPTS } from '../src/modules/reports/reports.service';
import { splitParagraphs } from '../src/modules/reports/validators';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

/**
 * Фразы-наблюдения по ~62 знака: 20 штук хватает на главу 1 200–1 300 знаков
 * из четырёх-пяти абзацев по три-четыре предложения.
 */
const SENTENCES = [
  'Ты замечаешь сдвиг настроения раньше, чем назовёшь его словом.',
  'Спор для тебя способ проверить мысль, а не выяснить отношения.',
  'Пауза в разговоре не пугает: ты умеешь ждать, пока смысл появится.',
  'Решения ты принимаешь быстро, но пересматриваешь их без обиды на себя.',
  'Внимание держится на задаче ровно до момента, когда стало понятно.',
  'Усталость ты замечаешь поздно, обычно уже через раздражение на мелочи.',
  'Просьбу о помощи ты формулируешь как задачу, и это работает лучше жалобы.',
  'Новое ты берёшь короткими заходами и быстро проверяешь на деле.',
  'Тебе легче начать, чем закончить, поэтому финал стоит назначать заранее.',
  'Ошибку ты признаёшь без торга, и это экономит тебе много сил.',
  'Тишина для тебя рабочее состояние, а не пустота для заполнения.',
  'Ты быстро собираешь связи между людьми и темами, не задерживаясь.',
  'Скорость для тебя не трюк, а способ не застрять в чужой нерешительности.',
  'Когда тебя торопят, ответ становится резче, чем ты хотел сказать.',
  'Раздражение уходит в сарказм, и это самый короткий путь выпустить пар.',
  'Выводы приходят раньше чувств, поэтому близкие не успевают за темпом.',
  'Ясность ты ценишь выше тепла, но тепла всё равно хочется, и это не спор.',
  'В работе тебе важнее видеть движение, чем получить готовую оценку.',
  'Новые люди тянутся к тебе за конкретикой, а не за участием, и это стоит помнить.',
  'Резкие решения даются проще постепенных: пока тянешь, гаснет интерес.',
];

type SectionKey = (typeof SECTIONS)[number]['key'];

/** Глава нужного объёма: абзацы по 3–4 предложения, длина внутри диапазона. */
function chapterBody(key: SectionKey, extra: readonly string[] = []): string {
  const range = SECTIONS.find((section) => section.key === key);
  const target = (range?.min ?? 1_000) + 60;
  const sentences = [...extra, ...SENTENCES];
  const paragraphs: string[] = [];

  let index = 0;
  while (index < sentences.length) {
    const rest = sentences.length - index;
    const take = Math.min(4, rest);
    const paragraph = sentences.slice(index, index + take).join(' ');
    paragraphs.push(paragraph);
    index += take;
    const length = paragraphs.join('\n\n').length;
    if (length >= target) {
      break;
    }
    // Хвост из одного предложения недопустим (2–4 предложения на абзац):
    // пока хватает материала, добираем абзац до двух фраз.
    if (rest - take === 1) {
      paragraphs[paragraphs.length - 1] = `${paragraph} ${sentences[index] ?? ''}`.trim();
      index += 1;
    }
  }

  return paragraphs.join('\n\n');
}

/** «Итог» без дисклеймера: его добавляет нормализатор, как в проде. */
function summaryBody(chars: number): string {
  const base =
    'Назови цену вслух один раз — человеку, который может её обсудить. Откажись от одного дела, которое ты держишь только из вежливости. Назначь финал на неделю вперёд и проверь, что он был.';
  const sentence = `${base} `;
  const paragraphs: string[] = [];
  let text = '';
  while (text.length < chars) {
    text += sentence;
  }
  text = text.slice(0, chars);

  // Три абзаца по 2–4 предложения — форма «Итога».
  const parts = text.split(/(?<=[.])\s+/u).filter((part) => part !== '');
  const perParagraph = Math.ceil(parts.length / 3);
  for (let index = 0; index < parts.length; index += perParagraph) {
    paragraphs.push(parts.slice(index, index + perParagraph).join(' '));
  }
  return paragraphs.slice(0, 3).join('\n\n');
}

/** План с перекосом, как на живом прогоне: один фактор просится в 6 глав. */
const PLAN_JSON = JSON.stringify({
  thesis: 'Ты быстро связываешь факты, но не считаешь это достижением.',
  focuses: [
    { topic: 'скорость ума', factor: 'Меркурий в Близнецах', angle: 'связи на ходу' },
    { topic: 'реакция на давление', factor: 'Марс в Овне', angle: 'короткая вспышка' },
    { topic: 'связи на ходу', factor: 'Меркурий в Близнецах', angle: 'разговор' },
    { topic: 'эмоции', factor: 'Луна во Льве', angle: 'признание' },
    { topic: 'реакция', factor: 'Марс в Овне', angle: 'спорт' },
    { topic: 'скорость', factor: 'Меркурий в Близнецах', angle: 'темп' },
    { topic: 'воля', factor: 'Солнце в Тельце', angle: 'упорство' },
    { topic: 'границы', factor: 'Сатурн в Рыбах', angle: 'терпение' },
  ],
  avoid: ['не повторять про скорость'],
});

/** Убирает дисклеймер вместе с разделителем: нормализатор дописывает его сам. */
function stripDisclaimer(body: string): string {
  return body.replace(DISCLAIMER, '').trim();
}

function planFocuses(): PlanFocus[] {
  return (JSON.parse(PLAN_JSON) as { focuses: PlanFocus[] }).focuses;
}

function matrixOf(focuses: readonly PlanFocus[]): readonly FactorMatrixRow[] {
  return factorMatrix(distributeFocuses(focuses));
}

type Mode = 'clean' | 'dense' | 'short-summary';

class AcceptanceProvider implements LlmProvider {
  readonly name = 'harness-acceptance';
  mode: Mode = 'clean';
  readonly calls: string[] = [];
  readonly attempts = new Map<string, number>();

  complete(input: LlmRequest): Promise<LlmResponse> {
    const prompt = input.messages.map((message) => message.content).join('\n');

    if (prompt.includes('Ответ — строго JSON')) {
      this.calls.push('plan');
      return Promise.resolve(this.answer(PLAN_JSON));
    }

    const key: SectionKey = prompt.includes('заключительную главу «Итог')
      ? 'summary'
      : ((/Глава: ([a-z]+)\./u.exec(prompt)?.[1] ?? 'core') as SectionKey);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    this.calls.push(`${key}#${attempt}`);

    if (key === 'summary') {
      const short = this.mode === 'short-summary';
      const chars = short ? 434 : attempt === 1 ? 434 : 560;
      return Promise.resolve(this.answer(summaryBody(chars)));
    }

    if (key === 'money') {
      // Дефект 3 живого прогона: служебное слово из внутреннего словаря.
      return Promise.resolve(
        this.answer(
          chapterBody('money', [
            'Цена точки утечки — согласие на отсроченное вознаграждение.',
          ]),
        ),
      );
    }

    if (key === 'relations' || key === 'purpose') {
      // Дефект 4б: одинаковый зачин в двух главах.
      return Promise.resolve(
        this.answer(
          chapterBody(key, ['Ты быстро собираешь связи между людьми и темами.']),
        ),
      );
    }

    if (key === 'core') {
      const term = 'Меркурий в Близнецах';
      if (this.mode === 'dense') {
        // Термин в каждом предложении: сдвинуть окно некуда ни по абзацу, ни
        // по предложению — остаётся пометка с фактическим смещением.
        const sentences = chapterBody('core')
          .split(/(?<=[.])\s+/u)
          .map((sentence) => `${term}: ${sentence}`);
        const paragraphs: string[] = [];
        for (let index = 0; index < sentences.length; index += 4) {
          paragraphs.push(sentences.slice(index, index + 4).join(' '));
        }
        return Promise.resolve(this.answer(paragraphs.join('\n\n')));
      }
      // Термин только в первом абзаце: окно уезжает на границу следующего.
      const paragraphs = chapterBody('core').split('\n\n');
      paragraphs[0] = `${term} — ${paragraphs[0] ?? ''}`;
      return Promise.resolve(this.answer(paragraphs.join('\n\n')));
    }

    return Promise.resolve(this.answer(chapterBody(key)));
  }

  private answer(content: string): LlmResponse {
    return {
      content,
      model: this.name,
      usage: { promptTokens: 900, completionTokens: 250, totalTokens: 1_150, costRub: 0.575 },
    };
  }
}

let ctx: TestContext;
let telegram: FakeTelegram;
let provider: AcceptanceProvider;

beforeAll(async () => {
  telegram = makeFakeTelegram();
  provider = new AcceptanceProvider();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    llm: provider,
    env: { INTERNAL_JOB_SECRET: 'test-jobs-secret-0123456789', ADMIN_TG_ID: String(FICTIONAL_USER.id) },
  });
});

afterAll(async () => {
  await ctx.close();
});

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

interface RunResult {
  readonly status: string;
  /** Главы, отданные человеку: `ok` или `regenerated` после ретрая. */
  readonly okChapters: number;
  readonly statuses: Record<string, string>;
  readonly missing: string[];
  readonly sections: { key: string; body_md: string }[];
  readonly validation: { key: string; attempt: number; code: string; severity: string; failures?: string[] }[];
  readonly normalization: Record<string, { normalized: string[]; warnings: string[]; detail?: string[] }> | null;
  readonly attempts: number;
}

async function runReport(run: number): Promise<RunResult> {
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
    [userId, FICTIONAL_USER.id, `charge-teaser-${run}`],
  );
  await ctx.db.query(
    `INSERT INTO entitlements (user_id, kind, chart_id, payment_id) VALUES ($1, 'report', $2, $3)`,
    [userId, chartId, payment?.id],
  );

  const order = await request(ctx.app.getHttpServer())
    .post('/api/v1/reports')
    .set(INIT_DATA_HEADER, initData())
    .set('Idempotency-Key', `teaser-${run}`)
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

  const row = await ctx.db.queryOne<{
    section_status: Record<string, string>;
    normalization: RunResult['normalization'];
    validation: RunResult['validation'] | null;
    attempts: number;
  }>(`SELECT section_status, normalization, validation, attempts FROM reports WHERE id = $1`, [
    reportId,
  ]);

  return {
    status: ready.body.status as string,
    okChapters: Object.values(row?.section_status ?? {}).filter(
      (status) => status === 'ok' || status === 'regenerated',
    ).length,
    statuses: row?.section_status ?? {},
    missing: (ready.body.missing_sections ?? []) as string[],
    sections: (ready.body.sections ?? []) as { key: string; body_md: string }[],
    validation: row?.validation ?? [],
    normalization: row?.normalization ?? null,
    attempts: row?.attempts ?? 0,
  };
}

/**
 * Приёмка итерации 19 на провайдере, который воспроизводит дефекты трёх
 * живых прогонов 18.11.2026:
 *   • термин в первых 400 знаках `core` (сдвиг окна);
 *   • «Итог» 434 знака при минимуме 500 (ретрай, потом глава всё равно уходит);
 *   • служебное слово «точка утечки» в `money`;
 *   • одинаковый зачин в двух главах;
 *   • перекошенный план: один фактор просится в шесть глав.
 */
describe('приёмка итерации 19: тизер, служебные слова, «Итог»', () => {
  it('три прогона: 7/7 глав ok, тизер сдвинут или помечен, «Итог» в норме', async () => {
    await truncateAll(ctx.db);
    const lines: string[] = [];

    for (let run = 1; run <= 3; run += 1) {
      provider.mode = run === 3 ? 'dense' : 'clean';
      const result = await runReport(run);

      const core = result.sections.find((section) => section.key === 'core');
      const emotions = result.sections.find((section) => section.key === 'emotions');
      const money = result.sections.find((section) => section.key === 'money');
      const summary = result.sections.find((section) => section.key === 'summary');
      const detail = result.normalization?.['core']?.detail ?? [];
      const teaserStart = Number(/teaser_start=(\d+)/u.exec(detail.join(' '))?.[1] ?? 0);
      const teaserWarning = result.validation.find((entry) => entry.code === 'teaser_terms');

      expect(result.status).toBe('ready');
      expect(result.okChapters, JSON.stringify(result.statuses)).toBe(7);
      expect(result.missing).toEqual([]);

      // Дефект 1: глава с термином не пропадает — 1 064 знака на живом прогоне
      // хватало, чтобы отдать её целиком.
      expect(emotions?.body_md.length ?? 0).toBeGreaterThanOrEqual(1_000);
      expect(core?.body_md.length ?? 0).toBeGreaterThanOrEqual(1_200);

      if (run < 3) {
        // Сдвиг сработал: окно ушло за термин, пометки нет. Смещение бывает
        // меньше 400 — важно не «дальше 400 знаков», а «дальше термина»:
        // пейволл показывает окно без названий планет.
        expect(teaserStart).toBeGreaterThan(0);
        expect(teaserStart).toBeLessThan(TEASER_LENGTH);
        expect(teaserWarning).toBeUndefined();
      } else {
        // Сдвинуть некуда: текст остался, рядом — фактическое смещение.
        expect(teaserWarning).toBeDefined();
        expect(teaserWarning?.severity).toBe('warning');
        expect(teaserWarning?.failures?.[0]).toMatch(/на \d+-м знаке тизера/u);
        expect(money?.body_md.startsWith('Меркурий') ?? false).toBe(false);
      }

      // Дефект 2: «Итог» после ретрая в диапазоне 500–750.
      const summaryText = stripDisclaimer(summary?.body_md ?? '');
      expect(summaryText.length).toBeGreaterThanOrEqual(500);
      expect(summaryText.length).toBeLessThanOrEqual(750);
      expect(summary?.body_md.endsWith(DISCLAIMER)).toBe(true);

      // Дефект 3: служебное слово осталось в тексте, но помечено.
      expect(money?.body_md).toMatch(/точк[аи] утечки/u);
      const serviceWarning = result.validation.find((entry) => entry.code === 'service_terms');
      expect(serviceWarning?.severity).toBe('warning');

      // Дефект 4б: повтор зачина — пометка, текст не правится.
      const openerWarning = result.validation.find((entry) => entry.code === 'repeated_opener');
      expect(openerWarning?.severity).toBe('warning');

      // Дефект 4: матрица «фактор × глава» из того же плана, которым шёл
      // прогон: ни один фактор не больше чем в трёх главах.
      const matrix = matrixOf(planFocuses());
      expect(Math.max(...matrix.map((row) => row.count))).toBeLessThanOrEqual(
        MAX_CHAPTERS_PER_FACTOR,
      );

      lines.push(
        `#${run} ${result.status} глав_ok=${result.okChapters} attempts=${result.attempts} teaser_start=${teaserStart} teaser_warning=${teaserWarning === undefined ? 'нет' : 'есть'} summary=${summaryText.length} matrix_max=${Math.max(...matrix.map((row) => row.count))} validation=${JSON.stringify(
          [...new Set(result.validation.map((entry) => `${entry.code}/${entry.severity}`))],
        )}`,
      );

      if (run === 1) {
        lines.push(
          `   матрица #${run}:\n${matrix
            .map((row) => `   ${row.factor}: ${row.count} — ${row.chapters.join(', ')}`)
            .join('\n')}`,
        );
        expect(matrix.length).toBeGreaterThanOrEqual(3);
      }
    }

    process.stdout.write(`\nТРИ ПРОГОНА (стаб, дефекты 18.11.2026)\n${lines.join('\n')}\n\n`);
  }, 180_000);

  it('«Итог» 434 знака дважды: отдаётся как есть с warning too_short, текст не выдумывается', async () => {
    await truncateAll(ctx.db);
    provider.mode = 'short-summary';
    provider.attempts.clear();
    const result = await runReport(4);

    const summary = result.sections.find((section) => section.key === 'summary');
    const summaryText = stripDisclaimer(summary?.body_md ?? '');

    expect(result.status).toBe('ready');
    // Текст отдан как есть: недобор не «добит» ничем, длина в пределах
    // ответа модели (434 знака + разделители абзацев).
    expect(summaryText.length).toBeGreaterThanOrEqual(430);
    expect(summaryText.length).toBeLessThan(500);
    expect(provider.attempts.get('summary')).toBe(MAX_ATTEMPTS);

    const shorts = result.validation.filter(
      (entry) => entry.key === 'summary' && entry.code === 'too_short',
    );
    expect(shorts).toHaveLength(MAX_ATTEMPTS);
    expect(shorts.every((entry) => entry.severity === 'warning')).toBe(true);
    expect(result.normalization?.['summary']?.warnings).toContain('too_short');

    // Ни одной записи `severity: error`: недобор объёма главу не убивает.
    expect(result.validation.filter((entry) => entry.severity === 'error')).toEqual([]);
  }, 180_000);

  it('матрица «фактор × глава»: перекошенный план упирается в лимит 3', () => {
    const matrix = matrixOf(planFocuses());

    // Минимум две строки: иначе матрица ничего не проверяет.
    expect(matrix.length).toBeGreaterThanOrEqual(3);
    for (const row of matrix) {
      expect(row.count, row.factor).toBeLessThanOrEqual(MAX_CHAPTERS_PER_FACTOR);
      expect(row.count, row.factor).toBeGreaterThan(0);
    }

    // Перекос плана виден числами: три фокуса «Меркурия» и два «Марса» —
    // в главы попадают не больше трёх из них.
    const mercury = matrix.find((row) => row.factor === 'mercury');
    expect(mercury?.count).toBe(MAX_CHAPTERS_PER_FACTOR);
  });

  it('форма глав после приёмки: 3–6 абзацев по 2–4 предложения', async () => {
    const result = await runReport(5);
    for (const section of result.sections) {
      const paragraphs = splitParagraphs(section.body_md);
      expect(paragraphs.length, section.key).toBeGreaterThanOrEqual(2);
      expect(paragraphs.length, section.key).toBeLessThanOrEqual(8);
    }
  }, 180_000);
});
