/**
 * Валидаторы главы, которые нельзя доверять промпту (P0-5).
 *
 * Источник правил: `docs/qa/reports/llm-prompts.md` §5.2–5.5,
 * `docs/qa/reports/rubric.md` §1 (пункты типа «К») и
 * `docs/qa/reports/backend-requests.md` §P0-5 / §1.1.
 *
 * Валидаторы применяются **только** к `body_md`, пришедшему из API. Файлы
 * документации (`llm-prompts.md` содержит сами регулярки, `examples.md` —
 * антипримеры с запрещённой лексикой) через них не прогоняются: иначе
 * документация не пройдёт собственную проверку.
 */

export type SectionKey = 'core' | 'emotions' | 'talents' | 'relations' | 'money' | 'purpose' | 'summary';

export type TimePrecision = 'exact' | 'approximate' | 'unknown';

export interface SectionRange {
  readonly key: SectionKey;
  readonly title: string;
  readonly min: number;
  readonly max: number;
}

/**
 * `structure_v1.1`: границы объёма из `docs/qa/reports/structure.md` §1
 * (сумма минимумов 6 950, максимумов 8 800 знаков) плюс правки приёмки QA-002:
 * оговорка режима `unknown` проходит проверку домов, добавлен формальный
 * контроль абзацев и повторов (QA-22). Промпты — `prompts_v1.3`.
 */
export const STRUCTURE_VERSION = 'structure_v1.1';

export const SECTIONS: readonly SectionRange[] = [
  { key: 'core', title: 'Ядро личности', min: 1_200, max: 1_550 },
  { key: 'emotions', title: 'Эмоции и внутренний мир', min: 1_050, max: 1_300 },
  { key: 'talents', title: 'Таланты и сильные стороны', min: 950, max: 1_200 },
  { key: 'relations', title: 'Отношения', min: 1_100, max: 1_350 },
  { key: 'money', title: 'Деньги, работа, реализация', min: 1_150, max: 1_400 },
  { key: 'purpose', title: 'Смысл и направление', min: 1_000, max: 1_250 },
  { key: 'summary', title: 'Итог: что с этим делать', min: 500, max: 750 },
];

export const DISCLAIMER = 'Разбор — инструмент саморефлексии, а не предсказание и не замена специалисту.';

/**
 * Границы слова для кириллицы нельзя писать через `\b`: в JavaScript `\b`
 * опирается на ASCII-`\w`, и «в десятом доме» через `\b` не находится вовсе
 * (кириллица считается не-словом с обеих сторон). Поэтому граница — явный
 * негативный просмотр по буквам и цифрам Unicode.
 */
const NOT_LETTER_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

/** Слово «Хирон» — провал: в fallback-режиме его нет в карте. */
const CHIRON = /хирон[\p{L}]*|chiron/iu;

/** «вы» в любом регистре: промпты требуют «ты». */
const SECOND_PERSON_PLURAL = new RegExp(
  `${NOT_LETTER_BEFORE}(?:вы|ваш[\\p{L}]*|вас|вами)${NOT_LETTER_AFTER}`,
  'iu',
);

/**
 * Астрологические термины. Запрещены **только** в тизере — первых 400 знаках
 * `core` (`llm-prompts.md` §3.1, `structure.md` §2.1): тизер видит человек,
 * который ещё не заплатил, и названия планет ему ничего не объясняют.
 *
 * В остальном тексте эти слова обязательны: глава про Луну в 6-м доме без
 * слова «Луна» не пишется. Живой прогон 18.11.2026 на `GigaChat 2 Max`
 * потерял главу `emotions` из-за того, что проверка терминов считалась
 * правилом главы, а не правилом тизера.
 */
export const TEASER_LENGTH = 400;

export const TEASER_TERMS =
  /солн|лун|меркур|венер|марс|юпитер|сатурн|уран|нептун|плутон|узел|асцендент|дом[аеу]?\b|аспект|трин|квадрат|оппозиц|стихи|крест|овен|телец|близнец|рак\b|лев\b|дев[аеы]|весы|скорпион|стрелец|козерог|водолей|рыб[аы]/iu;

