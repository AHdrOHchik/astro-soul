import { CITIES, normalizeCityQuery } from '@astro-soul/shared';
import type { TimePrecision } from './charts.dto';

/**
 * Коды `ChartResponse.warnings` (контракт 1.4.0).
 *
 * Список расширяемый: клиент обязан пропускать незнакомые коды, поэтому новый
 * код добавляется здесь и в `api.openapi.yaml` одним PR — без ломающего
 * изменения контракта. Обратное тоже верно: код, которого нет в контракте,
 * отдавать нельзя, иначе он «появится» без документации.
 */
export const WARNING_CODES = [
  'no_birth_time',
  'approximate_time',
  'approximate_place',
] as const;

export type ChartWarning = (typeof WARNING_CODES)[number];

export interface WarningInput {
  readonly timePrecision: TimePrecision;
  readonly place: { readonly name: string; readonly country: string };
}

/**
 * Есть ли город в справочнике, по которому мы считаем часовой пояс.
 *
 * Если города нет — пояс мог быть восстановлен по ближайшему крупному городу
 * (Nominatim), а значит время рождения могло уехать на час. Это не ошибка
 * расчёта, но пользователь должен знать: `approximate_place`.
 */
export function isPlaceInGazetteer(name: string, country: string): boolean {
  const wanted = normalizeCityQuery(name);

  return CITIES.some(
    (record) =>
      record.country === country &&
      [record.name, ...(record.aliases ?? [])].some(
        (candidate) => normalizeCityQuery(candidate) === wanted,
      ),
  );
}

/**
 * Предупреждения для новой карты. Порядок фиксированный — клиент показывает
 * их списком, и порядок не должен прыгать между запросами.
 */
export function computeWarnings(input: WarningInput): ChartWarning[] {
  const warnings: ChartWarning[] = [];

  if (input.timePrecision === 'unknown') {
    warnings.push('no_birth_time');
  } else if (input.timePrecision === 'approximate') {
    warnings.push('approximate_time');
  }

  if (!isPlaceInGazetteer(input.place.name, input.place.country)) {
    warnings.push('approximate_place');
  }

  return warnings;
}
