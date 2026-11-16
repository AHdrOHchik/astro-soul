import { describe, expect, it } from 'vitest';
import { normalizeCityQuery, searchCities, type SearchCitiesOptions } from './search.js';
import { CITIES } from './cities.data.js';

/**
 * Границы в тестах задаёт вызывающий — как и в проде, где их берут из
 * окружения сервера (`GEO_MIN_QUERY_LENGTH` и соседние). В самом пакете чисел
 * больше нет: иначе клиент и сервер разошлись бы в том, сколько можно вводить.
 */
const BOUNDS: SearchCitiesOptions = { limit: 5, minQueryLength: 2 };

describe('normalizeCityQuery', () => {
  it('снимает регистр, «ё», пунктуацию и «г.»', () => {
    expect(normalizeCityQuery('  г. Кёнигсберг ')).toBe('кенигсберг');
    expect(normalizeCityQuery('Нижний   Новгород')).toBe('нижний новгород');
  });
});

describe('searchCities', () => {
  it('находит по началу названия и отдаёт обязательный tz', () => {
    const [first] = searchCities('Моск', BOUNDS);
    expect(first).toMatchObject({ name: 'Москва', tz: 'Europe/Moscow', country: 'RU' });
  });

  it('ищет по алиасу (латиница и сокращения)', () => {
    expect(searchCities('Saint', BOUNDS)[0]?.name).toBe('Санкт-Петербург');
    expect(searchCities('спб', BOUNDS)[0]?.name).toBe('Санкт-Петербург');
  });

  it('ищет по слову внутри названия', () => {
    const names = searchCities('Новгород', BOUNDS).map((place) => place.name);
    expect(names).toContain('Нижний Новгород');
  });

  it('минимум длины приходит параметром: 2 — ищет, 3 — уже нет', () => {
    expect(searchCities('Мо', BOUNDS)[0]?.name).toBe('Москва');
    // Тот же запрос при другом серверном минимуме — пустой массив.
    expect(searchCities('Мо', { limit: 5, minQueryLength: 3 })).toEqual([]);
    expect(searchCities('М', BOUNDS)).toEqual([]);
  });

  it('несуществующий город — пустой массив, а не ошибка', () => {
    expect(searchCities('Атлантида', BOUNDS)).toEqual([]);
  });

  it('уважает limit', () => {
    expect(searchCities('Нов', { ...BOUNDS, limit: 2 }).length).toBeLessThanOrEqual(2);
    expect(searchCities('Нов', { ...BOUNDS, limit: 1 }).length).toBe(1);
  });

  it('у каждого города справочника есть валидный IANA-пояс', () => {
    for (const city of CITIES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: city.tz })).not.toThrow();
    }
  });
});
