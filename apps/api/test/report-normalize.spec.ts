import { describe, expect, it } from 'vitest';
import {
  NORMALIZATION_CODES,
  TEASER_TERMS,
  normalizeSection,
  normalizeTeaser,
} from '../src/modules/reports/normalize';
import {
  DISCLAIMER,
  PARAGRAPH_MAX,
  PARAGRAPH_MIN,
  SECTIONS,
  SENTENCES_PER_PARAGRAPH_MAX,
  SENTENCES_PER_PARAGRAPH_MIN,
  splitParagraphs,
  splitSentences,
} from '../src/modules/reports/validators';
import { classifyFailures, severityOfRule, isRetryable } from '../src/modules/reports/failure-codes';

/**
 * Нормализация — первый рубеж задачи 2 (итерация 18): форма текста правится
 * кодом, а не второй генерацией за 0,85 ₽.
 *
 * Тесты проверяют два свойства, без которых нормализацию нельзя включать:
 *   1. форма приводится к 3–6 абзацам по 2–4 предложения;
 *   2. текст не теряется и не переставляется — только пустые строки и
 *      границы обрезки.
 */
const SENTENCE = [
  'Ты быстро собираешь связи между людьми и темами, не задерживаясь на одной линии.',
  'Скорость для тебя не трюк, а способ не застрять в чужой нерешительности.',
  'Когда тебя торопят, ответ становится резче, чем ты собирался сказать вслух.',
  'Раздражение уходит в сарказм, и это самый короткий путь выпустить пар.',
  'Выводы приходят раньше чувств, поэтому близкие иногда не успевают за тобой.',
  'Ясность ты ценишь выше тепла, но тепла всё равно хочется, и это не противоречие.',
  'В работе тебе важнее видеть движение, чем получить готовую оценку своих усилий.',
  'Пауза в разговоре тебя не пугает: ты умеешь ждать, если видишь смысл в ожидании.',
  'Новые люди тянутся к тебе за конкретикой, а не за участием, и это стоит помнить.',
  'Усталость ты замечаешь поздно, обычно уже на стадии, когда всё раздражает.',
  'Просьбу о помощи ты формулируешь как задачу, и это работает лучше жалобы.',
  'Тебе легче начать, чем закончить, поэтому финал стоит назначать заранее.',
];

function sentences(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => SENTENCE[(index + offset) % SENTENCE.length] ?? '');
}

/** Проверка формы: то же, что делает валидатор, но без порогов объёма. */
function form(body: string): { paragraphs: number[]; count: number } {
  const paragraphs = splitParagraphs(body).map(
    (paragraph) =>
      splitSentences(paragraph).filter((sentence) => sentence.trim() !== '').length,
  );
  return { paragraphs, count: paragraphs.length };
}