/**
 * Служебный словарь разбора: внутренние имена из `structure.md`, которые
 * просочились в текст живого прогона («Цена точки утечки — согласие на
 * отсроченные вознаграждения…», глава `money`). Человеку они ничего не
 * говорят, но текст читается как выдержка из нашего ТЗ.
 *
 * Проверка по всему тексту всех глав, `severity: warning`: смысл не правим,
 * только показываем, что словарь течёт, и фиксируем это в `validation`.
 */
export const SERVICE_TERMS: readonly { readonly term: string; readonly pattern: RegExp }[] = [
  { term: 'точка утечки', pattern: /точк[аи]\s+утечк/iu },
  { term: 'слой скорости', pattern: /сло[йя]\s+скорост/iu },
  { term: 'слой прочности', pattern: /сло[йя]\s+прочност/iu },
  { term: 'карта покрытия', pattern: /карт[аы]\s+покрыти/iu },
  { term: 'фокус', pattern: /(?<![\p{L}\p{N}])фокус[\p{L}]*/iu },
  { term: 'промпт', pattern: /(?<![\p{L}\p{N}])промпт[\p{L}]*/iu },
  { term: 'план разбора', pattern: /план[\p{L}]*\s+разбор/iu },
];

/**
 * Зачины абзацев. Первые пять слов первого предложения абзаца не должны
 * повторяться в другой главе: живой прогон на `Max` дал три главы, которые
 * начинались одинаково — «Марс в секстиле с Юпитером даёт оптимизм и
 * готовность пробовать новое». По 8-граммам такая калька не ловится:
 * пересечение каждого предложения по отдельности ниже 12 %.
 */
export const OPENER_WORDS = 5;

/** Отсылки к интерфейсу: текст должен читаться и в PDF. */
const UI_REFERENCE = /нажм[\p{L}]*|свайп[\p{L}]*|тап[\p{L}]*|экран[\p{L}]*|цвет[\p{L}]*|кнопк[\p{L}]*/iu;

const FORMAT = {
  h1: /^#\s/m,
  table: /\|/,
  link: /https?:|]\(/i,
  html: /<[a-z]/i,
  // Список допустим только маркером «—».
  listMarker: /^[-*•]\s/m,
} as const;

/**
 * Запрещённые темы (`llm-prompts.md` §5.4). Грубо и с запасом: лучше
 * перегенерировать главу, чем показать пользователю «карму» или диагноз.
 */
const FORBIDDEN_TOPICS: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  {
    rule: 'health',
    pattern: /диагноз|заболев|болезн|симптом|здоровь|врач|лечени|терапи/iu,
  },
  { rule: 'death', pattern: /смерт|умр[её]|умира|гибел|кончин|похорон/iu },
  { rule: 'children', pattern: /беременн|зачат|роды|деторожд|бесплод|аборт/iu },
  {
    rule: 'money_guarantee',
    pattern: /гарантированн\w*.*доход|разбогате|инвест|акци|крипт|депозит|доходност/iu,
  },
  {
    rule: 'esoterics',
    pattern:
      /кармическ|порч|сглаз|в прошлой жизни|суждено|предназначен|мисси|вселенная\s+(ведёт|подскажет|поможет)|энергетик|аур[аыу]/iu,
  },
  {
    // «предназначение», «миссия», «суждено» запрещены и в отрицании:
    // «это не про предназначение» даёт ту же интонацию.
    rule: 'destiny_words',
    pattern: /предназначени|мисси[яю]|суждено/iu,
  },
  { rule: 'fear', pattern: /травм|токсичн|выгорани/iu },
  { rule: 'predictions', pattern: /вернётся|изменится к лучшему|выйдет замуж|женится/iu },
  {
    rule: 'predictions',
    pattern: /к концу года|через (месяц|год|неделю|полгода)|уже (этой|этой же) (осенью|зимой|весной|летом)/iu,
  },
];

/**
 * Hard fail — ссылка на дом или угол (`backend-requests.md` §1.1).
 * Ловит конструкции, а не слово «дом»: «домой», «дома», «домашний»,
 * «доминирующая» проходят через негативный просмотр.
 */
