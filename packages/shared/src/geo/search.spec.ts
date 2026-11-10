import { describe, expect, it } from 'vitest';
import { normalizeCityQuery, searchCities, MIN_QUERY_LENGTH } from './search';
import { CITIES } from './cities.data';

describe('normalizeCityQuery', () => {
  it('снимает регистр, «ё», пунктуацию и «г.»', () => {
    expect(normalizeCityQuery('  г. Кёнигсберг ')).toBe('кенигсберг');
    expect(normalizeCityQuery('Нижний   Новгород')).toBe('нижний новгород');
  });
});

describe('searchCities', () => {
  it('находит по началу названия и отдаёт обязательный tz', () => {
    const [first] = searchCities('Моск');
    expect(first).toMatchObject({ name: 'Москва', tz: 'Europe/Moscow', country: 'RU' });
  });

  it('ищет по алиасу (латиница и сокращения)', () => {
    expect(searchCities('Saint')[0]?.name).toBe('Санкт-Петербург');
    expect(searchCities('спб')[0]?.name).toBe('Санкт-Петербург');
  });

  it('ищет по слову внутри названия', () => {
    const names = searchCities('Новгород').map((place) => place.name);
    expect(names).toContain('Нижний Новгород');
  });

  it('до трёх символов возвращает пустой массив', () => {
    expect(searchCities('Мо')).toEqual([]);
    expect('Мо'.length).toBeLessThan(MIN_QUERY_LENGTH);
  });

  it('несуществующий город — пустой массив, а не ошибка', () => {
    expect(searchCities('Атлантида')).toEqual([]);
  });

  it('уважает limit и не отдаёт больше MAX_LIMIT', () => {
    expect(searchCities('Нов', 2).length).toBeLessThanOrEqual(2);
    expect(searchCities('а', 50).length).toBeLessThanOrEqual(10);
  });

  it('у каждого города справочника есть валидный IANA-пояс', () => {
    for (const city of CITIES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: city.tz })).not.toThrow();
    }
  });
});
