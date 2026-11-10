import { describe, expect, it } from 'vitest';
import type { GeoPlace } from '../api';
import {
  checkBirthDate,
  checkBirthTime,
  EMPTY_DRAFT,
  firstOpenStep,
  isTimeStepDone,
  toChartRequest,
  type BirthDraft,
} from './birth';

/** Local noon keeps the calendar day stable in any time zone the tests run in. */
const TODAY = new Date(2026, 10, 10, 12);
const date = (day: string, month: string, year: string) => checkBirthDate({ day, month, year }, TODAY);

describe('checkBirthDate', () => {
  it('accepts an adult and returns the ISO date', () => {
    expect(date('17', '05', '1994')).toEqual({ ok: true, iso: '1994-05-17' });
  });

  it('accepts single digits that have not been padded yet', () => {
    expect(date('7', '5', '1994')).toEqual({ ok: true, iso: '1994-05-07' });
  });

  it.each([
    ['', '', ''],
    ['17', '', '1994'],
    ['17', '05', '199'],
    ['17', '05', ''],
  ])('reports %s.%s.%s as incomplete', (day, month, year) => {
    expect(date(day, month, year)).toEqual({ ok: false, issue: 'incomplete' });
  });

  it.each([
    ['31', '02', '1994'],
    ['29', '02', '1993'],
    ['31', '04', '1990'],
    ['00', '05', '1994'],
    ['17', '13', '1994'],
    ['17', '00', '1994'],
  ])('rejects %s.%s.%s, which is not on the calendar', (day, month, year) => {
    expect(date(day, month, year)).toEqual({ ok: false, issue: 'invalid' });
  });

  it('accepts 29 February of a leap year', () => {
    expect(date('29', '02', '1992')).toEqual({ ok: true, iso: '1992-02-29' });
  });

  it('draws the 18+ line at the birthday itself', () => {
    expect(date('10', '11', '2008')).toEqual({ ok: true, iso: '2008-11-10' });
    expect(date('11', '11', '2008')).toEqual({ ok: false, issue: 'underage' });
    expect(date('09', '11', '2008')).toMatchObject({ ok: true });
  });

  it('counts a 29 February birthday from 1 March in a common year', () => {
    const born = { day: '29', month: '02', year: '2008' };
    expect(checkBirthDate(born, new Date(2026, 1, 28, 12))).toEqual({ ok: false, issue: 'underage' });
    expect(checkBirthDate(born, new Date(2026, 2, 1, 12))).toMatchObject({ ok: true });
  });

  it('tells a future date from an underage one', () => {
    expect(date('11', '11', '2026')).toEqual({ ok: false, issue: 'future' });
    expect(date('01', '01', '2030')).toEqual({ ok: false, issue: 'future' });
    expect(date('10', '11', '2026')).toEqual({ ok: false, issue: 'underage' });
  });

  it('treats years before 1900 as a typo', () => {
    expect(date('17', '05', '1899')).toEqual({ ok: false, issue: 'too_old' });
    expect(date('17', '05', '0994')).toEqual({ ok: false, issue: 'too_old' });
    expect(date('01', '01', '1900')).toMatchObject({ ok: true });
  });
});

describe('checkBirthTime', () => {
  it.each([
    ['14', '30', '14:30'],
    ['0', '0', '00:00'],
    ['7', '5', '07:05'],
    ['23', '59', '23:59'],
  ])('formats %s:%s as %s', (hours, minutes, value) => {
    expect(checkBirthTime({ hours, minutes })).toEqual({ ok: true, value });
  });

  it.each([
    ['24', '00'],
    ['12', '60'],
  ])('rejects %s:%s', (hours, minutes) => {
    expect(checkBirthTime({ hours, minutes })).toEqual({ ok: false, issue: 'invalid' });
  });

  it('reports missing parts as incomplete', () => {
    expect(checkBirthTime({ hours: '14', minutes: '' })).toEqual({ ok: false, issue: 'incomplete' });
  });
});

