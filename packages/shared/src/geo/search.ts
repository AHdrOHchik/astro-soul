import type { GeoPlace } from '../contracts';
import { CITIES, CITY_DATASET_VERSION, type CityRecord } from './cities.data';

/**
 * Поиск города по локальному справочнику (без сети).
 *
 * Правила (§`geo.md`):
 *   • поиск начинается с 3 символов, регистр и «ё» не важны;
 *   • совпадение — по началу названия, по началу любого слова или по алиасу;
 *   • сначала идут совпадения с начала названия, затем более населённые;
 *   • пустой результат — это не ошибка: `200` и пустой массив.
 */

/** Минимальная длина запроса, после которой есть смысл искать. */
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 120;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 10;

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

/** Чистая функция — её же использует провайдер в API и тесты. */
export function searchCities(
  rawQuery: string,
  limit: number = DEFAULT_LIMIT,
  cities: readonly CityRecord[] = CITIES,
): GeoPlace[] {
  const query = normalizeCityQuery(rawQuery);

  if (query.length < MIN_QUERY_LENGTH) {
    return [];
  }

  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
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
