import { describe, expect, it } from 'vitest';
import { countryName, formatCount, formatDate, formatPosition, formatRegion, pluralForm } from './format';

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
