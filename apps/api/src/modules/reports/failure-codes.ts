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
  'teaser_terms',
  'service_terms',
  'repeated_opener',
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
  'service_terms',
  'repeated_opener',
  'teaser_terms',
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
  if (rule === 'summary_short') {
    return 'too_short';
  }
  if (rule.startsWith('forbidden_')) {
    return 'forbidden_terms';
  }
  if (rule === 'teaser_terms') {
    return 'teaser_terms';
  }
  if (rule === 'service_terms') {
    return 'service_terms';
  }
  if (rule === 'repeated_opener') {
    return 'repeated_opener';
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
 * Насколько нарушение серьёзно (итерация 18, пересмотрено в 19).
 *
 * Правило владельца после трёх живых прогонов: **разбор обязан собраться**,
 * поэтому приговор главе выносят только два случая:
 *
 *   • `too_short` — пустой или почти пустой ответ модели (< 300 знаков),
 *     показывать нечего;
 *   • `section_unknown` — глава, которую конвейер не знает (нераспарсенная
 *     глава: её нет в структуре).
 *
 * Всё остальное — `warning`: текст отдаётся человеку, а нарушение остаётся
 * в `reports.validation` и в `normalization`, чтобы его видели QA и метрики.
 * Живой прогон 18.11.2026 потерял `emotions` (1 064 знака, идеальная форма)
 * из-за `forbidden_terms` — а слово «Луна» в главе про Луну обязательно.
 *
 * Отдельно: `forbidden_*` (§5.4 — здоровье, смерть, дети, гарантии дохода,
 * эзотерика) теперь тоже `warning`. Это осознанное решение владельца:
 * глава не должна пропадать из-за одного слова. Если понадобится вернуть
 * запрет — это одна строка в `SEVERITY_ERROR_RULES`.
 */
export type FailureSeverity = 'error' | 'warning';

/** Правила, которые не дают показать главу. Всё остальное — предупреждение. */
const SEVERITY_ERROR_RULES = new Set(['too_short', 'section_unknown']);

/** Правило валидатора → серьёзность. Неизвестное правило — предупреждение. */
export function severityOfRule(rule: string): FailureSeverity {
  // `length` — это недобор/перебор по объёму: недобор показываем с пометкой,
  // перебор обрезает нормализатор. Ни то, ни другое не повод убрать главу.
  if (rule === 'length') {
    return 'warning';
  }
  return SEVERITY_ERROR_RULES.has(rule) ? 'error' : 'warning';
}

/**
 * Коды, которые имеет смысл лечить перегенерацией.
 *
 * `too_short` — глава недобрала материала: второй заход с тем же промптом
 * («Объём 500–750 знаков») иногда добирает; `format` — ответ не разобрался
 * вовсе. Всё остальное — форма или стиль: их либо правит `normalize.ts`,
 * либо они не стоят ещё 0,85 ₽ за тот же текст.
 */
export const RETRY_CODES: readonly FailureCode[] = ['too_short', 'format'];

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
 * Решает только `severityOfRule`; `length` валидатор отдаёт в обе стороны,
 * поэтому код уточняется длиной тела (перебор — `too_long`, недобор —
 * `too_short`), но серьёзность у обоих одна: показываем с пометкой, перебор
 * к тому же обрезает нормализатор.
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
    if (severityOfRule(failure.rule) === 'error') {
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
