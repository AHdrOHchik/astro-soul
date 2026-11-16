import {
  DISCLAIMER,
  PARAGRAPH_MAX,
  PARAGRAPH_MIN,
  SECTIONS,
  SENTENCES_PER_PARAGRAPH_MAX,
  SENTENCES_PER_PARAGRAPH_MIN,
  TEASER_LENGTH,
  TEASER_TERMS,
  splitParagraphs,
  splitSentences,
  type SectionKey,
} from './validators';

/**
 * Нормализация текста главы: привести ответ модели к форме **до** валидатора.
 *
 * Почему так, а не «ещё одна перегенерация»: живой прогон на GigaChat Ultra
 * стабильно даёт то семь предложений в абзаце, то один плотный абзац. Вторая
 * попытка при том же промпте даёт то же самое, только стоит ещё 0,85 ₽.
 * Границы абзацев — это строковая операция, которую модель выполняет плохо,
 * а код — точно. Смысл при этом не меняется ни на знак: предложения те же,
 * меняются только пустые строки между ними.
 *
 * `normalizeSection` детерминированная и не ходит в сеть. Валидатор остаётся
 * на месте и продолжает считать нарушения — но теперь его провал по форме
 * значит «покажем как есть с пометкой», а не «разбору конец».
 */

/**
 * Что именно поправили. Список закрытый: он уходит в `reports.normalization`
 * и в лог, поэтому коды должны быть стабильными, а не «примерно такими».
 */
export const NORMALIZATION_CODES = [
  'paragraphs_split',
  'paragraphs_merged',
  'trimmed',
  'repeats',
  'teaser_terms',
  'disclaimer_added',
] as const;

export type NormalizationCode = (typeof NORMALIZATION_CODES)[number];

export interface SectionNormalization {
  readonly body: string;
  readonly applied: readonly NormalizationCode[];
  /** Человекочитаемые подробности для лога: сколько было и сколько стало. */
  readonly notes: readonly string[];
}

/**
 * Список терминов живёт в `validators.ts` (там же, где проверка): тизер и
 * валидатор обязаны смотреть на один и тот же набор слов. Реэкспорт — чтобы
 * импорт из `normalize` не сломался у тех, кто уже так делает.
 */
export { TEASER_TERMS };

const PARAGRAPH_SEPARATOR = '\n\n';
const S_MIN = SENTENCES_PER_PARAGRAPH_MIN;
const S_MAX = SENTENCES_PER_PARAGRAPH_MAX;

/**
 * Список маркером «—» — это одна мысль, а не абзац: такие блоки нормализатор
 * не режет и не склеивает, иначе перечисление превратится в кашу.
 */
function isListParagraph(paragraph: string): boolean {
  const lines = paragraph.split('\n').filter((line) => line.trim() !== '');
  const listLines = lines.filter((line) => line.trim().startsWith('—'));
  return lines.length > 0 && listLines.length * 2 >= lines.length;
}

/**
 * Абзац в работе. `locked` — блок, который нельзя склеивать: список или
 * одиночное предложение, которому не нашлось пары по форме. Флаг нужен,
 * потому что «просто пропустить» в массиве строк нечем: индексы съезжают.
 */
interface Block {
  readonly text: string;
  readonly locked: boolean;
}

function join(blocks: readonly Block[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text !== '')
    .join(PARAGRAPH_SEPARATOR);
}

function sentencesOf(block: Block): number {
  return splitSentences(block.text).length;
}

/** Делит абзац на группы по 2–4 предложения, не переставляя и не теряя их. */
function splitParagraph(paragraph: string, max: number): string[] {
  const sentences = splitSentences(paragraph);
  if (sentences.length <= max) {
    return [paragraph];
  }
  const chunks = Math.ceil(sentences.length / max);
  const size = Math.ceil(sentences.length / chunks);
  const parts: string[] = [];
  for (let index = 0; index < sentences.length; index += size) {
    parts.push(sentences.slice(index, index + size).join(' '));
  }
  return parts;
}

function toBlocks(paragraphs: readonly string[]): Block[] {
  return paragraphs.map((paragraph) => ({ text: paragraph, locked: isListParagraph(paragraph) }));
}

/** Режет абзацы, где предложений больше четырёх: «7 предл. вне 2–4». */
function splitLongBlocks(blocks: readonly Block[], applied: Set<NormalizationCode>): Block[] {
  const result: Block[] = [];
  for (const block of blocks) {
    if (block.locked || sentencesOf(block) <= S_MAX) {
      result.push(block);
      continue;
    }
    const parts = splitParagraph(block.text, S_MAX);
    result.push(...parts.map((text) => ({ text, locked: false })));
    applied.add('paragraphs_split');
  }
  return result;
}

