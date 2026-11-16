import type { GeoPlace } from '../contracts.js';
import { CITIES, CITY_DATASET_VERSION, type CityRecord } from './cities.data.js';
/**
 * Поиск города по локальному справочнику (без сети).
 *
 * Правила (§`geo.md`):
 *   • поиск начинается с 3 символов, регистр и «ё» не важны;
 *   • совпадение — по началу названия, по началу любого слова или по алиасу;
 *   • сначала идут совпадения с начала названия, затем более населённые;
 *   • пустой результат — это не ошибка: `200` и пустой массив.
 */

/**
 * Границы поиска приходят параметром, а не из константы: значения живут в
 * окружении сервера (`GEO_MIN_QUERY_LENGTH` и соседние), а не в коде пакета.
 */
export type { GeoQueryBounds, GeoSearchLimits, MeGeoLimits } from './limits.js';

export { CITY_DATASET_VERSION };

/** Нормализация: регистр, «ё», лишние пробелы, «г.» и дефисные варианты. */
export function normalizeCityQuery(input: string): string {
  return input
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,()"'«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(г|город)\s+/, '');
}

interface Ranked {
  readonly record: CityRecord;
  readonly rank: number;
}

function rankOf(record: CityRecord, query: string): number | null {
  const names = [record.name, ...(record.aliases ?? [])];

  for (const raw of names) {
    const name = normalizeCityQuery(raw);
    if (name === query) {
      return 0;
    }
    if (name.startsWith(query)) {
      return 1;
    }
    if (name.split(/[\s-]+/).some((word) => word.startsWith(query))) {
      return 2;
    }
  }

  return null;
}

function toGeoPlace(record: CityRecord): GeoPlace {
  return {
    name: record.name,
    region: record.region ?? null,
    country: record.country,
    lat: record.lat,
    lon: record.lon,
    tz: record.tz,
  };
}

/** Параметры поиска: границы задаёт вызывающий (у сервера они из окружения). */
export interface SearchCitiesOptions {
  /** Сколько кандидатов вернуть; потолок зажимает вызывающий, здесь — как есть. */
  readonly limit: number;
  /** Короче этого — пустой массив, а не «первый символ ищи по всей базе». */
  readonly minQueryLength: number;
  /** Справочник; подменяется в тестах. */
  readonly cities?: readonly CityRecord[];
}

/** Чистая функция — её же использует провайдер в API и тесты. */
export function searchCities(rawQuery: string, options: SearchCitiesOptions): GeoPlace[] {
  const query = normalizeCityQuery(rawQuery);

  if (query.length < options.minQueryLength) {
    return [];
  }

  const { cities = CITIES } = options;
  const safeLimit = Math.max(options.limit, 1);
  const ranked: Ranked[] = [];

  for (const record of cities) {
    const rank = rankOf(record, query);
    if (rank !== null) {
      ranked.push({ record, rank });
    }
  }

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    const populationA = a.record.population ?? 0;
    const populationB = b.record.population ?? 0;
    if (populationA !== populationB) {
      return populationB - populationA;
    }
    return a.record.name.localeCompare(b.record.name, 'ru');
  });

  return ranked.slice(0, safeLimit).map((item) => toGeoPlace(item.record));
}

/** Размер справочника — для логов и `GET /health`-диагностики. */
export const CITY_COUNT = CITIES.length;
