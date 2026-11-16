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
}

export interface CompatValidationResult {
  readonly failures: readonly { readonly rule: string; readonly detail: string }[];
  readonly warnings: readonly CompatWarning[];
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
    return { failures: [{ rule: 'section_unknown', detail: input.key }], warnings: [] };
  }

  const volume = volumeOf(input.key, body);
  const chars = volume.length;

  if (chars < 300) {
    failures.push({ rule: 'too_short', detail: `${chars} < 300` });
  } else if (chars > range.max * 1.3 || chars < range.min * 0.7) {
    failures.push({ rule: 'length', detail: `${chars} вне ${range.min}–${range.max} более чем на 30 %` });
  } else if (chars > range.max || chars < range.min) {
    warnings.push({ code: 'length_off', detail: `${chars} вне ${range.min}–${range.max}` });
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

  return { failures, warnings };
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
    applied.push('trimmed');
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