/** Абзац из одного предложения склеивается с соседом: 2–4 — норма формы. */
function mergeShortBlocks(blocks: readonly Block[], applied: Set<NormalizationCode>): Block[] {
  const result = [...blocks];
  let guard = 0;

  while (guard < 24) {
    guard += 1;
    const index = result.findIndex((block) => !block.locked && sentencesOf(block) < S_MIN);
    if (index === -1) {
      break;
    }

    const short = result[index];
    if (short === undefined) {
      break;
    }
    const next = result[index + 1];
    const previous = result[index - 1];

    const fits = (neighbour: Block | undefined): neighbour is Block =>
      neighbour !== undefined &&
      !neighbour.locked &&
      sentencesOf(neighbour) + sentencesOf(short) <= S_MAX;

    if (fits(next)) {
      result.splice(index, 2, { text: `${short.text} ${next.text}`.trim(), locked: false });
      applied.add('paragraphs_merged');
      continue;
    }
    if (fits(previous)) {
      result.splice(index - 1, 2, { text: `${previous.text} ${short.text}`.trim(), locked: false });
      applied.add('paragraphs_merged');
      continue;
    }

    // Склеивать не с кем: одиночное предложение остаётся отдельным абзацем —
    // лучше нарушить форму, чем склеить в абзац на семь предложений.
    result.splice(index, 1, { text: short.text, locked: true });
  }

  return result;
}

/** Больше шести абзацев — склеиваем соседние, начиная с самых коротких. */
function reduceBlocks(blocks: readonly Block[], applied: Set<NormalizationCode>): Block[] {
  const result = [...blocks];
  let guard = 0;

  while (result.length > PARAGRAPH_MAX && guard < 24) {
    guard += 1;

    const mergeable: { index: number; chars: number }[] = [];
    for (let index = 0; index < result.length - 1; index += 1) {
      const left = result[index];
      const right = result[index + 1];
      if (left === undefined || right === undefined || left.locked || right.locked) {
        continue;
      }
      if (sentencesOf(left) + sentencesOf(right) <= S_MAX) {
        mergeable.push({ index, chars: left.text.length + right.text.length });
      }
    }

    const target = mergeable.sort((a, b) => a.chars - b.chars || a.index - b.index)[0];
    if (target !== undefined) {
      const left = result[target.index];
      const right = result[target.index + 1];
      if (left !== undefined && right !== undefined) {
        result.splice(target.index, 2, { text: `${left.text} ${right.text}`.trim(), locked: false });
        applied.add('paragraphs_merged');
        continue;
      }
    }

    // Пары «2–4 предложения» не нашлось: склеиваем две самые короткие части
    // и сразу режем по предложениям — форма важнее исходного деления.
    const shortest = result
      .map((block, index) => ({ index, chars: block.text.length, locked: block.locked }))
      .filter((item) => !item.locked)
      .sort((a, b) => a.chars - b.chars || a.index - b.index)[0];
    if (shortest === undefined) {
      break;
    }
    const index = Math.min(shortest.index, result.length - 2);
    const left = result[index];
    const right = result[index + 1];
    if (left === undefined || right === undefined) {
      break;
    }
    result.splice(
      index,
      2,
      ...splitParagraph(`${left.text} ${right.text}`.trim(), S_MAX).map((text) => ({ text, locked: false })),
    );
    applied.add('paragraphs_merged');
  }

  return result;
}

/** Меньше трёх абзацев — режем самый длинный по границам предложений. */
function splitToMinimum(blocks: readonly Block[], applied: Set<NormalizationCode>): Block[] {
  const result = [...blocks];
  let guard = 0;

  while (result.length < PARAGRAPH_MIN && guard < 12) {
    guard += 1;

    let target = -1;
    let best = 0;
    result.forEach((block, index) => {
      const sentences = sentencesOf(block);
      if (!block.locked && sentences > best) {
        best = sentences;
        target = index;
      }
    });

    const block = result[target];
    // Делить нечего: чтобы получить лишний абзац, нужно минимум два
    // предложения **в каждой** половине. Иначе мы вылечим число абзацев
    // ценой одиночных предложений — а это то же нарушение, только с другой
    // стороны. Короткий текст честнее пометить, чем перекроить в кашу.
    if (target === -1 || block === undefined || best < S_MIN * 2) {
      break;
    }

    const sentences = splitSentences(block.text);
    const half = Math.ceil(sentences.length / 2);
    result.splice(
      target,
      1,
      { text: sentences.slice(0, half).join(' '), locked: false },
      { text: sentences.slice(half).join(' '), locked: false },
    );
    applied.add('paragraphs_split');
  }

  return result;
}

