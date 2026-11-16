/**
 * Границы поиска городов — только типы, без чисел.
 *
 * Раньше здесь лежали `MIN_QUERY_LENGTH = 2` и остальные три числа. Итерация 21
 * убрала их из кода: значения живут в окружении сервера (`GEO_MIN_QUERY_LENGTH`,
 * `GEO_MAX_QUERY_LENGTH`, `GEO_DEFAULT_LIMIT`, `GEO_MAX_LIMIT`), а клиент узнаёт
 * два нужных ему числа из `GET /me` (`limits.geo_min_query_length`,
 * `limits.geo_max_query_length`).
 *
 * Почему не `VITE_*`: клиентская копия разошлась бы с серверной, и человек
 * получал бы `422` на длине, которую интерфейс считает допустимой. Правило
 * проекта: клиент не решает, сервер не отдаёт лишнего.
 *
 * Файл остался отдельным (и дешёвым для импорта): в нём нет ни одной записи
 * справочника, поэтому `@astro-soul/shared/geo/limits` не тянет 480 КБ городов.
 */

/** Границы длины запроса — то, что сервер проверяет и отдаёт в `GET /me`. */
export interface GeoQueryBounds {
  readonly minQueryLength: number;
  readonly maxQueryLength: number;
}

/** Все четыре границы поиска — серверная сторона, не для клиента. */
export interface GeoSearchLimits extends GeoQueryBounds {
  /** Сколько кандидатов отдавать, если `limit` не передан. */
  readonly defaultLimit: number;
  /** Потолок `limit`: больше — молча зажимаем до этого числа. */
  readonly maxLimit: number;
}

/** Поле `limits` ответа `GET /me` — в контракте snake_case. */
export interface MeGeoLimits {
  readonly geo_min_query_length: number;
  readonly geo_max_query_length: number;
}