describe('normalizeSection — форма', () => {
  it('семь предложений в одном абзаце → 3 абзаца по 2–4 предложения', () => {
    const body = sentences(7).join(' ');
    const result = normalizeSection({ key: 'core', bodyMd: body });

    const shape = form(result.body);
    expect(shape.count).toBeGreaterThanOrEqual(PARAGRAPH_MIN);
    expect(shape.count).toBeLessThanOrEqual(PARAGRAPH_MAX);
    for (const count of shape.paragraphs) {
      expect(count).toBeGreaterThanOrEqual(SENTENCES_PER_PARAGRAPH_MIN);
      expect(count).toBeLessThanOrEqual(SENTENCES_PER_PARAGRAPH_MAX);
    }

    expect(result.applied).toContain('paragraphs_split');
    // Ни одно предложение не потерялось и порядок сохранён.
    const original = splitSentences(body);
    expect(splitSentences(result.body)).toEqual(original);
  });

  it('плотная простыня из двенадцати предложений режется на 3–6 абзацев', () => {
    const body = sentences(12).join(' ');
    const result = normalizeSection({ key: 'talents', bodyMd: body });
    const shape = form(result.body);

    expect(shape.count).toBeGreaterThanOrEqual(PARAGRAPH_MIN);
    expect(shape.count).toBeLessThanOrEqual(PARAGRAPH_MAX);
    expect(Math.max(...shape.paragraphs)).toBeLessThanOrEqual(SENTENCES_PER_PARAGRAPH_MAX);
  });

  it('восемь коротких абзацев склеиваются до шести', () => {
    const body = sentences(16)
      .map((sentence) => sentence)
      .reduce<string[]>((blocks, sentence, index) => {
        if (index % 2 === 0) {
          blocks.push(sentence);
        } else {
          blocks[blocks.length - 1] = `${blocks[blocks.length - 1] ?? ''} ${sentence}`;
        }
        return blocks;
      }, [])
      .join('\n\n');

    const result = normalizeSection({ key: 'money', bodyMd: body });
    const shape = form(result.body);

    expect(shape.count).toBeLessThanOrEqual(PARAGRAPH_MAX);
    expect(result.applied).toContain('paragraphs_merged');
  });

  it('одиночные предложения-абзацы склеиваются в 2–4 предложения', () => {
    const body = sentences(8)
      .map((sentence) => sentence)
      .join('\n\n');
    const result = normalizeSection({ key: 'purpose', bodyMd: body });
    const shape = form(result.body);

    for (const count of shape.paragraphs) {
      expect(count).toBeGreaterThanOrEqual(SENTENCES_PER_PARAGRAPH_MIN);
      expect(count).toBeLessThanOrEqual(SENTENCES_PER_PARAGRAPH_MAX);
    }
    expect(shape.count).toBeLessThanOrEqual(PARAGRAPH_MAX);
  });

  it('из четырёх предложений три абзаца не делаются: одиночки не плодятся', () => {
    const body = sentences(4)
      .map((sentence) => sentence)
      .join('\n\n');
    const result = normalizeSection({ key: 'purpose', bodyMd: body });
    const shape = form(result.body);

    // Материала мало — честнее оставить 2 абзаца по 2 предложения и уйти
    // в `too_short`, чем выдать 3 абзаца по одному.
    expect(shape.count).toBe(2);
    expect(shape.paragraphs).toEqual([2, 2]);
  });

  it('список маркером «—» не режется и не склеивается', () => {
    const list = ['— первое', '— второе', '— третье'].join('\n');
    const body = `${sentences(2).join(' ')}\n\n${list}\n\n${sentences(2, 2).join(' ')}`;
    const result = normalizeSection({ key: 'emotions', bodyMd: body });

    expect(result.body).toContain(list);
  });

  it('текст уже в форме не меняется и не помечается', () => {
    const body = [
      sentences(3, 0).join(' '),
      sentences(3, 3).join(' '),
      sentences(3, 6).join(' '),
    ].join('\n\n');
    const result = normalizeSection({ key: 'relations', bodyMd: body });

    expect(result.body).toBe(body);
    expect(result.applied).toEqual([]);
  });

  it('перебор объёма обрезается по границе абзаца/предложения', () => {
    const range = SECTIONS.find((section) => section.key === 'core');
    expect(range).toBeDefined();

    const body = Array.from({ length: 6 }, (_, index) => sentences(4, index).join(' ')).join('\n\n');
    expect(body.length).toBeGreaterThan(range?.max ?? 0);

    const result = normalizeSection({ key: 'core', bodyMd: body });
    expect(result.body.length).toBeLessThanOrEqual(range?.max ?? 0);
    expect(result.body.length).toBeGreaterThanOrEqual(range?.min ?? 0);
    expect(result.applied).toContain('trimmed');
    // Обрезка не рвёт слово: текст кончается знаком конца предложения.
    expect(/[.!?…]$/u.test(result.body.trim())).toBe(true);
  });

  it('пустой ответ не выдумывает текст: тело пустое и без кодов', () => {
    const result = normalizeSection({ key: 'core', bodyMd: '   \n\n  ' });
    expect(result.body).toBe('');
    expect(result.applied).toEqual([]);
  });

  it('в «Итог» дописывается дисклеймер, если модель его забыла', () => {
    const body = [sentences(3, 0).join(' '), sentences(3, 3).join(' '), sentences(3, 6).join(' ')].join(
      '\n\n',
    );
    const result = normalizeSection({ key: 'summary', bodyMd: body });

    expect(result.body).toContain(DISCLAIMER);
    expect(result.applied).toContain('disclaimer_added');
    // Дисклеймер встал последней фразой последнего абзаца — форма не поехала.
    const shape = form(result.body);
    expect(shape.count).toBe(3);
    for (const count of shape.paragraphs) {
      expect(count).toBeGreaterThanOrEqual(SENTENCES_PER_PARAGRAPH_MIN);
      expect(count).toBeLessThanOrEqual(SENTENCES_PER_PARAGRAPH_MAX);
    }
    expect(result.body.trim().endsWith(DISCLAIMER)).toBe(true);
  });

  it('коды нормализации — закрытый список, повторный прогон ничего не добавляет', () => {
    const body = sentences(7).join(' ');
    const first = normalizeSection({ key: 'core', bodyMd: body });
    const second = normalizeSection({ key: 'core', bodyMd: first.body });

    for (const code of first.applied) {
      expect(NORMALIZATION_CODES).toContain(code);
    }
    expect(second.body).toBe(first.body);
    expect(second.applied).toEqual([]);
  });
});

