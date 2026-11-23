import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  endOfDayUtc,
  formatAgo,
  formatBool,
  formatDateTime,
  formatHours,
  formatInt,
  formatRatio,
  formatRub,
  formatStars,
  formatUsage,
  plural,
} from './format';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

/**
 * Пробел-разделитель локали — неразрывный (обычно узкий). В тесте сравниваем
 * «как прочтёт человек», поэтому NBSP и узкий NBSP сворачиваем в обычный пробел:
 * иначе проверка зависит от того, какой именно пробел выбрал ICU.
 */
const flat = (value: string): string => value.replaceAll('\u00a0', ' ').replaceAll('\u202f', ' ');

describe('format', () => {
  it('не превращает отсутствие данных в ноль', () => {
    expect(formatInt(undefined)).toBe(EMPTY);
    expect(formatInt(null)).toBe(EMPTY);
    expect(formatRub(undefined)).toBe(EMPTY);
    expect(formatStars(null)).toBe(EMPTY);
    expect(formatBool(undefined)).toBe(EMPTY);
    expect(formatDateTime(null)).toBe(EMPTY);
    expect(formatDateTime('')).toBe(EMPTY);
  });

  it('неисправную дату показывает как есть, а не пустой строкой', () => {
    expect(formatDateTime('не дата')).toBe('не дата');
    expect(formatAgo('не дата', NOW)).toBe('не дата');
  });

  it('числа — по локали ru', () => {
    expect(flat(formatInt(1490))).toBe('1 490');
    expect(flat(formatStars(1490))).toBe('1 490 ⭐');
    expect(flat(formatRub(1240))).toBe('1 240 ₽');
    // Мелкие суммы сохраняют копейки: 0 ₽ и 0,4 ₽ — это разные новости про бюджет.
    expect(flat(formatRub(0.4))).toBe('0,4 ₽');
    expect(flat(formatRub(-12.5))).toBe('-12,5 ₽');
  });

  it('доля с сервера (0…1) читается как процент, а не как «0,124 %»', () => {
    expect(formatRatio(0.124)).toBe('12,4 %');
    expect(formatRatio(0)).toBe('0 %');
    expect(formatRatio(1)).toBe('100 %');
  });

  it('счётчик активаций говорит «сколько из скольки»', () => {
    expect(flat(formatUsage(3, 10))).toBe('3 из 10');
    expect(flat(formatUsage(5, 5))).toBe('5 из 5');
    expect(formatUsage(undefined, 5)).toBe(EMPTY);
  });

  it('плюрализация по-русски', () => {
    expect(plural(1, ['час', 'часа', 'часов'])).toBe('час');
    expect(plural(2, ['час', 'часа', 'часов'])).toBe('часа');
    expect(plural(5, ['час', 'часа', 'часов'])).toBe('часов');
    expect(plural(11, ['час', 'часа', 'часов'])).toBe('часов');
    expect(plural(21, ['час', 'часа', 'часов'])).toBe('час');
  });

  it('длительность и «сколько назад»', () => {
    expect(flat(formatHours(26))).toBe('26 часов');
    expect(formatHours(2)).toBe('2 часа');
    expect(formatHours(1)).toBe('1 час');
    expect(flat(formatAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW))).toBe('5 минут назад');
    expect(formatAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 часа назад');
  });

  it('будущее время не превращается в «-2 часа назад»', () => {
    expect(formatAgo(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(EMPTY);
  });

  it('момент отдаётся в формате дд.мм.гггг, чч:мм', () => {
    expect(flat(formatDateTime(new Date(NOW).toISOString()))).toMatch(/20\.11\.2026, 12:00/);
  });

  it('дата из поля ввода превращается в конец дня по UTC', () => {
    expect(endOfDayUtc('2026-11-30')).toBe('2026-11-30T23:59:59.000Z');
    expect(endOfDayUtc('30.11.2026')).toBeNull();
    expect(endOfDayUtc('')).toBeNull();
  });
});