describe('toChartRequest', () => {
  const place: GeoPlace = { name: 'Казань', region: 'Татарстан', country: 'RU', lat: 55.79, lon: 49.12, tz: 'Europe/Moscow' };
  const draft: BirthDraft = {
    consentVersion: '2026-11-10',
    date: { day: '17', month: '05', year: '1994' },
    timePrecision: 'exact',
    time: { hours: '14', minutes: '30' },
    placeQuery: 'Казань',
    place,
  };

  it('builds the contract body and passes the place through unchanged', () => {
    const request = toChartRequest(draft, TODAY);
    expect(request).toEqual({
      birth_date: '1994-05-17',
      birth_time: '14:30',
      time_precision: 'exact',
      birth_place: place,
      consent: { accepted: true, version: '2026-11-10' },
    });
    expect(request?.birth_place).toBe(place);
  });

  it('sends an approximate time with its own precision', () => {
    expect(toChartRequest({ ...draft, timePrecision: 'approximate' }, TODAY)).toMatchObject({
      birth_time: '14:30',
      time_precision: 'approximate',
    });
  });

  it('sends null for an unknown time, even if digits were typed before', () => {
    expect(toChartRequest({ ...draft, timePrecision: 'unknown' }, TODAY)).toMatchObject({
      birth_time: null,
      time_precision: 'unknown',
    });
  });

  it('sends the version of the text the user agreed to, not a constant of its own', () => {
    expect(toChartRequest({ ...draft, consentVersion: '2027-01-15' }, TODAY)?.consent).toEqual({ accepted: true, version: '2027-01-15' });
  });

  it.each<[string, Partial<BirthDraft>]>([
    ['no consent', { consentVersion: null }],
    ['no place', { place: null }],
    ['no time option', { timePrecision: null }],
    ['an unfinished time', { time: { hours: '14', minutes: '' } }],
    ['an underage date', { date: { day: '17', month: '05', year: '2015' } }],
  ])('returns null with %s', (_name, patch) => {
    expect(toChartRequest({ ...draft, ...patch }, TODAY)).toBeNull();
  });

  it('returns null for the draft the app starts with: nothing is filled in and nobody has consented', () => {
    expect(EMPTY_DRAFT.consentVersion).toBeNull();
    expect(toChartRequest(EMPTY_DRAFT, TODAY)).toBeNull();
  });
});

describe('isTimeStepDone', () => {
  it('needs an option, and a valid time unless it is unknown', () => {
    expect(isTimeStepDone({ timePrecision: null, time: { hours: '14', minutes: '30' } })).toBe(false);
    expect(isTimeStepDone({ timePrecision: 'unknown', time: { hours: '', minutes: '' } })).toBe(true);
    expect(isTimeStepDone({ timePrecision: 'approximate', time: { hours: '14', minutes: '' } })).toBe(false);
    expect(isTimeStepDone({ timePrecision: 'exact', time: { hours: '14', minutes: '30' } })).toBe(true);
  });
});

describe('firstOpenStep', () => {
  const done: BirthDraft = {
    consentVersion: '2026-11-10',
    date: { day: '17', month: '05', year: '1994' },
    timePrecision: 'unknown',
    time: { hours: '', minutes: '' },
    placeQuery: '',
    place: { name: 'Казань', country: 'RU', lat: 55.79, lon: 49.12, tz: 'Europe/Moscow' },
  };

  it('walks the steps in order and ends with null', () => {
    expect(firstOpenStep(EMPTY_DRAFT, TODAY)).toBe('birthDate');
    expect(firstOpenStep({ ...EMPTY_DRAFT, date: done.date }, TODAY)).toBe('birthTime');
    expect(firstOpenStep({ ...done, place: null }, TODAY)).toBe('birthPlace');
    expect(firstOpenStep(done, TODAY)).toBeNull();
  });
});