describe('normalizeTeaser — окно в 400 знаков', () => {
  it('термины в первых знаках → окно сдвигается на абзац без терминов', () => {
    const body = [
      'Солнце в Близнецах даёт тебе быстрый ум и привычку переключаться между темами.',
      sentences(3, 0).join(' '),
      sentences(3, 3).join(' '),
    ].join('\n\n');

    const teaser = normalizeTeaser(body, 400);
    expect(teaser.shifted).toBe(true);
    expect(teaser.hasTerms).toBe(false);
    expect(TEASER_TERMS.test(teaser.teaser)).toBe(false);
  });

  it('без терминов тизер — ровно первые 400 знаков', () => {
    const body = sentences(12).join(' ');
    const teaser = normalizeTeaser(body, 400);

    expect(teaser.teaser).toBe(body.slice(0, 400));
    expect(teaser.shifted).toBe(false);
    expect(teaser.hasTerms).toBe(false);
  });

  it('если термины везде — окно остаётся и ставится пометка', () => {
    const body = Array.from({ length: 4 }, () => 'Марс в Овне требует действия прямо сейчас, без паузы и объяснений.').join('\n\n');
    const teaser = normalizeTeaser(body, 400);

    expect(teaser.hasTerms).toBe(true);
    expect(teaser.teaser).toBe(body.slice(0, 400));
  });
});

describe('серьёзность провала валидатора', () => {
  it('error — только пустой ответ и нераспарсенная глава, всё остальное warning', () => {
    for (const rule of [
      'paragraphs',
      'paragraph_sentences',
      'repeats',
      'word_share',
      'voice',
      // Итерация 19: запрещённые темы больше не убирают главу — живой прогон
      // 18.11.2026 потерял `emotions` именно на этом правиле.
      'forbidden_health',
      'forbidden_fear',
      'chiron',
      'unknown_house',
      'format_h1',
      'service_terms',
      'repeated_opener',
      'teaser_terms',
      'summary_short',
      'disclaimer',
    ]) {
      expect(severityOfRule(rule), rule).toBe('warning');
    }
    for (const rule of ['too_short', 'section_unknown']) {
      expect(severityOfRule(rule), rule).toBe('error');
    }
  });

  it('недобор и перебор объёма — оба warning: главу показываем', () => {
    const short = classifyFailures({
      key: 'core',
      bodyLength: 600,
      failures: [{ rule: 'length', detail: '600 вне 1200–1550' }],
    });
    expect(short.warnings.map((entry) => entry.code)).toEqual(['too_short']);

    const long = classifyFailures({
      key: 'core',
      bodyLength: 2_600,
      failures: [{ rule: 'length', detail: '2600 вне 1200–1550' }],
    });
    expect(long.warnings.map((entry) => entry.code)).toEqual(['too_long']);
  });

  it('«Итог» с недобором — ретрай, а не выброс главы', () => {
    const short = classifyFailures({
      key: 'summary',
      bodyLength: 434,
      failures: [{ rule: 'summary_short', detail: '434 < 500' }],
    });
    expect(short.errors).toEqual([]);
    expect(short.warnings.map((entry) => entry.code)).toEqual(['too_short']);
    expect(isRetryable('too_short')).toBe(true);
  });

  it('перегенерация — только для too_short и format', () => {
    expect(isRetryable('too_short')).toBe(true);
    expect(isRetryable('format')).toBe(true);
    for (const code of [
      'forbidden_terms',
      'paragraphs',
      'repeats',
      'too_long',
      'teaser_terms',
      'service_terms',
      'repeated_opener',
    ] as const) {
      expect(isRetryable(code), code).toBe(false);
    }
  });
});
