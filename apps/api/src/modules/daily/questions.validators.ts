import { endsProperly, joinSections, trimToSentences, type SectionMeta } from '../../common/sections';
import { FORECAST_DISCLAIMER } from './daily-forecast.validators';

/**
 * Три раздела ответа на вопрос: `answer`, `why`, `do`.
 *
 * Имена — не украшение: «почему» без «что делать» превращает ответ в гороскоп,
 * а «что делать» без «почему» — в совет из воздуха. Объёмы заданы так, чтобы
 * ответ читался за минуту в Telegram.
 */
export const QUESTION_SECTIONS: readonly SectionMeta[] = [
  { key: 'answer', title: 'Ответ', min: 150, max: 300 },
  { key: 'why', title: 'Почему', min: 250, max: 400 },
  { key: 'do', title: 'Что сделать', min: 150, max: 250 },
];

export const QUESTION_TOTAL_MIN = 550;
export const QUESTION_TOTAL_MAX = 950;

export const QUESTION_DISCLAIMER = FORECAST_DISCLAIMER;

export type QuestionWarning = 'length_off' | 'ungrounded';

export interface QuestionSectionView {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface QuestionText {
  readonly sections: readonly QuestionSectionView[];
  readonly chars: number;
  readonly warnings: readonly QuestionWarning[];
  readonly bodyMd: string;
}

/**
 * Запрещённое содержание в ответе на вопрос.
 *
 * Тема вопроса уже отфильтрована до модели, поэтому здесь ловим то, что модель
 * добавила сама: обещания событий, даты, диагнозы, проценты. Совпадает по
 * смыслу с прогнозом дня, но списки разные — ответ на вопрос конкретнее и
 * легче скатывается в «советы специалиста».
 */
const FORBIDDEN: readonly { code: string; pattern: RegExp }[] = [
  {
    code: 'promise_event',
    pattern:
      /тебе напиш[еу]т|тебя жд[её]т|вас жд[её]т|деньги придут|придут деньги|обязательно случится|сбудется|гарантирую/i,
  },
  {
    code: 'future_date',
    pattern:
      /\b\d{1,2}\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*|\bчерез\s+\d+\s+(дн|недел|месяц)/iu,
  },
  {
    code: 'medical_legal',
    pattern:
      /диагноз|лечени|лекарств|таблетк|дозировк|анализ[ыа]|врач|юрист|адвокат|иск в суд|нотариус|налогов\w* вычет/iu,
  },
  {
    code: 'death_illness',
    pattern: /смерт|умр[её]|похорон|кончин|рак\b|онкологи|инсульт|инфаркт/iu,
  },
  {
    code: 'percent',
    pattern: /\d+\s?%|процент/i,
  },
];

export function forbiddenOfQuestion(text: string): string | null {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) {
      return rule.code;
    }
  }
  return null;
}

/** Разбор ответа модели: `{answer, why, do}` или `null`. */
export function parseQuestionAnswer(raw: string): Record<string, string> | null {
  const body = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1');

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const section of QUESTION_SECTIONS) {
      const value = record[section.key];
      if (typeof value === 'string' && value.trim() !== '') {
        result[section.key] = value.trim();
      }
    }

    return Object.keys(result).length === QUESTION_SECTIONS.length ? result : null;
  } catch {
    return null;
  }
}

/**
 * Проверка опоры на карту.
 *
 * Факты передаются модели всегда, и «опора» — это любое упоминание планеты,
 * знака или угла из переданного списка. Строгая проверка («модель обязана
 * процитировать аспект») ломалась бы на живом языке; мягкая ловит главное —
 * ответ, в котором нет ничего из карты и который можно было написать кому
 * угодно. Такой ответ не выбрасываем: он полезен, но помечается `ungrounded`.
 */
export function isGrounded(text: string, labels: readonly string[]): boolean {
  const haystack = text.toLowerCase();

  for (const label of labels) {
    const words = label
      .toLowerCase()
      .replace(/[,.]/gu, ' ')
      .split(/\s+/u)
      .filter((word) => word.length >= 4);

    if (words.some((word) => haystack.includes(word.slice(0, 5)))) {
      return true;
    }
  }

  return false;
}

export interface FinalizeQuestionInput {
  readonly parsed: Record<string, string>;
  readonly labels: readonly string[];
}

/** Обрезка по границам предложений и предупреждения. `null` — показывать нельзя. */
export function finalizeQuestion(input: FinalizeQuestionInput): QuestionText | null {
  const sections: QuestionSectionView[] = [];
  const warnings = new Set<QuestionWarning>();

  for (const meta of QUESTION_SECTIONS) {
    const raw = input.parsed[meta.key];
    if (raw === undefined || forbiddenOfQuestion(raw) !== null) {
      return null;
    }

    const trimmed = trimToSentences(raw, meta.max, meta.min);
    if (trimmed.text === '' || !endsProperly(trimmed.text)) {
      return null;
    }
    if (trimmed.trimmed || trimmed.off) {
      warnings.add('length_off');
    }

    sections.push({ key: meta.key, title: meta.title, body: trimmed.text });
  }

  const chars = sections.reduce((sum, section) => sum + section.body.length, 0);
  if (chars < QUESTION_TOTAL_MIN || chars > QUESTION_TOTAL_MAX) {
    warnings.add('length_off');
  }

  const grounded = isGrounded(
    sections.map((section) => section.body).join(' '),
    input.labels,
  );
  if (!grounded) {
    warnings.add('ungrounded');
  }

  return { sections, chars, warnings: [...warnings], bodyMd: joinSections(sections) };
}

/** Разделы из сохранённого markdown — для чтения `GET /questions/{id}`. */
export function questionFromBody(bodyMd: string): {
  sections: QuestionSectionView[];
  chars: number;
} {
  const parts: QuestionSectionView[] = [];

  for (const meta of QUESTION_SECTIONS) {
    const pattern = new RegExp(`^##\\s+${escapeRe(meta.title)}\\s*$`, 'mu');
    const match = pattern.exec(bodyMd);
    if (match === null) {
      continue;
    }
    const rest = bodyMd.slice(match.index + match[0].length);
    const next = /^##\s+/mu.exec(rest);
    const body = (next === null ? rest : rest.slice(0, next.index)).trim();
    parts.push({ key: meta.key, title: meta.title, body });
  }

  return { sections: parts, chars: parts.reduce((sum, section) => sum + section.body.length, 0) };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
