import { describe, expect, it } from 'vitest';
import { countryName, formatCount, formatDate, formatDay, formatDayMonth, formatDayMonthOf, formatPosition, formatRegion, pluralForm } from './format';

describe('formatDate', () => {
  it('prints an ISO date in Russian without shifting the day', () => {
    expect(formatDate('1994-05-17')).toBe('17 мая 1994 г.');
    expect(formatDate('2000-01-01')).toBe('1 января 2000 г.');
    expect(formatDate('1992-12-31')).toBe('31 декабря 1992 г.');
  });

  it('returns anything else as is', () => {
    expect(formatDate('17.05.1994')).toBe('17.05.1994');
  });
});

describe('formatDayMonthOf', () => {
  it('prints the day a moment falls on without its year', () => {
    expect(formatDayMonthOf('2026-12-12T12:00:00Z')).toBe('12 декабря');
    expect(formatDayMonthOf('2026-01-01T09:00:00Z')).toBe('1 января');
  });

  it('keeps the year of the longer form, so a term that ends far away is never read as this year', () => {
    expect(formatDay('2027-01-11T12:00:00Z')).toContain('2027');
  });

  it('returns nothing for a value that is not a moment', () => {
    expect(formatDayMonthOf('')).toBe('');
    expect(formatDayMonthOf('not a moment')).toBe('');
  });
});

describe('formatPosition', () => {
  it('pads minutes and tolerates missing parts', () => {
    expect(formatPosition('Телец', 26, 7)).toBe('Телец, 26°07′');
    expect(formatPosition('Телец', 0, 0)).toBe('Телец, 0°00′');
    expect(formatPosition('Телец', 26)).toBe('Телец, 26°');
    expect(formatPosition('Телец')).toBe('Телец');
  });
});

describe('countryName', () => {
  it('resolves ISO codes and keeps what it cannot resolve', () => {
    expect(countryName('RU')).toBe('Россия');
    expect(countryName('kz')).toBe('Казахстан');
    expect(countryName('Россия')).toBe('Россия');
    expect(countryName('')).toBe('');
  });
});

describe('formatRegion', () => {
  it('joins region and country, skipping an empty region', () => {
    expect(formatRegion({ region: 'Татарстан', country: 'RU' })).toBe('Татарстан, Россия');
    expect(formatRegion({ region: null, country: 'RU' })).toBe('Россия');
    expect(formatRegion({ country: 'RU' })).toBe('Россия');
  });
});

describe('formatCount', () => {
  it('groups digits with a non-breaking space, so a price never wraps in the middle', () => {
    expect(formatCount(149)).toBe('149');
    expect(formatCount(2990)).toBe('2\u00a0990');
  });
});

describe('pluralForm', () => {
  it('picks the form of a counted noun', () => {
    expect([1, 21, 101].map(pluralForm)).toEqual(['one', 'one', 'one']);
    expect([2, 4, 23].map(pluralForm)).toEqual(['few', 'few', 'few']);
    expect([0, 5, 11, 14, 149, 399, 2990].map(pluralForm)).toEqual(['many', 'many', 'many', 'many', 'many', 'many', 'many']);
    expect(pluralForm(1.5)).toBe('other');
  });
});

describe('formatDayMonth', () => {
  it('prints the day and the month of an ISO date, without the year and without shifting the day', () => {
    expect(formatDayMonth('2026-11-14')).toBe('14 ноября');
    expect(formatDayMonth('2026-01-01')).toBe('1 января');
    expect(formatDayMonth('2026-12-31')).toBe('31 декабря');
  });

  it('returns anything else as is', () => {
    expect(formatDayMonth('14.11.2026')).toBe('14.11.2026');
    expect(formatDayMonth('')).toBe('');
  });
});
