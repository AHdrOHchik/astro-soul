import { SECTIONS, type SectionKey } from './validators';

/**
 * Коды провала валидации — вместо одного `error_code: "validation"`.
 *
 * Почему: живой прогон 16.11.2026 записал `error_code: "validation"` и пять
 * неудачных попыток, по которым нельзя было понять, что именно сломалось.
 * Правило валидатора (`paragraphs`, `paragraph_sentences`, `word_share`…)
 * видно в `reports.validation`, но код ошибки обязан называть класс проблемы:
 * по нему ищут причину, по нему же решает circuit breaker.
 *
 * Сами валидаторы не меняются — здесь только перевод правила в код.
 */
export const FAILURE_CODES = [
  'too_short',
  'too_long',
  'format',
  'forbidden_terms',
  'paragraphs',
  'repeats',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Приоритет при нескольких провалах в одной главе: сначала то, что нельзя
 * показать человеку (запрещённые темы), потом структурный провал, потом
 * объём и формат. Порядок фиксирован, иначе код ошибки зависел бы от порядка
 * проверок внутри валидатора.
 */
const PRIORITY: readonly FailureCode[] = [
  'forbidden_terms',
  'paragraphs',
  'repeats',
  'too_short',
  'too_long',
  'format',
];

/** Правило валидатора → класс провала. */
export function codeOfRule(rule: string): FailureCode {
  if (rule === 'too_short') {
    return 'too_short';
  }
  // `length` валидатор отдаёт в обе стороны; направление уточняет длина тела.
  if (rule === 'length') {
    return 'too_long';
  }
  if (rule === 'paragraphs' || rule === 'paragraph_sentences') {
    return 'paragraphs';
  }
  if (rule === 'repeats' || rule === 'sentence_repeat' || rule === 'word_share') {
    return 'repeats';
  }
  if (rule.startsWith('forbidden_')) {
    return 'forbidden_terms';
  }
  return 'format';
}

export interface FailureInput {
  readonly key: SectionKey;
  readonly bodyLength: number;
  readonly failures: readonly { readonly rule: string; readonly detail: string }[];
}

/**
 * Код провала главы. `length` уточняется по длине тела: перебор — `too_long`,
 * недобор — `too_short` (валидатор отдаёт их одним правилом).
 */
export function failureCodeOf(input: FailureInput): FailureCode {
  if (input.failures.length === 0) {
    return 'format';
  }

  const range = SECTIONS.find((section) => section.key === input.key);
  const codes = input.failures.map((failure) => {
    if (failure.rule !== 'length') {
      return codeOfRule(failure.rule);
    }
    return range === undefined || input.bodyLength > range.max ? 'too_long' : 'too_short';
  });

  return PRIORITY.find((code) => codes.includes(code)) ?? 'format';
}

/**
 * Коды, по которым circuit breaker считает «провал валидации».
 *
 * `validation` оставлен намеренно: строки, записанные до этой правки (в том
 * числе прогон 16.11.2026), лежат в БД именно с этим кодом, и брейкер обязан
 * их видеть.
 */
export const VALIDATION_FAILURE_CODES: readonly string[] = [...FAILURE_CODES, 'validation'];