/**
 * Слишком длинный текст: обрезка по границе абзаца, а если абзац один —
 * по границе предложения. Обрезаем только перебор: недобор лечится
 * перегенерацией, а не выдумыванием текста.
 *
 * Важно не «срезать до максимума любой ценой»: после обрезки глав должно
 * остаться 3–6 абзацев. Обрезка, которая склеивает всё в одну простыню
 * (а именно так вёл себя первый вариант), чинит объём и ломает форму.
 */
function trimToRange(
  body: string,
  key: SectionKey,
  applied: Set<NormalizationCode>,
  notes: string[],
): string {
  const range = SECTIONS.find((section) => section.key === key);
  if (range === undefined || body.length <= range.max) {
    return body;
  }

  const paragraphs = splitParagraphs(body);
  const kept: Block[] = [];
  let length = 0;

  for (const paragraph of paragraphs) {
    const candidate =
      length === 0 ? paragraph.length : length + PARAGRAPH_SEPARATOR.length + paragraph.length;
    if (candidate > range.max) {
      break;
    }
    kept.push({ text: paragraph, locked: false });
    length = candidate;
  }

  // Целые абзацы не дотянули до минимума — добираем по предложению из
  // следующего, но не оставляем хвост из одного предложения.
  if (length < range.min) {
    const next = paragraphs[kept.length];
    if (next !== undefined && !isListParagraph(next)) {
      const sentences = splitSentences(next);
      const tail: string[] = [];
      let size = length;
      for (const sentence of sentences) {
        const candidate = size === 0 ? sentence.length : size + 1 + sentence.length;
        if (candidate > range.max) {
          break;
        }
        tail.push(sentence);
        size = candidate;
      }
      if (tail.length >= S_MIN) {
        kept.push({ text: tail.join(' '), locked: false });
        length = size;
      }
    }
  }

  // Ни один целый абзац не влез — тогда режем по предложению в один блок.
  let trimmed = join(kept);
  if (kept.length === 0) {
    const sentences = splitSentences(body);
    const parts: string[] = [];
    let size = 0;
    for (const sentence of sentences) {
      const candidate = size === 0 ? sentence.length : size + 1 + sentence.length;
      if (candidate > range.max) {
        break;
      }
      parts.push(sentence);
      size = candidate;
    }
    trimmed = parts.join(' ');
  }

  applied.add('trimmed');
  notes.push(`trimmed: ${body.length} → ${trimmed.length}`);
  return trimmed.length >= range.min ? trimmed : body;
}

/**
 * Главная точка: текст модели → текст в форме (или максимально близкий к ней).
 *
 * Порядок шагов фиксирован: сначала режем длинные абзацы, потом склеиваем
 * короткие, потом правим количество абзацев, и только в конце — объём.
 * Обратный порядок дал бы разное для одинакового входа.
 */
