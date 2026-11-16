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
 * Насколько нарушение серьёзно (итерация 18).
 *
 * `error` — текст нельзя показывать: пустой ответ/недобор материала,
 * запрещённая тема (диагноз, смерть, гарантии дохода, «карма»), Хирон, дома
 * при неизвестном времени рождения, разметка, которую фронт не отрендерит
 * (H1, таблица, ссылка, HTML), и «Итог» без дисклеймера. Здесь честнее
 * перегенерировать главу, а если не вышло — убрать её.
 *
 * `warning` — нарушение **формы и стиля**: абзацы, перебор объёма, повторы,
 * «вы» вместо «ты», отсылки к интерфейсу. Это правится нормализатором или
 * переживается человеком: оплаченный разбор не должен пропадать из-за
 * лишнего предложения в абзаце.
 */
export type FailureSeverity = 'error' | 'warning';

const WARNING_RULES = new Set([
  'paragraphs',
  'paragraph_sentences',
  'repeats',
  'sentence_repeat',
  'word_share',
  // Стиль: «вы», отсылки к кнопкам. Текст понятен — значит, показываем.
  'voice',
  'ui_reference',
]);

/** Правило валидатора → серьёзность. Неизвестное правило считаем ошибкой. */
export function severityOfRule(rule: string): FailureSeverity {
  if (WARNING_RULES.has(rule)) {
    return 'warning';
  }
  // `length` в обе стороны: перебор — форма, недобор — ошибка (см. ниже).
  if (rule === 'length') {
    return 'warning';
  }
  return 'error';
}

/**
 * Коды, которые имеет смысл лечить перегенерацией.
 *
 * `too_short` — глава недобрала материала; `format` — ответ не разобрался;
 * `forbidden_terms` — тема, которую нельзя показывать (постобработкой не
 * лечится, только другим текстом). Всё остальное — форма: её правит
 * `normalize.ts`, и вторая попытка дала бы тот же текст за те же деньги.
 */
export const RETRY_CODES: readonly FailureCode[] = ['too_short', 'format', 'forbidden_terms'];

export function isRetryable(code: FailureCode): boolean {
  return RETRY_CODES.includes(code);
}

export interface ClassifiedFailure {
  readonly rule: string;
  readonly detail: string;
  readonly code: FailureCode;
}

export interface ClassifiedFailures {
  readonly errors: readonly ClassifiedFailure[];
  readonly warnings: readonly ClassifiedFailure[];
}

/**
 * Делит нарушения валидатора на «нельзя показывать» и «покажем с пометкой».
 *
 * `length` валидатор отдаёт в обе стороны, поэтому направление уточняется
 * длиной тела: перебор — предупреждение, недобор — ошибка.
 */
export function classifyFailures(input: FailureInput): ClassifiedFailures {
  const range = SECTIONS.find((section) => section.key === input.key);
  const errors: ClassifiedFailure[] = [];
  const warnings: ClassifiedFailure[] = [];

  for (const failure of input.failures) {
    const code =
      failure.rule === 'length'
        ? range === undefined || input.bodyLength > range.max
          ? 'too_long'
          : 'too_short'
        : codeOfRule(failure.rule);
    const entry: ClassifiedFailure = { rule: failure.rule, detail: failure.detail, code };
    if (code === 'too_short' && failure.rule === 'length') {
      errors.push(entry);
    } else if (severityOfRule(failure.rule) === 'error') {
      errors.push(entry);
    } else {
      warnings.push(entry);
    }
  }

  return { errors, warnings };
}

/**
 * Коды, по которым circuit breaker считает «провал валидации».
 *
 * `validation` оставлен намеренно: строки, записанные до этой правки (в том
 * числе прогон 16.11.2026), лежат в БД именно с этим кодом, и брейкер обязан
 * их видеть.
 */
export const VALIDATION_FAILURE_CODES: readonly string[] = [...FAILURE_CODES, 'validation'];
