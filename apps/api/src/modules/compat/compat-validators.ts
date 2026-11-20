import {
  DISCLAIMER,
  SERVICE_TERMS,
  TEASER_TERMS,
  splitParagraphs,
  splitSentences,
  topWordShare,
} from '../reports/validators';

/**
 * Четыре раздела совместимости и правила, которые нельзя доверять промпту.
 *
 * Границы объёма — из задания на итерацию 23 (одна покупка, а не разбор:
 * суммарно 2 400–3 150 знаков). «Ты» — к человеку, «партнёр» — к паре:
 * пола партнёра мы не знаем, а «он/она» домысливает его за пользователя.
 */
export type CompatSectionKey = 'clicks' | 'friction' | 'scenario' | 'steps';

export const COMPAT_STRUCTURE_VERSION = 'compat_structure_v1';

/** Порядок разделов фиксирован: он же порядок ответа и порядок разрешения ничьих. */
export const COMPAT_SECTIONS: readonly CompatSectionKey[] = ['clicks', 'friction', 'scenario', 'steps'];

export interface CompatSectionRange {
  readonly key: CompatSectionKey;
  readonly title: string;
  readonly min: number;
  readonly max: number;
}

export const COMPAT_RANGES: readonly CompatSectionRange[] = [
  { key: 'clicks', title: 'Что совпадает', min: 700, max: 900 },
  { key: 'friction', title: 'Где трёт', min: 700, max: 900 },
  { key: 'scenario', title: 'Как вы разговариваете', min: 600, max: 800 },
  { key: 'steps', title: 'Что сделать на этой неделе', min: 400, max: 550 },
];

export const COMPAT_SECTION_TITLES: Readonly<Record<CompatSectionKey, string>> = {
  clicks: 'Что совпадает',
  friction: 'Где трёт',
  scenario: 'Как вы разговариваете',
  steps: 'Что сделать на этой неделе',
};

/**
 * Границы объёма для классификатора: только min и max, без «допусков».
 *
 * Итерация 27: раньше здесь жила двухступенчатая проверка — «меньше 300 →
 * `too_short`», «дальше 30 % от диапазона → `length`», «иначе `length_off`».
 * Из-за неё текст на 1 423 знака при максимуме 800 получал правило `length`,
 * которое сервис переводил в код `too_short`: живой прогон
 * `541d56a4-2530-4700-8831-3161ea6af554` упал как «слишком коротко», хотя
 * текст был на 78 % длиннее нормы.
 */
export interface CompatLengthRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Вердикт длины. Их три, и они не смешиваются:
 *   • `too_short` — только `chars < min` (лечится повторным вызовом);
 *   • `too_long` — только `chars > max` (лечится обрезкой, **не** отказом);
 *   • `ok` — в границах раздела.
 *
 * `length_off` здесь намеренно нет: это имя **предупреждения** контракта
 * (`Compatibility.warnings`), а не отказ. Одно имя на две роли — ровно та
 * путаница, из-за которой диагностика врала (см. `lengthWarning`).
 */
export type LengthVerdict = 'ok' | 'too_short' | 'too_long';

/**
 * Единственное место, где решается, «коротко», «длинно» или «норма».
 *
 * Три ветви, явные границы из конфигурации раздела, никаких «чужой
 * диапазон»: `scenario` сравнивается с 600–800, `steps` — с 400–550.
 */
export function classifyLength(chars: number, range: CompatLengthRange): LengthVerdict {
  if (chars < range.min) {
    return 'too_short';
  }
  if (chars > range.max) {
    return 'too_long';
  }
  return 'ok';
}

/** Куда отклонился объём — для предупреждения `length_off` (контракт 1.6.0). */
export function lengthDirection(
  chars: number,
  range: CompatLengthRange,
): 'below' | 'above' | null {
  if (chars < range.min) {
    return 'below';
  }
  if (chars > range.max) {
    return 'above';
  }
  return null;
}

