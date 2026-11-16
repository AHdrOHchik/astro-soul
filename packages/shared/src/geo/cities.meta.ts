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
  /** Сколько названий взято из GeoNames с пометкой `isolanguage = ru`. */
  readonly namesFromRuIndex: number;
  /** Кириллица из `alternatenames` дампа: в индексе `ru` названия не было. */
  readonly namesFromCyrillicFallback: number;
  /** Осталось латиницей: кириллического варианта нет ни в индексе, ни в дампе. */
  readonly namesFromLatinFallback: number;
  /** Города на транслите — первые 20, чтобы список был виден без запуска сборки. */
  readonly transliteratedNames: readonly string[];
  /** sha256 файла `cities.data.ts`: по нему `--check` сверяет данные офлайн. */
  readonly dataFileSha256: string;
}

export const CITY_DATASET_META: CityDatasetMeta = {
  version: "2026-11-17-geonames-cities1000",
  source: "GeoNames cities1000",
  sourceVersion: "135233 записей в дампе; русские названия — alternateNamesV2 (isolanguage = ru)",
  license: "CC BY 4.0",
  attribution: "Содержит данные GeoNames (https://www.geonames.org), лицензия CC BY 4.0.",
  builtAt: "2026-11-17",
  criteria: "РФ и СНГ: население > 15 000; остальной мир: столицы и население > 300 000",
  countries: 243,
  count: 2997,
  namesFromRuIndex: 2721,
  namesFromCyrillicFallback: 210,
  namesFromLatinFallback: 66,
  transliteratedNames: ["Читтагонг (BD)","Урумчи (CN)","Дадунхай (CN)","Caloocan City (PH)","Мека (SA)","Медина (SA)","Dombivli (IN)","Ростов-на-Дону (RU)","Аллахабад (IN)","Changshu City (CN)","Hāora (IN)","Одесса (UA)","Солапур (IN)","Порт Елизабет (ZA)","Майсур (IN)","Хубли-Дхарвад (IN)","Запорожье (UA)","Pasragad Branch (IR)","Kahrīz (IR)","Бхубанешвар (IN)"],
  dataFileSha256: "29a086f54e617731509529237eba4fd2faadddf824200ba8b9a191cc9fb64712",
};