const HOUSE_REF_HARD =
  /(?:(?:в|во|по|из|у)\s+(?:[1-9]|1[0-2])(?:-?(?:й|м|го|ой))?\s+дом[\p{L}]*)|(?:(?:[1-9]|1[0-2])(?:-?(?:й|м|го|ой))\s+дом[\p{L}]*)|(?:дом[\p{L}]*\s*(?:№\s*)?(?:[1-9]|1[0-2])(?!\d))|(?:(?:перв|втор|трет|четв[её]рт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат)[\p{L}]*\s+дом[\p{L}]*)|(?:по\s+домам)|(?:дом[\p{L}]*\s+(?:карты|гороскопа))|(?:куспид[\p{L}]*)|(?:асцендент[\p{L}]*)|(?:asc)|(?:mc)|(?:середин[\p{L}]*\s+неба)|(?:зенит[\p{L}]*)/iu;

/**
 * Первое запрещённое правило в готовом тексте — тот же список, что у глав
 * разбора, но без требований к длине, абзацам и дисклеймеру.
 *
 * Нужен коротким текстам, которые мы пишем сами и показываем под своим именем:
 * строки карточек (`MOON_ADVICE`) — совет, то есть ровно то, что модели
 * запрещено. Константа не значит «проверенная»: список живёт здесь, поэтому
 * проверка живёт здесь же, а не в копии в другом языке.
 */
export function forbiddenTopicIn(text: string): string | null {
  for (const topic of FORBIDDEN_TOPICS) {
    if (topic.pattern.test(text)) {
      return topic.rule;
    }
  }

  return null;
}

/** Soft warning — «в доме» без числа: сигнал, но не провал. */
const HOUSE_REF_SOFT = /(?<![\p{L}\p{N}])в\s+доме(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])дом(?!ой|а(?![\p{L}\p{N}])|ашн|инир|ен)/iu;

/** Маркеры честной оговорки о неполноте. */
const INCOMPLETENESS_MARKER = /неизвестн|не рассчитан|не построен|приблизительн/iu;

/**
 * Абзацы и повторы внутри главы (QA-22). Числа — из `rubric.md` §1, пункт 7:
 * абзацев 3–6, в абзаце 2–4 предложения. Доля самого частого слова ограничена,
 * чтобы текст не превращался в мантру: 12 % для обычных глав, 18 % для `core`
 * (там неизбежны повторы «Солнце», «Луна», «стихия»).
 */
export const PARAGRAPH_MIN = 3;
export const PARAGRAPH_MAX = 6;
export const SENTENCES_PER_PARAGRAPH_MIN = 2;
export const SENTENCES_PER_PARAGRAPH_MAX = 4;
export const WORD_SHARE_LIMIT = 0.12;
export const CORE_WORD_SHARE_LIMIT = 0.18;

/**
 * Стоп-слова `rubric.md` §1: служебные и местоименные слова не создают
 * «повтор» и не участвуют в доле частотного слова. Список намеренно короткий
 * и без «своих» слов разбора («стихия», «планета»), иначе проверка потеряет
 * смысл.
 */
const STOP_WORDS = new Set([
  'а', 'без', 'более', 'больше', 'будет', 'бы', 'был', 'была', 'были', 'было', 'быть',
  'в', 'вам', 'вас', 'весь', 'во', 'вот', 'все', 'всё', 'всегда', 'всего', 'вы', 'где',
  'да', 'даже', 'для', 'до', 'его', 'ее', 'её', 'ей', 'если', 'ест', 'есть', 'еще', 'ещё',
  'же', 'за', 'здесь', 'и', 'из', 'или', 'им', 'их', 'к', 'как', 'какая', 'какие', 'какой',
  'когда', 'кто', 'ли', 'либо', 'м', 'меня', 'мне', 'может', 'можно', 'мой', 'моя', 'мы',
  'на', 'над', 'надо', 'наш', 'не', 'него', 'нее', 'неё', 'нет', 'ни', 'них', 'но', 'ну',
  'о', 'об', 'однако', 'он', 'она', 'они', 'оно', 'от', 'по', 'под', 'после', 'потому',
  'при', 'про', 'с', 'сам', 'свои', 'свой', 'себе', 'себя', 'так', 'также', 'там', 'те',
  'тем', 'то', 'того', 'тоже', 'той', 'только', 'том', 'тот', 'ту', 'ты', 'у', 'уже',
  'хотя', 'чего', 'чем', 'через', 'что', 'чтобы', 'чуть', 'эта', 'эти', 'это', 'этот',
  'эту', 'я',
]);

