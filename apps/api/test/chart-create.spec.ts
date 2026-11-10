import { describe, expect, it } from 'vitest';
import { adultAt, parseChartCreate } from '../src/modules/charts/charts.dto';
import { ApiError } from '../src/common/api-error';

/** Границы возраста и версии согласия — чистые правила, без БД. */

const BASE = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

function fieldErrors(body: unknown, now: Date, consentVersion = '2026-11-10'): string[] {
  try {
    parseChartCreate(body, now, consentVersion);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    const errors = apiError.details?.['field_errors'] as { field: string }[];
    return errors.map((item) => item.field);
  }
  throw new Error('ожидали 422, но проверка прошла');
}

describe('adultAt', () => {
  it('18 лет наступает в 00:00 UTC дня рождения', () => {
    expect(adultAt(new Date('2008-11-10T00:00:00Z')).toISOString()).toBe(
      '2026-11-10T00:00:00.000Z',
    );
  });

  it('рождённые 29 февраля становятся совершеннолетними 1 марта', () => {
    expect(adultAt(new Date('2008-02-29T00:00:00Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });
});

describe('parseChartCreate: возраст', () => {
  it('принимает ровно в 00:00 UTC дня 18-летия', () => {
    const parsed = parseChartCreate(
      { ...BASE, birth_date: '2008-11-10' },
      new Date('2026-11-10T00:00:00Z'),
    );
    expect(parsed.birth_date).toBe('2008-11-10');
  });

  it('отклоняет за секунду до 18-летия', () => {
    expect(
      fieldErrors({ ...BASE, birth_date: '2008-11-10' }, new Date('2026-11-09T23:59:59Z')),
    ).toEqual(['birth_date']);
  });

  it('29 февраля в невисокосный год — ещё несовершеннолетний 28 февраля', () => {
    expect(
      fieldErrors({ ...BASE, birth_date: '2008-02-29' }, new Date('2026-02-28T23:59:59Z')),
    ).toEqual(['birth_date']);
    expect(
      parseChartCreate({ ...BASE, birth_date: '2008-02-29' }, new Date('2026-03-01T00:00:00Z')),
    ).toBeDefined();
  });

  it('не пускает дату раньше 1900 года и из будущего', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(fieldErrors({ ...BASE, birth_date: '1899-12-31' }, now)).toEqual(['birth_date']);
    expect(fieldErrors({ ...BASE, birth_date: '2030-01-01' }, now)).toEqual(['birth_date']);
  });
});

describe('parseChartCreate: версия согласия', () => {
  it('устаревшая версия — 422 по полю consent.version', () => {
    expect(fieldErrors({ ...BASE, consent: { accepted: true, version: '2025-01-01' } }, new Date())).toEqual([
      'consent.version',
    ]);
  });

  it('актуальная версия принимается', () => {
    const parsed = parseChartCreate(BASE, new Date('2026-11-10T12:00:00Z'), '2026-11-10');
    expect(parsed.consent.version).toBe('2026-11-10');
  });
});
