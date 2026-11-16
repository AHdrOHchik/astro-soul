import { describe, expect, it } from 'vitest';
import { CITIES, CITY_DATASET_VERSION } from './cities.data.js';
import { CITY_DATASET_META } from './cities.meta.js';
import { searchCities } from './search.js';

/** Страны СНГ из сборки: для них порог населения ниже. */
const CIS = new Set(['RU', 'BY', 'KZ', 'UA', 'UZ', 'KG', 'TJ', 'TM', 'AZ', 'AM', 'MD', 'GE']);

/** Порог РФ и СНГ (`geo.md`, решение владельца 2026-11-17). */
const CIS_MIN_POPULATION = 15_000;
/** Порог остального мира: крупные города плюс столицы в любом случае. */
const WORLD_MIN_POPULATION = 300_000;

/** Границы для тестов: в проде они из окружения сервера (`GEO_*`). */
const BOUNDS = { limit: 5, minQueryLength: 2 };

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

describe('справочник городов: отбор и качество данных', () => {
  it('городов не меньше заявленного и не «первые N»', () => {
    // Фактическое число — в сообщении: его же пишем в отчёте итерации.
    expect(CITIES.length, `в справочнике ${CITIES.length} городов`).toBeGreaterThanOrEqual(900);
    expect(CITIES.length).toBeLessThanOrEqual(4_000);
  });

  it('у каждой записи есть обязательные поля и IANA-пояс', () => {
    for (const city of CITIES) {
      expect(city.name, JSON.stringify(city)).not.toBe('');
      expect(city.country).toMatch(/^[A-Z]{2}$/u);
      expect(Number.isFinite(city.lat)).toBe(true);
      expect(Number.isFinite(city.lon)).toBe(true);
      expect(Math.abs(city.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(city.lon)).toBeLessThanOrEqual(180);
      // Без пояса карту не построить: такие записи в справочник не попадают.
      expect(isValidTimeZone(city.tz), `${city.name}: ${city.tz}`).toBe(true);
    }
  });

  it('ниже порога населения нет ни одного города', () => {
    const below = CITIES.filter((city) =>
      CIS.has(city.country)
        ? (city.population ?? 0) <= CIS_MIN_POPULATION
        : !city.capital && (city.population ?? 0) <= WORLD_MIN_POPULATION,
    );

    expect(below.map((city) => `${city.name} (${city.population ?? 0})`)).toEqual([]);
  });

  it('регион заполнен почти везде: он отличает «Сосновку» от «Сосновки»', () => {
    const withRegion = CITIES.filter((city) => (city.region ?? '') !== '');
    expect(withRegion.length / CITIES.length).toBeGreaterThan(0.98);
  });

  it('нет дублей «страна + название + регион»', () => {
    const keys = new Set<string>();
    const duplicates: string[] = [];
    for (const city of CITIES) {
      const key = `${city.country}|${city.name}|${city.region ?? ''}`;
      if (keys.has(key)) {
        duplicates.push(key);
      }
      keys.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it('версия датасета описывает сборку, а не «starter»', () => {
    expect(CITY_DATASET_VERSION).toBe(CITY_DATASET_META.version);
    expect(CITY_DATASET_VERSION).not.toContain('starter');
    expect(CITY_DATASET_META.count).toBe(CITIES.length);
  });

  it('метаданные называют источник и лицензию CC BY', () => {
    // Атрибуция — требование лицензии GeoNames, а не украшение.
    expect(CITY_DATASET_META.source).toContain('GeoNames');
    expect(CITY_DATASET_META.license).toBe('CC BY 4.0');
    expect(CITY_DATASET_META.attribution).toContain('geonames.org');
  });

  it('названия взяты из GeoNames с пометкой isolanguage = ru, а не выдуманы транслитом', () => {
    // Итерация 21: раньше кириллица собиралась транслитерацией по
    // `alternatenames` без языковых пометок, и половина названий была «своей».
    // Теперь основной источник — индекс `isolanguage = ru`, транслит — фолбэк.
    expect(CITY_DATASET_META.namesFromRuIndex / CITIES.length).toBeGreaterThan(0.85);
    expect(CITY_DATASET_META.namesFromRuIndex + CITY_DATASET_META.namesFromCyrillicFallback + CITY_DATASET_META.namesFromLatinFallback).toBe(CITIES.length);
    // Фолбэк виден списком: первые 20 — чтобы его не приходилось искать сборкой.
    expect(CITY_DATASET_META.transliteratedNames.length).toBeLessThanOrEqual(20);
  });

  it('русские названия — привычные, а не транслит: Таллин, Гуанчжоу, Сан-Диего', () => {
    const names = new Set(CITIES.map((city) => city.name));
    for (const expected of ['Таллин', 'Гуанчжоу', 'Сан-Диего', 'Нанкин', 'Хошимин', 'Нью-Йорк']) {
      expect(names.has(expected), `нет «${expected}»`).toBe(true);
    }
    for (const wrong of ['Таллинн', 'Гуанжоу', 'Нанкинг']) {
      expect(names.has(wrong), `остался транслит «${wrong}»`).toBe(false);
    }
  });
});

describe('поиск по расширенному справочнику', () => {
  it('«нижний» находит Нижний Новгород', () => {
    const names = searchCities('нижний', BOUNDS).map((place) => place.name);
    expect(names).toContain('Нижний Новгород');
  });

  it('«ел» находит Елец и Елабугу', () => {
    const names = searchCities('ел', { ...BOUNDS, limit: 10 }).map((place) => place.name);
    expect(names).toContain('Елец');
    expect(names).toContain('Елабуга');
  });

  it('ё и е равнозначны, регистр не важен', () => {
    expect(searchCities('королев', BOUNDS).map((place) => place.name)).toContain('Королёв');
    expect(searchCities('КОРОЛЕВ', BOUNDS).map((place) => place.name)).toContain('Королёв');
    expect(searchCities('ЧЕРЕПОВЕЦ', BOUNDS).map((place) => place.name)).toContain('Череповец');
  });

  it('маленький город из нового справочника тоже находится', () => {
    // 32 тысячи человек: такого в стартовом наборе из 149 городов не было.
    expect(searchCities('Удомля', BOUNDS).map((place) => place.name)).toContain('Удомля');
  });
});