/** Абзацы по пустой строке: именно так их видит рендер (`\n\n`). */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/gu, '\n')
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

function isListParagraph(paragraph: string): boolean {
  const lines = paragraph.split('\n').filter((line) => line.trim() !== '');
  const listLines = lines.filter((line) => line.trim().startsWith('—'));
  return lines.length > 0 && listLines.length * 2 >= lines.length;
}

/** Доля самого частого слова среди значимых слов главы. */
export function topWordShare(text: string): { readonly word: string; readonly share: number } {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  if (words.length === 0) {
    return { word: '', share: 0 };
  }
  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let top = '';
  let topCount = 0;
  for (const [word, count] of counts) {
    if (count > topCount) {
      top = word;
      topCount = count;
    }
  }
  return { word: top, share: topCount / words.length };
}

/**
 * Дословный повтор предложения внутри главы. Короткие реплики («Да.») не
 * считаем: повторяются междометия, а не смысл.
 */
export function repeatedSentences(text: string): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const sentence of splitSentences(text)) {
    const normalized = sentence
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (normalized.length < 25) {
      continue;
    }
    if (seen.has(normalized)) {
      repeated.push(sentence.slice(0, 60));
    } else {
      seen.add(normalized);
    }
  }
  return repeated;
}

export interface ValidationInput {
  readonly key: SectionKey;
  readonly bodyMd: string;
  readonly timePrecision: TimePrecision;
  /** Тексты уже написанных глав — для проверки повторов по 8-граммам. */
  readonly previous?: readonly string[];
  /**
   * Тизер `core` (окно до 400 знаков после сдвига). Передаётся только для
   * `core`: проверка астрологических терминов существует **только** для
   * тизера, а не для главы.
   */
  readonly teaser?: string;
}

export interface ValidationResult {
  /** Провал: главу нельзя показывать, нужна перегенерация. */
  readonly failures: readonly { readonly rule: string; readonly detail: string }[];
  /** Сигнал: глава может уйти, но стоит посмотреть (в `reports.validation`). */
  readonly warnings: readonly string[];
}

/**
 * Первые слова первого предложения абзаца — «зачин». Приводится к нижнему
 * регистру, пунктуация по краям срезается: «Марс в секстиле с Юпитером…»
 * и «марс в секстиле с юпитером» — один и тот же зачин.
 */