export function normalizeSection(input: {
  readonly key: SectionKey;
  readonly bodyMd: string;
}): SectionNormalization {
  const applied = new Set<NormalizationCode>();
  const notes: string[] = [];

  const source = input.bodyMd
    .replace(/\r\n/gu, '\n')
    .replace(/```[a-z]*\n?/gu, '')
    .replace(/\n{3,}/gu, PARAGRAPH_SEPARATOR)
    .trim();

  if (source === '') {
    return { body: '', applied: [], notes: ['empty'] };
  }

  const sourceBlocks = splitParagraphs(source);
  const before = sourceBlocks.length;
  let blocks = toBlocks(sourceBlocks);

  blocks = splitLongBlocks(blocks, applied);
  blocks = mergeShortBlocks(blocks, applied);
  blocks = reduceBlocks(blocks, applied);
  blocks = splitToMinimum(blocks, applied);
  // После склейки и деления длинные абзацы могли появиться снова — режем ещё раз.
  blocks = splitLongBlocks(blocks, applied);

  const after = blocks.length;
  if (after !== before) {
    notes.push(`paragraphs: ${before} → ${after}`);
  }

  const trimmed = trimToRange(join(blocks), input.key, applied, notes);

  // Дисклеймер — требование контракта, а не текст модели: `GET` не отдаёт
  // «Итог» без этой фразы. Дописываем дословно, если модель её забыла:
  // перегенерация ради одной известной строки — это ещё 0,85 ₽ за то, что
  // мы и так знаем.
  if (input.key === 'summary' && !trimmed.includes(DISCLAIMER)) {
    applied.add('disclaimer_added');
    notes.push('disclaimer_added');

    // Дописываем последней фразой последнего абзаца, если там есть место по
    // форме (2–4 предложения). Иначе — отдельным абзацем: дисклеймер обязан
    // быть, но он не повод выйти за рамки структуры.
    const blocks = splitParagraphs(trimmed);
    const last = blocks[blocks.length - 1];
    if (last !== undefined && !isListParagraph(last) && splitSentences(last).length < S_MAX) {
      blocks[blocks.length - 1] = `${last} ${DISCLAIMER}`;
    } else {
      blocks.push(DISCLAIMER);
    }

    return {
      body: blocks.join(PARAGRAPH_SEPARATOR),
      applied: [...applied],
      notes,
    };
  }

  return { body: trimmed, applied: [...applied], notes };
}

/**
 * Тизер — окно в 400 знаков внутри `core`. Термины (планеты, знаки, дома)
 * в нём запрещены; сама проверка живёт в валидаторе (`validators.ts`,
 * правило `teaser_terms`), а здесь только выбор окна.
 */
export interface TeaserNormalization {
  readonly teaser: string;
  /** Смещение начала окна внутри `core`. `0` — окно с самого начала. */
  readonly start: number;
  /** Абсолютное смещение первого термина в окне, `null` — терминов нет. */
  readonly firstTerm: number | null;
  /** Пришлось ли сдвинуть окно: термины были в первых 400 знаках. */
  readonly shifted: boolean;
  /** Термины остались даже после сдвига — тогда это `warning`, а не провал. */
  readonly hasTerms: boolean;
}

function firstTermAt(text: string): number | null {
  const matched = TEASER_TERMS.exec(text);
  // `lastIndex` у регулярки без `g` не сохраняется — `exec` сбрасывает его сам.
  return matched === null ? null : matched.index;
}

/**
 * Тизер — окно в 400 знаков `core` без названий планет, знаков и домов.
 *
 * Почему это отдельная функция, а не проверка главы: правило существует
 * **только** для тизера (`llm-prompts.md` §3.1). Живой прогон 18.11.2026
 * показал, что в `validation` не оставалось следа ни от сдвига, ни от
 * термина: тизер считался после валидатора и писал только в `normalization`,
 * а смещение первого термина вообще не измерялось. Теперь смещение
 * считается и уходит в `validation` (warning `teaser_terms`) и в лог.
 *
 * Окно пробуется не только по границам абзацев, но и по границам
 * предложений: в `core` абзац почти всегда начинается с фактора, и
 * абзацных границ не хватало, чтобы уйти от термина.
 */
export function normalizeTeaser(bodyMd: string, length = TEASER_LENGTH): TeaserNormalization {
  const natural = bodyMd.slice(0, length);
  const naturalTerm = firstTermAt(natural);
  if (naturalTerm === null) {
    return { teaser: natural, start: 0, firstTerm: null, shifted: false, hasTerms: false };
  }

  const starts = new Set<number>([0]);
  let offset = 0;
  for (const paragraph of splitParagraphs(bodyMd)) {
    const paragraphStart = bodyMd.indexOf(paragraph, offset);
    if (paragraphStart === -1) {
      continue;
    }
    starts.add(paragraphStart);
    let sentenceOffset = paragraphStart;
    for (const sentence of splitSentences(paragraph)) {
      const sentenceStart = bodyMd.indexOf(sentence, sentenceOffset);
      if (sentenceStart === -1) {
        continue;
      }
      starts.add(sentenceStart);
      sentenceOffset = sentenceStart + sentence.length;
    }
    offset = paragraphStart + paragraph.length;
  }

  for (const start of [...starts].sort((a, b) => a - b)) {
    if (start === 0) {
      continue;
    }
    const candidate = bodyMd.slice(start, start + length);
    // Короткий хвост тизером быть не может: пейволл показывает 400 знаков.
    if (candidate.length < Math.round(length / 2)) {
      continue;
    }
    if (firstTermAt(candidate) === null) {
      return { teaser: candidate, start, firstTerm: null, shifted: true, hasTerms: false };
    }
  }

  // Сдвинуть не удалось: термин в каждом окне. Оставляем как есть и отдаём
  // фактическое смещение — по нему видно, насколько текст «плотный».
  return {
    teaser: natural,
    start: 0,
    firstTerm: naturalTerm,
    shifted: false,
    hasTerms: true,
  };
}
