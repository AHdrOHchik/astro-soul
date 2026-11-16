import { describe, expect, it } from 'vitest';
import {
  FAILURE_CODES,
  codeOfRule,
  failureCodeOf,
  VALIDATION_FAILURE_CODES,
} from '../src/modules/reports/failure-codes';
import {
  breakerState,
  validationStreak,
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  type ReportHistoryRow,
} from '../src/modules/reports/breaker';

/**
 * Коды провала и circuit breaker (итерация 17, задача D).
 *
 * Прогон 16.11.2026 записал `error_code: "validation"` и `attempts: 5`:
 * по такой строке нельзя понять ни что сломалось, ни почему это повторилось
 * на следующем заказе.
 */
describe('failureCodeOf', () => {
  it('абзацы и предложения в абзаце — это `paragraphs`, а не общий `validation`', () => {
    expect(
      failureCodeOf({
        key: 'talents',
        bodyLength: 1_050,
        failures: [
          { rule: 'paragraphs', detail: '1 вне 3–6' },
          { rule: 'paragraph_sentences', detail: 'абзац 1: 7 предл. вне 2–4' },
        ],
      }),
    ).toBe('paragraphs');
  });

  it('запрещённая тема важнее структуры: её нельзя показать человеку', () => {
    expect(
      failureCodeOf({
        key: 'emotions',
        bodyLength: 1_100,
        failures: [
          { rule: 'paragraphs', detail: '2 вне 3–6' },
          { rule: 'forbidden_health', detail: 'диагноз' },
        ],
      }),
    ).toBe('forbidden_terms');
  });

  it('перебор и недобор длины различаются по длине тела', () => {
    const tooLong = failureCodeOf({
      key: 'talents',
      bodyLength: 2_000,
      failures: [{ rule: 'length', detail: '2000 вне 950–1200 более чем на 30 %' }],
    });
    const tooShort = failureCodeOf({
      key: 'talents',
      bodyLength: 400,
      failures: [{ rule: 'too_short', detail: '400 < 300' }],
    });

    expect(tooLong).toBe('too_long');
    expect(tooShort).toBe('too_short');
  });

  it('формат, повторы и доля слова получают свои коды', () => {
    expect(codeOfRule('format_h1')).toBe('format');
    expect(codeOfRule('voice')).toBe('format');
    expect(codeOfRule('repeats')).toBe('repeats');
    expect(codeOfRule('sentence_repeat')).toBe('repeats');
    expect(codeOfRule('word_share')).toBe('repeats');
    expect(codeOfRule('forbidden_esoterics')).toBe('forbidden_terms');
  });

  it('набор кодов — ровно шесть классов из задания', () => {
    expect([...FAILURE_CODES]).toEqual([
      'too_short',
      'too_long',
      'format',
      'forbidden_terms',
      'paragraphs',
      'repeats',
    ]);
    // Старый общий код остаётся в «семействе»: такие строки уже лежат в БД.
    expect(VALIDATION_FAILURE_CODES).toContain('validation');
  });
});

describe('validationStreak', () => {
  const row = (error_code: string | null, minutesAgo: number): ReportHistoryRow => ({
    error_code,
    updated_at: new Date(Date.UTC(2026, 10, 16, 12, 0, 0) - minutesAgo * 60_000),
  });

  it('считает ведущие провалы валидации и останавливается на успешном разборе', () => {
    const series = validationStreak([row('paragraphs', 1), row('validation', 2), row(null, 3), row('paragraphs', 4)]);

    expect(series.streak).toBe(2);
    expect(series.lastFailedAt?.toISOString()).toBe('2026-11-16T11:59:00.000Z');
  });

  it('провал провайдера серию не продолжает: это не валидация', () => {
    expect(validationStreak([row('provider', 1), row('paragraphs', 2)]).streak).toBe(0);
  });
});

describe('breakerState', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');

  it('до третьего провала закрыт', () => {
    expect(breakerState(BREAKER_THRESHOLD - 1, new Date(now.getTime() - 1_000), now).open).toBe(false);
  });

  it('после трёх подряд открыт и называет время до закрытия', () => {
    const state = breakerState(BREAKER_THRESHOLD, new Date(now.getTime() - 60_000), now);

    expect(state.open).toBe(true);
    expect(state.retry_after_ms).toBe(BREAKER_COOLDOWN_MS - 60_000);
  });

  it('закрывается сам, когда серия старше окна: ручного сброса нет', () => {
    const state = breakerState(
      BREAKER_THRESHOLD + 2,
      new Date(now.getTime() - BREAKER_COOLDOWN_MS - 1),
      now,
    );

    expect(state.open).toBe(false);
    expect(state.retry_after_ms).toBeNull();
  });
});
