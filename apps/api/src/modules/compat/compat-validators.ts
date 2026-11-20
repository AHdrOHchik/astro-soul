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

/** Пунктов в `steps`: ровно три действия — это требование **промпта**. */
export const COMPAT_STEPS_COUNT = 3;

/**
 * Сколько пунктов ещё считается списком действий (итерация 28).
 *
 * «Ровно три» — требование промпта, а не условие выдачи. Человеку четыре
 * полезных действия не хуже трёх, а два лучше, чем ничего: оплаченная покупка
 * не должна пропадать из-за арифметики в ответе модели. Вне этого окна ответ
 * считается нераспарсенным (это уже не список, а проза).
 */
export const COMPAT_STEPS_ITEMS_MIN = 1;
export const COMPAT_STEPS_ITEMS_MAX = 5;

/**
 * Сколько знаков допустимо в одном пункте `steps` (итерация 28).
 *
 * Пункт — одно действие: «что сделать, когда и в какой ситуации». 140 знаков
 * — это 2–3 предложения. Обрезка идёт **по пунктам**, а не по всему тексту:
 * живой прогон `46d8b893` потерял третий пункт, потому что общий триммер резал
 * список как абзац (`from=651 to=474`, `steps_count`, `dropped`).
 */
export const COMPAT_STEPS_ITEM_MAX = 140;

/**
 * Правила, которые для `steps` — пометка, а не отказ.
 *
 * Форма `steps` чинится нормализацией: список пересобирается из пунктов, а не
 * судится. Всё, чего здесь нет (вердикт о паре, процент совместимости,
 * запрещённые темы, нераспарсенный список), остаётся провалом: такой текст
 * нельзя показывать человеку ни за какие деньги.
 */
const SOFT_FOR_STEPS: ReadonlySet<string> = new Set([
  'too_short',
  'steps_count',
  'ui_reference',
  'paragraphs',
  'sentences',
  'format_h1',
  'format_table',
  'format_link',
  'format_html',
  'format_list',
]);

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

/**
 * Правило `ui_reference`: отсылка к интерфейсу приложения, а не к жизни.
 *
 * Ищет слова «нажм…», «свайп…», «тап…», «экран…», «кнопк…» — то есть текст,
 * который читается как инструкция к мини-аппу и ломается в PDF и в печати.
 * Найденное слово уходит в `matched`, чтобы код был диагностируемым: в живом
 * прогоне `46d8b893` пришло `failures: ["ui_reference"]` без единого намёка на
 * то, какое слово сработало.
 *
 * Для `clicks`/`friction`/`scenario` это провал (текст переписывается), для
 * `steps` — пометка: «отметь в календаре» в списке действий не повод не
 * отдать покупку.
 */
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
  /**
   * Что именно нашла проверка — слово или фрагмент (итерация 28).
   *
   * Без этого `ui_reference` в живом логе (`failures: ["ui_reference"]`) не
   * диагностируется: непонятно, «нажми», «экран» или «кнопка» сработали, и
   * поэтому нельзя понять, ложное это срабатывание или настоящая отсылка к
   * интерфейсу.
   */
  readonly matched?: string;
}

/**
 * Одна проверка раздела с её вердиктом (итерация 28).
 *
 * Зачем списком, а не только `failures`: в живом прогоне `46d8b893` запись
 * выглядела как `code: "format", verdict: "ok", failures: ["steps_count"]` —
 * три поля, которые противоречат друг другу, и по ним нельзя было понять,
 * что длина в порядке, а сломан список. Теперь в `validation` лежит весь
 * перечень: каждая проверка и её вердикт (`ok` / `warn` / `fail`).
 */