/**
 * Минимум, при котором текст вообще считается разделом.
 *
 * Нужен только для повторного короткого ответа: по заданию второй подряд
 * «короткий» текст отдаётся как есть с предупреждением, но 40 знаков — это не
 * раздел, а обрывок ответа, и такой раздел валить весь продукт тоже нельзя:
 * он уходит в `dropped` как «нечего показывать».
 */
export const COMPAT_ACCEPT_MIN_CHARS = 200;

/** Первые 200 знаков раздела — «витрина»: терминов там быть не должно. */
export const COMPAT_OPENING_LENGTH = 200;

/** Абзацев в разделе: 2–4 (`steps` — список, к нему правило не применяется). */
export const COMPAT_PARAGRAPH_MIN = 2;
export const COMPAT_PARAGRAPH_MAX = 4;
export const COMPAT_SENTENCES_MIN = 2;
export const COMPAT_SENTENCES_MAX = 4;

/** Пунктов в `steps`: ровно три действия. */
export const COMPAT_STEPS_COUNT = 3;

/**
 * Вердикты. Это не стилистика: «вам не подходите» — утверждение о двух живых
 * людях, которого мы не можем сделать, и возврат звёзд после такого текста
 * не поможет. Поэтому — провал раздела, а не пометка.
 */
const VERDICTS =
  /не\s+подходите|не\s+пара|обречен|обречён|вам\s+не\s+стоит\s+быть|расстаньтесь|разводитесь|вас\s+ждёт\s+расставание/iu;

/** Процент совместимости и любые «оценки» пары числом. */
const COMPAT_PERCENT = /\d+\s?%|процент\w*\s+совместимост|совместимость\s+\d/iu;

/** Запрещённые темы: здоровье, деньги, право, предсказания событий. */
const FORBIDDEN_TOPICS: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: 'health', pattern: /диагноз|заболев|болезн|симптом|здоровь|врач|лечени|терапи/iu },
  { rule: 'money_advice', pattern: /инвест|кредит|ипотек|вклад\w*\s+под|налог/iu },
  { rule: 'legal_advice', pattern: /юрист|адвокат|подать\s+в\s+суд|иск\s+в\s+суд/iu },
  {
    rule: 'predictions',
    pattern: /к\s+концу\s+года|через\s+(месяц|год|неделю|полгода)|вернётся|выйдет\s+замуж|женится/iu,
  },
];

/** Пол партнёра: «он», «она», «его», «её» — домысел о человеке, которого мы не знаем. */
const PARTNER_PRONOUN = /(?<![\p{L}\p{N}])(?:он|она|его|её|ее|ему|ей)(?![\p{L}\p{N}])/iu;

/** Отсылки к интерфейсу: текст должен читаться и в PDF. */
const UI_REFERENCE = /нажм[\p{L}]*|свайп[\p{L}]*|тап[\p{L}]*|экран[\p{L}]*|кнопк[\p{L}]*/iu;

const FORMAT = {
  h1: /^\s*#\s/mu,
  table: /\|/u,
  link: /https?:|\]\(/iu,
  html: /<[a-z]/iu,
  badListMarker: /^\s*[-*•]\s/mu,
} as const;

export interface CompatWarning {
  /** Код; в контракт уходят только коды из `COMPAT_CONTRACT_WARNINGS`. */
  readonly code: string;
  readonly detail?: string;
  /**
   * Куда отклонился объём — только у `length_off`. Одно имя предупреждения
   * на обе стороны без направления читается как «что-то не так», а решение
   * («дописать» или «обрезать») требует знать сторону.
   */
  readonly direction?: 'below' | 'above';
}

export interface CompatValidationResult {
  readonly failures: readonly { readonly rule: string; readonly detail: string }[];
  readonly warnings: readonly CompatWarning[];
  /**
   * Вердикт длины отдельным полем, а не только через `failures`.
   *
   * `too_long` — не провал: его лечит обрезка (`trimCompatSection`), и
   * вызывающий обязан сначала обрезать, а уже потом решать судьбу раздела.
   * Раньше длина жила только в `failures`, и сервис не мог отличить
   * «дописать» от «обрезать».
   */
  readonly length: {
    readonly chars: number;
    readonly min: number;
    readonly max: number;
    readonly verdict: LengthVerdict;
  };
}