export function openerOf(paragraph: string): string {
  const first = splitSentences(paragraph)[0] ?? '';
  const words = first
    .toLowerCase()
    .replace(/[«»"„“”()]/gu, '')
    .split(/\s+/u)
    .map((word) => word.replace(/[.,:;!?…—-]+$/u, ''))
    .filter((word) => word !== '');

  return words.slice(0, OPENER_WORDS).join(' ');
}

/** Делит текст на предложения: точка/!/?/… с последующим пробелом или концом. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function ngrams(text: string, size = 8): Set<string> {
  const words = normalize(text).split(' ').filter((word) => word !== '');
  const result = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) {
    result.add(words.slice(index, index + size).join(' '));
  }
  return result;
}

/** Доля 8-грамм главы, встречающихся в предыдущей. */
export function overlapRatio(current: string, previous: string): number {
  const currentGrams = ngrams(current);
  if (currentGrams.size === 0) {
    return 0;
  }
  const previousGrams = ngrams(previous);
  let shared = 0;
  for (const gram of currentGrams) {
    if (previousGrams.has(gram)) {
      shared += 1;
    }
  }
  return shared / currentGrams.size;
}

/** Максимум пересечения с любой из предыдущих глав. */
export function maxOverlap(current: string, previous: readonly string[]): number {
  return previous.reduce((max, text) => Math.max(max, overlapRatio(current, text)), 0);
}

/**
 * Предложения-оговорки: в них есть маркер неполноты **и** упоминание дома/угла.
 * Ровно эти предложения структура требует в `core` (в конце) и `summary`
 * (в начале) при `unknown`, и без исключения валидатор забраковал бы
 * обязательный текст. Оговорок допустимо не больше одной.
 */
function disclaimers(sentences: readonly string[]): number[] {
  const found: number[] = [];
  sentences.forEach((sentence, index) => {
    if (INCOMPLETENESS_MARKER.test(sentence) && HOUSE_REF_HARD.test(sentence)) {
      found.push(index);
    }
  });
  return found;
}

export function validateSection(input: ValidationInput): ValidationResult {
  const failures: { rule: string; detail: string }[] = [];
  const warnings: string[] = [];
  const body = input.bodyMd.trim();
  const range = SECTIONS.find((section) => section.key === input.key);

  if (range === undefined) {
    failures.push({ rule: 'section_unknown', detail: input.key });
    return { failures, warnings };
  }

  // 1. Пустое тело и объём (±30 % — провал, 10–30 % — предупреждение).
  //
  // Объём считается **без дисклеймера**: нормализатор дописывает его сам, и в
  // живом прогоне 18.11.2026 «Итог» на 434 знака проходил как 515 — ровно
  // на длине фразы про саморефлексию. Дисклеймер — служебная подпись, а не
  // текст главы, поэтому он не должен закрывать недобор.
  const volume = body.endsWith(DISCLAIMER)
    ? body.slice(0, body.length - DISCLAIMER.length).trimEnd()
    : body;

  if (volume.length < 300) {
    failures.push({ rule: 'too_short', detail: `${volume.length} < 300` });
  } else if (volume.length > range.max * 1.3 || volume.length < range.min * 0.7) {
    failures.push({
      rule: 'length',
      detail: `${volume.length} вне ${range.min}–${range.max} более чем на 30 %`,
    });
  } else if (volume.length > range.max || volume.length < range.min) {
    warnings.push(`length_off: ${volume.length} вне ${range.min}–${range.max}`);
  }

  // «Итог» — исключение по допуску: 434 знака при минимуме 500 прошли как
  // `length_off` (13 % недобора < 30 %), и разбор ушёл человеку с огрызком
  // вместо трёх действий. Для `summary` минимум проверяется без допуска:
  // недобор → `summary_short` (ретрай), после ретрая — `warning`, а не отказ.
  if (input.key === 'summary' && volume.length < range.min) {
    failures.push({ rule: 'summary_short', detail: `${volume.length} < ${range.min}` });
  }

  // 2. Формат.
  if (FORMAT.h1.test(body)) failures.push({ rule: 'format_h1', detail: 'H1' });
  if (FORMAT.table.test(body)) failures.push({ rule: 'format_table', detail: 'таблица' });
  if (FORMAT.link.test(body)) failures.push({ rule: 'format_link', detail: 'ссылка' });
  if (FORMAT.html.test(body)) failures.push({ rule: 'format_html', detail: 'HTML' });
  if (FORMAT.listMarker.test(body)) {
    failures.push({ rule: 'format_list', detail: 'список не маркером «—»' });
  }

  // 3. Обращение: только «ты».
  if (SECOND_PERSON_PLURAL.test(body)) {
    failures.push({ rule: 'voice', detail: 'обращение на «вы»' });
  }

  // 4. Интерфейсные отсылки.
  if (UI_REFERENCE.test(body)) {
    failures.push({ rule: 'ui_reference', detail: 'отсылка к интерфейсу' });
  }

  // 5. Запрещённые темы — тот же список, что проверяется в `forbiddenTopicIn`.
  for (const topic of FORBIDDEN_TOPICS) {
    if (topic.pattern.test(body)) {
      failures.push({ rule: `forbidden_${topic.rule}`, detail: topic.pattern.source.slice(0, 40) });
    }
  }

  // 6. Хирон: его нет в карте fallback-режима.
  if (CHIRON.test(body)) {
    failures.push({ rule: 'chiron', detail: 'Хирон' });
  }

  // 7. Дома и углы при неизвестном времени — по конструкциям, без оговорок.
  if (input.timePrecision === 'unknown') {
    const sentences = splitSentences(body);
    const excluded = new Set(disclaimers(sentences));
    if (excluded.size > 1) {
      warnings.push('unknown_disclaimers: больше одной оговорки о неполноте');
    }

    sentences.forEach((sentence, index) => {
      if (excluded.has(index)) {
        return;
      }
      if (HOUSE_REF_HARD.test(sentence)) {
        failures.push({ rule: 'unknown_house', detail: sentence.slice(0, 80) });
      } else if (HOUSE_REF_SOFT.test(sentence)) {
        warnings.push(`unknown_house_soft: ${sentence.slice(0, 60)}`);
      }
    });
  }

  // 8. Повторы: пересечение по 8-граммам с любой предыдущей главой ≤ 12 %.
  const overlap = maxOverlap(body, input.previous ?? []);
  if (overlap > 0.12) {
    failures.push({ rule: 'repeats', detail: `${Math.round(overlap * 100)}% > 12%` });
  }

  // 9. Дисклеймер дословно — в «Итоге».
  if (input.key === 'summary' && !body.includes(DISCLAIMER)) {
    failures.push({ rule: 'disclaimer', detail: 'нет фразы дисклеймера' });
  }

  // 10. Абзацы (QA-22): 3–6 абзацев по пустой строке, 2–4 предложения в каждом.
  const paragraphs = splitParagraphs(body);
  if (paragraphs.length < PARAGRAPH_MIN || paragraphs.length > PARAGRAPH_MAX) {
    failures.push({
      rule: 'paragraphs',
      detail: `${paragraphs.length} вне ${PARAGRAPH_MIN}–${PARAGRAPH_MAX}`,
    });
  }
  paragraphs.forEach((paragraph, index) => {
    if (isListParagraph(paragraph)) {
      return;
    }
    const sentences = splitSentences(paragraph).length;
    if (sentences < SENTENCES_PER_PARAGRAPH_MIN || sentences > SENTENCES_PER_PARAGRAPH_MAX) {
      failures.push({
        rule: 'paragraph_sentences',
        detail: `абзац ${index + 1}: ${sentences} предл. вне ${SENTENCES_PER_PARAGRAPH_MIN}–${SENTENCES_PER_PARAGRAPH_MAX}`,
      });
    }
  });

  // 11. Частотность слова и дословный повтор внутри главы (QA-22).
  const limit = input.key === 'core' ? CORE_WORD_SHARE_LIMIT : WORD_SHARE_LIMIT;
  const top = topWordShare(body);
  if (top.share > limit) {
    failures.push({
      rule: 'word_share',
      detail: `«${top.word}» ${Math.round(top.share * 100)}% > ${Math.round(limit * 100)}%`,
    });
  }

  for (const sentence of repeatedSentences(body)) {
    failures.push({ rule: 'sentence_repeat', detail: sentence });
  }

  // 12. Служебный словарь разбора: внутренние термины не должны доходить до
  // человека. Warning: текст не правим, но фиксируем каждый случай.
  for (const service of SERVICE_TERMS) {
    if (service.pattern.test(body)) {
      failures.push({ rule: 'service_terms', detail: service.term });
    }
  }

  // 13. Зачины абзацев: калька «одно и то же начало» ловится не по 8-граммам,
  // а по первым пяти словам первого предложения абзаца.
  const openers = new Map<string, string>();
  for (const previousBody of input.previous ?? []) {
    for (const paragraph of splitParagraphs(previousBody)) {
      const opener = openerOf(paragraph);
      if (opener !== '') {
        openers.set(opener, 'previous');
      }
    }
  }
  for (const paragraph of paragraphs) {
    const opener = openerOf(paragraph);
    if (opener === '') {
      continue;
    }
    if (openers.has(opener)) {
      failures.push({ rule: 'repeated_opener', detail: `${opener}…` });
    } else {
      openers.set(opener, 'current');
    }
  }

  // 14. Астрологические термины — только в тизере и только у `core`.
  // Остальной текст главы их требует: это разбор карты, а не эзотерика.
  const teaser = input.teaser;
  if (input.key === 'core' && teaser !== undefined) {
    const matched = TEASER_TERMS.exec(teaser);
    if (matched !== null) {
      failures.push({
        rule: 'teaser_terms',
        detail: `«${matched[0]}» на ${matched.index}-м знаке тизера`,
      });
    }
  }

  return { failures, warnings };
}
