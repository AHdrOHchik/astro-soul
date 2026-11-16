import { CITIES, type CityRecord } from './cities.data.js';

/**
 * Ближайший город справочника — для часового пояса по координатам.
 *
 * Зачем: Nominatim (фолбэк, `geo.md`) почти никогда не отдаёт IANA-пояс, а
 * карта без пояса невозможна: неверный пояс сдвигает время рождения на часы.
 * Поэтому пояс берётся из своего справочника — у ближайшего города, но только
 * если он действительно рядом.
 */

export const EARTH_RADIUS_KM = 6371;

/** Расстояние по haversine, км. */
export function haversineKm(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const toRad = (value: number): number => (value * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface NearestCity {
  readonly record: CityRecord;
  readonly distanceKm: number;
}

/**
 * Ближайший город с известным поясом. `maxDistanceKm` — порог доверия:
 * дальше него пояс считать нельзя, и вызывающий обязан отказать в городе, а не
 * подставить пояс «на глаз».
 *
 * `null` — если в справочнике нет ни одного города в пределах порога.
 */
export function findNearestCity(
  lat: number,
  lon: number,
  maxDistanceKm: number,
  cities: readonly CityRecord[] = CITIES,
): NearestCity | null {
  let best: NearestCity | null = null;

  for (const record of cities) {
    if (record.tz === '') {
      continue;
    }
    const distanceKm = haversineKm(lat, lon, record.lat, record.lon);
    if (distanceKm > maxDistanceKm) {
      continue;
    }
    if (best === null || distanceKm < best.distanceKm) {
      best = { record, distanceKm };
    }
  }

  return best;
}