export interface CompatValidationInput {
  readonly key: CompatSectionKey;
  readonly bodyMd: string;
  /** Уже написанные разделы — для проверки повторных зачинов. */
  readonly previous?: readonly string[];
}

export const COMPAT_DISCLAIMER = DISCLAIMER;

/** Объём без подписи-дисклеймера: подпись — не текст раздела. */
function volumeOf(key: CompatSectionKey, body: string): string {
  return key === 'steps' && body.endsWith(COMPAT_DISCLAIMER)
    ? body.slice(0, body.length - COMPAT_DISCLAIMER.length).trimEnd()
    : body;
}

function listItems(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('—'));
}

/** Смещение первого астрологического термина в разделе (`null` — терминов нет). */
export function firstTermOffset(body: string): number | null {
  const match = TEASER_TERMS.exec(body);
  return match === null ? null : match.index;
}

function openers(body: string): string[] {
  return splitParagraphs(body).map((paragraph) =>
    (splitSentences(paragraph)[0] ?? '')
      .toLowerCase()
      .replace(/[«»"„“”()]/gu, '')
      .split(/\s+/u)
      .slice(0, 5)
      .join(' '),
  );
}

export function validateCompatSection(input: CompatValidationInput): CompatValidationResult {
  const failures: { rule: string; detail: string }[] = [];
  const warnings: CompatWarning[] = [];
  const body = input.bodyMd.trim();
  const range = COMPAT_RANGES.find((section) => section.key === input.key);

  if (range === undefined) {
    return {
      failures: [{ rule: 'section_unknown', detail: input.key }],
      warnings: [],
      length: { chars: body.length, min: 0, max: 0, verdict: 'ok' },
    };
  }

  const volume = volumeOf(input.key, body);
  const chars = volume.length;
  const verdict = classifyLength(chars, range);
  const direction = lengthDirection(chars, range);

  // Провал — только «коротко». «Длинно» чинится обрезкой (см. `section` в
  // сервисе и `trimCompatSection` ниже), а не отказом: модель написала
  // больше, чем просили, — это нормальное её поведение.
  if (verdict === 'too_short') {
    failures.push({ rule: 'too_short', detail: `${chars} < ${range.min}` });
  }

  if (verdict !== 'ok' && direction !== null) {
    warnings.push({
      code: 'length_off',
      direction,
      detail: `${chars} ${direction === 'below' ? 'меньше' : 'больше'} ${range.min}–${range.max}`,
    });
  }

  if (FORMAT.h1.test(body)) failures.push({ rule: 'format_h1', detail: 'H1' });
  if (FORMAT.table.test(body)) failures.push({ rule: 'format_table', detail: 'таблица' });
  if (FORMAT.link.test(body)) failures.push({ rule: 'format_link', detail: 'ссылка' });
  if (FORMAT.html.test(body)) failures.push({ rule: 'format_html', detail: 'HTML' });
  if (FORMAT.badListMarker.test(body)) {
    failures.push({ rule: 'format_list', detail: 'список не маркером «—»' });
  }
  if (UI_REFERENCE.test(body)) {
    failures.push({ rule: 'ui_reference', detail: 'отсылка к интерфейсу' });
  }

  // Вердикты, проценты, запрещённые темы — провал раздела, а не пометка.
  if (VERDICTS.test(body)) failures.push({ rule: 'verdict', detail: 'вердикт о паре' });
  if (COMPAT_PERCENT.test(body)) {
    failures.push({ rule: 'compat_percent', detail: 'процент совместимости' });
  }
  for (const topic of FORBIDDEN_TOPICS) {
    if (topic.pattern.test(body)) {
      failures.push({ rule: `forbidden_${topic.rule}`, detail: topic.rule });
    }
  }

  // Служебный словарь — пометка: смысл не меняем, но фиксируем утечку.
  const serviceTerms = SERVICE_TERMS.filter((term) => term.pattern.test(body)).map((term) => term.term);
  if (serviceTerms.length > 0) {
    warnings.push({ code: 'service_terms', detail: serviceTerms.join(', ') });
  }

  // Пол партнёра: «он/она/его/её» домысливают человека. Пометка, потому что
  // «его» бывает и притяжательным к «партнёр» — а вот «она» уже нет.
  const pronoun = PARTNER_PRONOUN.exec(body);
  if (pronoun !== null) {
    warnings.push({ code: 'partner_pronoun', detail: `«${pronoun[0]}» на ${pronoun.index}-м знаке` });
  }

  // Термины в первых 200 знаках: человек покупает про себя, а не про аспекты.
  const offset = firstTermOffset(body);
  if (offset !== null && offset < COMPAT_OPENING_LENGTH) {
    warnings.push({ code: 'terms_in_opening', detail: `первый термин на ${offset}-м знаке` });
  }

  if (input.key === 'steps') {
    const items = listItems(body);
    if (items.length !== COMPAT_STEPS_COUNT) {
      failures.push({
        rule: 'steps_count',
        detail: `${items.length} пунктов вместо ${COMPAT_STEPS_COUNT}`,
      });
    }
    if (!body.includes(COMPAT_DISCLAIMER)) {
      // Дисклеймер дописывает нормализатор — здесь только след.
      warnings.push({ code: 'disclaimer_missing' });
    }
  } else {
    const paragraphs = splitParagraphs(body);
    const listish = paragraphs.filter((paragraph) => paragraph.trimStart().startsWith('—'));
    if (listish.length > 0) {
      failures.push({ rule: 'steps_only_list', detail: 'список не в `steps`' });
    }
    if (paragraphs.length < COMPAT_PARAGRAPH_MIN || paragraphs.length > COMPAT_PARAGRAPH_MAX) {
      failures.push({
        rule: 'paragraphs',
        detail: `${paragraphs.length} вне ${COMPAT_PARAGRAPH_MIN}–${COMPAT_PARAGRAPH_MAX}`,
      });
    } else {
      for (const paragraph of paragraphs) {
        const sentences = splitSentences(paragraph).length;
        if (sentences < COMPAT_SENTENCES_MIN || sentences > COMPAT_SENTENCES_MAX) {
          failures.push({
            rule: 'sentences',
            detail: `${sentences} предложений вне ${COMPAT_SENTENCES_MIN}–${COMPAT_SENTENCES_MAX}`,
          });
          break;
        }
      }
    }
  }

  // Доля самого частого слова: текст не должен превращаться в мантру.
  const share = topWordShare(body);
  if (share.share > 0.14) {
    warnings.push({ code: 'word_share', detail: `${share.word} ${Math.round(share.share * 100)} %` });
  }

  // Повтор зачина с предыдущим разделом — та же болезнь, что в разборе.
  const own = openers(body);
  for (const previous of input.previous ?? []) {
    const theirs = openers(previous);
    if (own.some((opener) => opener !== '' && theirs.includes(opener))) {
      warnings.push({ code: 'repeated_opener' });
      break;
    }
  }

  return {
    failures,
    warnings,
    length: { chars, min: range.min, max: range.max, verdict },
  };
}

/**
 * Коды, которые контракт разрешает в `Compatibility.warnings` (1.6.0).
 * Всё остальное (`service_terms`, `partner_pronoun`, `word_share`,
 * `terms_in_opening`, `disclaimer_missing`) остаётся в БД и в логах: это
 * диагностика для нас, а не сообщение человеку.
 */
export const COMPAT_CONTRACT_WARNINGS = ['length_off', 'trimmed', 'disclaimer_added'] as const;

export interface CompatNormalization {
  readonly body: string;
  readonly applied: readonly string[];
}

/** Результат обрезки: что осталось и где именно резали. */
export interface CompatTrim {
  readonly body: string;
  /** Сколько знаков было в объёме (без подписи) до обрезки. */
  readonly from: number;
  /** Сколько осталось. */
  readonly to: number;
  /** По какой границе резали: абзац, предложение или слово. */
  readonly boundary: 'paragraph' | 'sentence' | 'word';
}

/**
 * Обрезка длинного раздела до диапазона — вместо отказа.
 *
 * Политика итерации 18 («форма чинится нормализацией») для совместимости не
 * работала: 1 423 знака при максимуме 800 считались провалом, раздел
 * выбрасывался, а весь продукт уходил в `failed` — за деньги владельца
 * (3,19 ₽ за прогон 1 180 → 1 423 знака).
 *
 * Режем по **границе абзаца** (для `steps` — по концу предложения внутри
 * пункта, чтобы не потерять ни один из трёх пунктов), затем по предложению,
 * затем по слову. Результат всегда в `[min, max]`; если такого варианта нет
 * (например, первый абзац сам длиннее максимума, а короче минимума резать
 * нечего) — `null`, и вызывающий отдаёт раздел как есть с предупреждением, но
 * **не выбрасывает**.
 */
export function trimCompatSection(input: {
  readonly key: CompatSectionKey;
  readonly bodyMd: string;
  readonly range: CompatLengthRange;
}): CompatTrim | null {
  const body = input.bodyMd.trim();
  const disclaimer =
    input.key === 'steps' && body.endsWith(COMPAT_DISCLAIMER) ? COMPAT_DISCLAIMER : null;
  const volume = disclaimer === null ? body : body.slice(0, body.length - disclaimer.length).trimEnd();
  const from = volume.length;

  if (classifyLength(from, input.range) !== 'too_long') {
    return null;
  }

  const suffix = disclaimer === null ? '' : `\n\n${disclaimer}`;

  // `steps` — отдельный путь: резать список по границе «абзаца» нельзя, а по
  // границе предложения можно потерять третий пункт. Режем внутри пунктов,
  // сохраняя все три.
  if (input.key === 'steps') {
    const byItems = trimSteps(volume, input.range, suffix);
    if (byItems !== null) {
      return byItems;
    }
  }

  // Кандидаты: смещение в объёме → по какой границе режем.
  const candidate = (offset: number, boundary: CompatTrim['boundary']): CompatTrim | null => {
    const cut = volume.slice(0, offset).trimEnd();
    if (classifyLength(cut.length, input.range) !== 'ok') {
      return null;
    }
    return { body: `${cut}${suffix}`, from, to: cut.length, boundary };
  };

  // 1. Абзацы (для `steps` не годится: абзац там — это весь список).
  // Берём **последний** абзац, при котором текст ещё в границах: режем
  // максимум лишнего, а не минимум.
  if (input.key !== 'steps') {
    const paragraphs = splitParagraphs(volume);
    let offset = 0;
    let byParagraph: CompatTrim | null = null;
    for (let index = 0; index < paragraphs.length - 1; index += 1) {
      offset += (paragraphs[index] ?? '').length + 2; // '\n\n'
      const next = candidate(offset - 2, 'paragraph');
      if (next !== null) {
        byParagraph = next;
      } else if (byParagraph !== null) {
        // Дальше только длиннее — в границы уже не вернёмся.
        break;
      }
    }
    if (byParagraph !== null) {
      return byParagraph;
    }
  }

  // 2. Предложения, от последнего к первому: длиннее всего, что влезает.
  const sentenceEnds = sentenceEndOffsets(volume);
  for (const end of [...sentenceEnds].reverse()) {
    const trimmed = candidate(end, 'sentence');
    if (trimmed !== null) {
      return trimmed;
    }
  }

  // 3. Слово: последний шанс уложиться в максимум, не разрывая слово.
  for (let offset = volume.length - 1; offset > 0; offset -= 1) {
    if (volume[offset] !== ' ') {
      continue;
    }
    if (offset <= input.range.max) {
      const trimmed = candidate(offset, 'word');
      if (trimmed !== null) {
        return trimmed;
      }
    }
  }

  return null;
}

/**
 * Обрезка `steps`: три пункта остаются тремя пунктами.
 *
 * Длинный список — это не «лишние абзацы», а три пункта по 3–4 предложения.
 * Обрезка «по предложению» через весь текст снесла бы третий пункт, и раздел
 * стал бы невалидным уже по количеству пунктов (`steps_count`) — то есть
 * обрезка сама себя отменила бы. Поэтому убираем **последние предложения**
 * самого длинного пункта, пока объём не влезет в `max`.
 */
function trimSteps(volume: string, range: CompatLengthRange, suffix: string): CompatTrim | null {
  const from = volume.length;
  const lines = volume.split('\n');
  const itemIndexes = lines
    .map((line, index) => (line.trim().startsWith('—') ? index : -1))
    .filter((index) => index >= 0);

  if (itemIndexes.length !== COMPAT_STEPS_COUNT) {
    return null;
  }

  const items = itemIndexes.map((index) => {
    const line = (lines[index] ?? '').trim();
    const sentences = splitSentences(line.replace(/^—\s*/u, ''));
    return { index, marker: line.slice(0, 1), sentences };
  });

  const lengthOf = (parts: readonly { marker: string; sentences: readonly string[] }[]): number =>
    parts.reduce((sum, item) => sum + `— ${item.sentences.join(' ')}`.length, 0) +
    (parts.length - 1);

  // Снимаем по одному предложению с самого длинного пункта: текст должен
  // остаться связным, а не «три обрывка».
  let guard = 0;
  while (lengthOf(items) > range.max && guard < 100) {
    guard += 1;
    const longest = [...items]
      .filter((item) => item.sentences.length > 1)
      .sort((left, right) => right.sentences.length - left.sentences.length)[0];
    if (longest === undefined) {
      break;
    }
    longest.sentences = longest.sentences.slice(0, -1);
  }

  const chars = lengthOf(items);
  if (classifyLength(chars, range) !== 'ok') {
    return null;
  }

  const body = items
    .map((item) => `${item.marker} ${item.sentences.join(' ')}`)
    .join('\n');

  return { body: `${body}${suffix}`, from, to: body.length, boundary: 'sentence' };
}

/** Смещения концов предложений: `splitSentences` теряет позиции. */
function sentenceEndOffsets(text: string): number[] {
  const offsets: number[] = [];
  const pattern = /[.!?…]+\s+/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    offsets.push(match.index + match[0].replace(/\s+$/u, '').length);
    match = pattern.exec(text);
  }
  // Последнее предложение заканчивается на конце текста — если текст длиннее
  // максимума, этот кандидат отсеется сам.
  offsets.push(text.length);
  return offsets;
}

/**
 * Приведение формы: маркеры списка, лишние пустые строки, подпись-дисклеймер.
 *
 * Смысл не правится: если модель написала вердикт или медицинский совет,
 * это провал раздела (`validateCompatSection`), а не «почистим и покажем».
 */
export function normalizeCompatSection(input: {
  readonly key: CompatSectionKey;
  readonly bodyMd: string;
}): CompatNormalization {
  const applied: string[] = [];
  const normalized = input.bodyMd.replace(/\r\n/gu, '\n');
  let body = normalized.trim();
  if (body !== normalized) {
    // Не `trimmed`: это имя занято обрезкой по длине (итерация 27), и два
    // разных события под одним словом в `normalization` не различить.
    applied.push('whitespace');
  }

  const withMarkers = body.replace(/^\s*[-*•]\s+/gmu, '— ');
  if (withMarkers !== body) {
    body = withMarkers;
    applied.push('list_markers');
  }

  const compact = body.replace(/\n{3,}/gu, '\n\n');
  if (compact !== body) {
    body = compact;
    applied.push('blank_lines');
  }

  if (input.key === 'steps' && !body.includes(COMPAT_DISCLAIMER)) {
    body = `${body}\n\n${COMPAT_DISCLAIMER}`;
    applied.push('disclaimer_added');
  }

  return { body, applied };
}
