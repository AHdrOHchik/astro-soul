/**
 * Метаданные справочника городов (`geo.md`).
 *
 * ФАЙЛ СГЕНЕРИРОВАН: `node packages/shared/scripts/build-cities.mjs`.
 *
 * Содержит данные GeoNames (https://www.geonames.org), лицензия CC BY 4.0.
 */

export interface CityDatasetMeta {
  readonly version: string;
  readonly source: string;
  readonly sourceVersion: string;
  readonly license: string;
  readonly attribution: string;
  readonly builtAt: string;
  readonly criteria: string;
  readonly countries: number;
  readonly count: number;
}

export const CITY_DATASET_META: CityDatasetMeta = {
  version: "2026-11-17-geonames-cities1000",
  source: "GeoNames cities1000",
  sourceVersion: "cities1000, 135233 записей в дампе",
  license: "CC BY 4.0",
  attribution: "Содержит данные GeoNames (https://www.geonames.org), лицензия CC BY 4.0.",
  builtAt: "2026-11-17",
  criteria: "РФ и СНГ: население > 15 000; остальной мир: столицы и население > 300 000",
  countries: 243,
  count: 2998,
};