export interface CompatCheck {
  readonly rule: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail?: string;
  /** Код предупреждения — только у `warn`, чтобы связать с `warnings`. */
  readonly code?: string;
  readonly direction?: 'below' | 'above';
  readonly matched?: string;
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
  /** Все проверки с вердиктами — для `reports.validation` и логов. */
  readonly checks: readonly CompatCheck[];
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

/**
 * Итог раздела: **одна строка**, которая одновременно уходит в БД, в ответ
 * человеку и в логи (итерация 28).
 *
 * Почему отдельная функция: в живом прогоне `46d8b893` лог показал
 * `compat_section_trimmed steps from=651 to=474`, а следом
 * `compat_section_rejected steps chars=553`. Обрезали до 474, а на проверку
 * пришло 553 знака — потому что «длина без подписи» (объём), «длина с
 * подписью» (текст) и «длина того, что обрезали» считались в трёх местах
 * по-разному. После такого лога любые выводы недостоверны.
 *
 * Теперь: `text` — ровно то, что сохраняется и отдаётся; `chars` — его длина
 * (её и пишем в логи); `volumeChars` — длина без подписи (по ней вердикт
 * длины, потому что подпись — не текст раздела).
 */
export interface CompatFinalSection {
  readonly text: string;
  readonly chars: number;
  readonly volumeChars: number;
}

export function finalizeSection(input: {
  readonly key: CompatSectionKey;
  readonly bodyMd: string;
}): CompatFinalSection {
  const text = input.bodyMd.trim();
  return {
    text,
    chars: text.length,
    volumeChars: volumeOf(input.key, text).length,
  };
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
  const checks: CompatCheck[] = [];
  const range = COMPAT_RANGES.find((section) => section.key === input.key);
  const body = input.bodyMd.trim();

  if (range === undefined) {
    return {
      failures: [{ rule: 'section_unknown', detail: input.key }],
      warnings: [],
      length: { chars: body.length, min: 0, max: 0, verdict: 'ok' },
      checks: [{ rule: 'section_unknown', status: 'fail', detail: input.key }],
    };
  }

  /**
   * Вердикт проверки: `fail` — раздел не отдаём, `warn` — отдаём с пометкой.
   *
   * Для `steps` форма всегда мягкая (`SOFT_FOR_STEPS`): список пересобирается,
   * а не судится. Содержательные запреты (вердикт о паре, процент, медицина,
   * деньги, право) остаются жёсткими для всех разделов — такой текст нельзя
   * показывать человеку, и это единственная причина, по которой раздел ещё
   * может не дойти до покупателя.
   */
  const statusOf = (rule: string): 'fail' | 'warn' =>
    input.key === 'steps' && SOFT_FOR_STEPS.has(rule) ? 'warn' : 'fail';

  const fail = (rule: string, detail: string, matched?: string): void => {
    const status = statusOf(rule);
    checks.push({
      rule,
      status,
      detail,
      // Понижённый до пометки провал обязан получить `code`: без него он не
      // попадёт в `warnings`, и «ui_reference» в логе снова окажется без
      // слова, которое его вызвало.
      ...(status === 'warn' ? { code: rule } : {}),
      ...(matched === undefined ? {} : { matched }),
    });
  };
  const warn = (code: string, detail?: string, extra?: Partial<CompatCheck>): void => {
    checks.push({
      rule: extra?.rule ?? code,
      status: 'warn',
      code,
      ...(detail === undefined ? {} : { detail }),
      ...(extra?.direction === undefined ? {} : { direction: extra.direction }),
      ...(extra?.matched === undefined ? {} : { matched: extra.matched }),
    });
  };

  // --- длина: по объёму без подписи, границы — из конфигурации раздела.
  const volume = volumeOf(input.key, body);
  const chars = volume.length;
  const verdict = classifyLength(chars, range);
  const direction = lengthDirection(chars, range);

  // «Коротко» — провал только там, где длина и правда условие выдачи. Для
  // `steps` (400–550) это мягкий ориентир: три действия важнее объёма.
  if (verdict === 'too_short') {
    fail('too_short', `${chars} < ${range.min}`);
  }
  if (verdict !== 'ok' && direction !== null) {
    warn(
      'length_off',
      `${chars} ${direction === 'below' ? 'меньше' : 'больше'} ${range.min}–${range.max}`,
      { direction },
    );
  }

  // --- разметка. Для `steps` — пометка: ссылка или таблица в списке действий
  // не повод не отдать покупку, а вот в абзацном разделе это ломает вёрстку.
  if (FORMAT.h1.test(body)) fail('format_h1', 'H1');
  if (FORMAT.table.test(body)) fail('format_table', 'таблица');
  if (FORMAT.link.test(body)) fail('format_link', 'ссылка');
  if (FORMAT.html.test(body)) fail('format_html', 'HTML');
  if (FORMAT.badListMarker.test(body)) fail('format_list', 'список не маркером «—»');

  // --- отсылка к интерфейсу. Регулярка ищет слова, которыми текст
  // превращается в инструкцию к приложению («нажми», «свайпни», «экран»,
  // «кнопка», «тап»). `matched` — то самое слово: без него код не
  // диагностируется.
  const ui = UI_REFERENCE.exec(body);
  if (ui !== null) {
    fail('ui_reference', `«${ui[0]}» на ${ui.index}-м знаке`, ui[0]);
  }

  // --- содержательные запреты: вердикт о паре, процент, опасные темы.
  if (VERDICTS.test(body)) fail('verdict', 'вердикт о паре');
  if (COMPAT_PERCENT.test(body)) fail('compat_percent', 'процент совместимости');
  for (const topic of FORBIDDEN_TOPICS) {
    if (topic.pattern.test(body)) {
      fail(`forbidden_${topic.rule}`, topic.rule);
    }
  }

  // --- служебный словарь: пометка, смысл не меняем.
  const serviceTerms = SERVICE_TERMS.filter((term) => term.pattern.test(body)).map((term) => term.term);
  if (serviceTerms.length > 0) {
    checks.push({
      rule: 'service_terms',
      status: 'warn',
      code: 'service_terms',
      detail: serviceTerms.join(', '),
      matched: serviceTerms[0],
    });
  }

  // --- род партнёра.
  const pronoun = PARTNER_PRONOUN.exec(body);
  if (pronoun !== null) {
    checks.push({
      rule: 'partner_pronoun',
      status: 'warn',
      code: 'partner_pronoun',
      detail: `«${pronoun[0]}» на ${pronoun.index}-м знаке`,
      matched: pronoun[0],
    });
  }

  // --- термины в первых 200 знаках.
  const offset = firstTermOffset(body);
  if (offset !== null && offset < COMPAT_OPENING_LENGTH) {
    checks.push({
      rule: 'terms_in_opening',
      status: 'warn',
      code: 'terms_in_opening',
      detail: `первый термин на ${offset}-м знаке`,
    });
  }

  // --- структура.
  if (input.key === 'steps') {
    const items = listItems(body);
    if (items.length === 0) {
      // Проза вместо списка — это не «форма не та», а нераспарсенный ответ:
      // собирать три действия не из чего. Единственный структурный провал,
      // который остаётся у `steps`.
      checks.push({
        rule: 'steps_unparsed',
        status: 'fail',
        detail: 'ни одного пункта «—»',
      });
    } else if (items.length !== COMPAT_STEPS_COUNT) {
      // 2 или 4 пункта — принимаем. «Ровно три» — требование промпта.
      checks.push({
        rule: 'steps_count',
        status: 'warn',
        code: 'steps_count',
        detail: `${items.length} пунктов вместо ${COMPAT_STEPS_COUNT}`,
        matched: String(items.length),
      });
    } else {
      checks.push({ rule: 'steps_count', status: 'ok', detail: '3 пункта' });
    }
    if (items.length > COMPAT_STEPS_ITEMS_MAX) {
      // Шесть и больше пунктов — это уже не «три действия», а пересказ.
      // Мягкая пометка: лишние пункты видны человеку, но раздел отдаём.
      checks.push({
        rule: 'steps_items_many',
        status: 'warn',
        code: 'steps_items_many',
        detail: `${items.length} пунктов`,
        matched: String(items.length),
      });
    }
    if (!body.includes(COMPAT_DISCLAIMER)) {
      // Дисклеймер дописывает нормализатор — здесь только след.
      checks.push({ rule: 'disclaimer_missing', status: 'warn', code: 'disclaimer_missing' });
    }
  } else {
    const paragraphs = splitParagraphs(body);
    const listish = paragraphs.filter((paragraph) => paragraph.trimStart().startsWith('—'));
    if (listish.length > 0) {
      fail('steps_only_list', 'список не в `steps`');
    }
    if (paragraphs.length < COMPAT_PARAGRAPH_MIN || paragraphs.length > COMPAT_PARAGRAPH_MAX) {
      fail('paragraphs', `${paragraphs.length} вне ${COMPAT_PARAGRAPH_MIN}–${COMPAT_PARAGRAPH_MAX}`);
    } else {
      for (const paragraph of paragraphs) {
        const sentences = splitSentences(paragraph).length;
        if (sentences < COMPAT_SENTENCES_MIN || sentences > COMPAT_SENTENCES_MAX) {
          fail('sentences', `${sentences} предложений вне ${COMPAT_SENTENCES_MIN}–${COMPAT_SENTENCES_MAX}`);
          break;
        }
      }
    }
  }

  // --- доля самого частого слова.
  const share = topWordShare(body);
  if (share.share > 0.14) {
    checks.push({
      rule: 'word_share',
      status: 'warn',
      code: 'word_share',
      detail: `${share.word} ${Math.round(share.share * 100)} %`,
      matched: share.word,
    });
  }

  // --- повтор зачина с предыдущим разделом.
  const own = openers(body);
  for (const previous of input.previous ?? []) {
    const theirs = openers(previous);
    if (own.some((opener) => opener !== '' && theirs.includes(opener))) {
      checks.push({ rule: 'repeated_opener', status: 'warn', code: 'repeated_opener' });
      break;
    }
  }

  const failures = checks
    .filter((check) => check.status === 'fail')
    .map((check) => ({ rule: check.rule, detail: check.detail ?? '' }));
  const warnings: CompatWarning[] = checks
    .filter((check) => check.status === 'warn' && check.code !== undefined)
    .map((check) => ({
      code: check.code ?? '',
      ...(check.detail === undefined ? {} : { detail: check.detail }),
      ...(check.direction === undefined ? {} : { direction: check.direction }),
      ...(check.matched === undefined ? {} : { matched: check.matched }),
    }));

  return {
    failures,
    warnings,
    length: { chars, min: range.min, max: range.max, verdict },
    checks,
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
  /** Итоговый текст — ровно тот, что уйдёт в БД и человеку (с подписью). */
  readonly body: string;
  /** Длина его же: `body.length`. Одно число для логов, проверки и выдачи. */
  readonly chars: number;
  /** Сколько знаков было в объёме (без подписи) до обрезки. */
  readonly from: number;
  /** Сколько осталось в объёме (без подписи). */
  readonly to: number;
  /** По какой границе резали. `items` — поштучно, как требует `steps`. */
  readonly boundary: 'paragraph' | 'sentence' | 'word' | 'items';
  /**
   * Уложились ли в границы раздела.
   *
   * Для `steps` это **мягкий** ориентир: если после поштучной обрезки объём
   * всё ещё вне 400–550, текст отдаётся как есть с предупреждением
   * `length_off`, потому что три действия — жёсткий инвариант, а длина — нет.
   */
  readonly inRange: boolean;
}

/** Пункт `steps` после поштучной обрезки. */
interface StepsItem {
  readonly text: string;
}

/**
 * Список `steps` из текста: пункт начинается с «—», продолжения склеиваются.
 *
 * Склейка нужна потому, что длинный пункт модель иногда переносит на вторую
 * строку без маркера: если считать пункты только по маркерам, такой перенос
 * выглядит как «потерянный» пункт, и обрезка снова начинает резать список.
 */
function stepsItems(body: string): string[] {
  const items: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('—')) {
      items.push(line.replace(/^—\s*/u, '').trim());
      continue;
    }
    if (items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${line}`.trim();
    }
  }
  return items.filter((item) => item !== '');
}

/** Обрезка одного пункта: по границе слова, с точкой в конце. */
export function trimStepsItem(item: string, max: number = COMPAT_STEPS_ITEM_MAX): string {
  const text = item.trim();
  if (text.length <= max) {
    return /[.!?…]$/u.test(text) ? text : `${text}.`;
  }

  const window = text.slice(0, max);
  const space = window.lastIndexOf(' ');
  const cut = (space > 0 ? window.slice(0, space) : window).replace(/[\s,;:—–-]+$/u, '');

  // Висячий союз или предлог в конце — признак обрыва: снимаем его.
  const cleaned = cut.replace(/\s+(и|а|но|или|что|как|к|в|на|с|у|о|об|по|за|из|от|до)$/iu, '');

  return `${cleaned}.`;
}

/**
 * Поштучная обрезка `steps` — единственный допустимый путь для этого раздела.
 *
 * Живой прогон `46d8b893`: первый ответ (651 знак) общий триммер порезал по
 * предложению до 474 — третий пункт исчез, `steps_count` стал провалом, раздел
 * выброшен, оплаченная покупка ушла в `failed`. Вторая попытка (799 знаков)
 * обрезалась «по слову» до 539 — снова без пункта, плюс `ui_reference`.
 *
 * Поэтому: каждый пункт ограничивается отдельно, текст собирается заново из
 * **всех** пунктов, подпись-дисклеймер всегда прикрепляется последним абзацем
 * и никогда не участвует в обрезке.
 */
export function trimSteps(input: {
  readonly bodyMd: string;
  readonly range: CompatLengthRange;
}): CompatTrim | null {
  const raw = input.bodyMd.trim();
  const hasDisclaimer = raw.endsWith(COMPAT_DISCLAIMER);
  const volume = hasDisclaimer ? raw.slice(0, raw.length - COMPAT_DISCLAIMER.length).trimEnd() : raw;
  const from = volume.length;
  const items = stepsItems(volume);

  if (items.length === 0) {
    return null;
  }

  const cut: StepsItem[] = items.map((item) => ({ text: trimStepsItem(item) }));
  const rebuiltVolume = cut.map((item) => `— ${item.text}`).join('\n');
  const body = `${rebuiltVolume}\n\n${COMPAT_DISCLAIMER}`;

  return {
    body,
    chars: body.length,
    from,
    to: rebuiltVolume.length,
    boundary: 'items',
    inRange: classifyLength(rebuiltVolume.length, input.range) === 'ok',
  };
}

/**
 * Обрезка длинного раздела до диапазона — вместо отказа.
 *
 * Политика итерации 18 («форма чинится нормализацией») для совместимости не
 * работала: 1 423 знака при максимуме 800 считались провалом, раздел
 * выбрасывался, а весь продукт уходил в `failed` — за деньги владельца
 * (3,19 ₽ за прогон 1 180 → 1 423 знака).
 *
 * Для `clicks`/`friction`/`scenario` режем по границе абзаца, затем
 * предложения, затем слова. Для `steps` этот путь **запрещён** (итерация 28):
 * список режется только поштучно (`trimSteps`), иначе теряется пункт.
 */
export function trimCompatSection(input: {
  readonly key: CompatSectionKey;
  readonly bodyMd: string;
  readonly range: CompatLengthRange;
}): CompatTrim | null {
  // `steps` — только поштучно. Общий триммер для него не вызывается никогда:
  // абзац здесь — весь список, а «предложение» и «слово» режут его поперёк.
  if (input.key === 'steps') {
    return trimSteps({ bodyMd: input.bodyMd, range: input.range });
  }

  const body = input.bodyMd.trim();
  const from = body.length;

  if (classifyLength(from, input.range) !== 'too_long') {
    return null;
  }

  const candidate = (
    offset: number,
    boundary: CompatTrim['boundary'],
  ): CompatTrim | null => {
    const cut = body.slice(0, offset).trimEnd();
    if (classifyLength(cut.length, input.range) !== 'ok') {
      return null;
    }
    return { body: cut, chars: cut.length, from, to: cut.length, boundary, inRange: true };
  };

  // 1. Абзацы: берём **последний**, при котором текст ещё в границах.
  const paragraphs = splitParagraphs(body);
  let offset = 0;
  let byParagraph: CompatTrim | null = null;
  for (let index = 0; index < paragraphs.length - 1; index += 1) {
    offset += (paragraphs[index] ?? '').length + 2; // '\n\n'
    const next = candidate(offset - 2, 'paragraph');
    if (next !== null) {
      byParagraph = next;
    } else if (byParagraph !== null) {
      break;
    }
  }
  if (byParagraph !== null) {
    return byParagraph;
  }

  // 2. Предложения, от последнего к первому.
  for (const end of [...sentenceEndOffsets(body)].reverse()) {
    const trimmed = candidate(end, 'sentence');
    if (trimmed !== null) {
      return trimmed;
    }
  }

  // 3. Слово: последний шанс уложиться в максимум, не разрывая слово.
  for (let index = body.length - 1; index > 0; index -= 1) {
    if (body[index] !== ' ' || index > input.range.max) {
      continue;
    }
    const trimmed = candidate(index, 'word');
    if (trimmed !== null) {
      return trimmed;
    }
  }

  return null;
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
