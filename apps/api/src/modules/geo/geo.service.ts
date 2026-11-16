import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CITY_DATASET_VERSION,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  findNearestCity,
  normalizeCityQuery,
  searchCities,
  type CityRecord,
  type GeoPlace,
} from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, invalidFields } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { GEO_CACHE, cacheKey, type GeoCache } from './geo.cache';
import { NominatimThrottle } from './nominatim.throttle';

export interface NominatimPlace {
  readonly display_name?: string;
  readonly lat?: string;
  readonly lon?: string;
  /** Некоторые инстансы Nominatim отдают пояс явно — тогда он главнее. */
  readonly timezone?: string;
  readonly address?: {
    readonly city?: string;
    readonly town?: string;
    readonly village?: string;
    readonly municipality?: string;
    readonly state?: string;
    readonly country_code?: string;
  };
  readonly namedetails?: { readonly name?: string };
}

/** Машинные причины 503 `GEO_NOT_FOUND`. */
export type GeoProviderReason =
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'not_configured'
  | 'no_timezone';

/** Сколько городов справочника достаточно, чтобы не ходить наружу. */
export interface GeoServiceOptions {
  /** Подмена `fetch` в тестах; по умолчанию глобальный. */
  readonly fetchImpl?: typeof fetch;
  /** Города справочника — для тестов и для честного «не дальше N км». */
  readonly cities?: readonly CityRecord[];
}

/**
 * Поиск города для места рождения (`geo.md`).
 *
 * По умолчанию — только локальный справочник: никаких сетевых запросов,
 * никаких ПДн наружу. Nominatim включается явно (`GEO_PROVIDER=nominatim`) и
 * работает как фолбэк: когда справочник ничего не нашёл **или** нашёл меньше
 * трёх кандидатов (одно созвучие — ещё не город).
 *
 * Часовой пояс — главная сложность фолбэка. Nominatim его почти никогда не
 * отдаёт, а карта без пояса невозможна: неверный пояс сдвигает время рождения
 * на часы. Поэтому пояс берётся из нашего справочника — у ближайшего города в
 * пределах `GEO_TZ_MAX_DISTANCE_KM`. Дальше порога город не отдаётся вовсе:
 * `503 GEO_NOT_FOUND` с `details.reason = no_timezone`.
 */
@Injectable()
export class GeoService {
  private readonly throttle: NominatimThrottle;
  private readonly fetchImpl: typeof fetch;
  private readonly cities: readonly CityRecord[] | undefined;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Optional() @Inject(GEO_CACHE) private readonly cache?: GeoCache,
    @Optional() options?: GeoServiceOptions,
  ) {
    this.throttle = new NominatimThrottle(env.GEO_NOMINATIM_MIN_INTERVAL_MS);
    this.fetchImpl =
      options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.cities = options?.cities;
  }

  async resolve(rawQuery: unknown, rawLimit: unknown): Promise<GeoPlace[]> {
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    const limit = this.parseLimit(rawLimit);

    // Короче двух символов — 422, а не пустой массив: пустой массив по
    // контракту 1.3.0 означает «города нет», а не «ты ввёл слишком мало».
    if (query.length < MIN_QUERY_LENGTH) {
      throw invalidFields(
        [{ field: 'query', message: 'Введи хотя бы 2 буквы' }],
        { reason: 'geo_query_too_short' },
      );
    }

    if (query.length > MAX_QUERY_LENGTH) {
      throw invalidFields(
        [{ field: 'query', message: 'Слишком длинный запрос — введи название города' }],
        { reason: 'geo_query_too_long' },
      );
    }

    const local = searchCities(query, limit);
    const enough = local.length >= this.env.GEO_MIN_LOCAL_CANDIDATES;
    if (this.env.GEO_PROVIDER !== 'nominatim' || enough) {
      return local;
    }

    const remote = await this.searchNominatim(query, limit);
    // Свои города точнее по поясу: они идут первыми, дубли не повторяем.
    const seen = new Set(local.map((place) => `${place.name}|${place.country}`));
    const merged = [...local];
    for (const place of remote) {
      const key = `${place.name}|${place.country}`;
      if (!seen.has(key) && merged.length < limit) {
        seen.add(key);
        merged.push(place);
      }
    }

    return merged.slice(0, limit);
  }

  /**
   * `limit` — 1…10 (контракт 1.4.0). Вне диапазона — 422, а не обрезка:
   * клиент не должен получать другой ответ, чем просил. Отсутствие поля —
   * значение по умолчанию.
   */
  private parseLimit(rawLimit: unknown): number {
    if (rawLimit === undefined || rawLimit === null) {
      return DEFAULT_LIMIT;
    }

    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit)) {
      throw invalidFields([{ field: 'limit', message: 'limit — целое число от 1 до 10' }], {
        reason: 'geo_limit_invalid',
      });
    }

    if (rawLimit < 1 || rawLimit > MAX_LIMIT) {
      throw invalidFields([{ field: 'limit', message: 'limit — целое число от 1 до 10' }], {
        reason: 'geo_limit_out_of_range',
      });
    }

    return rawLimit;
  }

  /**
   * Единственный сетевой вызов в сервисе. Наружу уходит **только строка
   * поиска** — проверяется тестом: ни даты рождения, ни координат, ни
   * `telegram_id`, ни `chart_id` в запросе нет.
   *
   * Недоступность провайдера — это 503 `GEO_NOT_FOUND`, а не пустой массив:
   * пустой массив означает «такого города нет».
   */
  private async searchNominatim(query: string, limit: number): Promise<GeoPlace[]> {
    if (this.env.GEO_CONTACT_EMAIL === undefined) {
      // Политика Nominatim требует контакт в User-Agent: без него не ходим.
      this.logger.warn('geo_provider_not_configured', { reason: 'contact_email_missing' });
      throw this.providerUnavailable('not_configured');
    }

    const key = cacheKey(normalizeCityQuery(query), limit);
    const cached = await this.cache?.get(key);
    if (cached !== null && cached !== undefined) {
      this.logger.info('geo_cache_hit', { query_length: query.length });
      return cached;
    }

    const places = await this.throttle.run(() => this.fetchNominatim(query, limit));
    await this.cache?.set(key, places, this.env.GEO_CACHE_TTL_SECONDS);
    return places;
  }

  private async fetchNominatim(query: string, limit: number): Promise<GeoPlace[]> {
    const url = new URL('/search', this.env.GEO_NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('accept-language', 'ru');

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          // Политика Nominatim: представиться и дать контакт.
          'user-agent': `astro-soul/1.0 (${this.env.GEO_CONTACT_EMAIL})`,
          'accept-language': 'ru',
        },
        signal: AbortSignal.timeout(this.env.GEO_NOMINATIM_TIMEOUT_MS),
      });

      if (response.status === 429) {
        // Повторять сразу нельзя: это ровно то, чего политика просит не делать.
        this.logger.warn('geo_provider_rate_limited', { status: 429 });
        throw this.providerUnavailable('provider_unavailable');
      }

      if (!response.ok) {
        throw new Error(`nominatim_status_${response.status}`);
      }

      const places = (await response.json()) as NominatimPlace[];
      return this.placesOf(places);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      this.logger.warn('geo_provider_unavailable', {
        reason: error instanceof Error ? error.message : 'unknown',
        timeout: timedOut,
      });
      throw this.providerUnavailable(timedOut ? 'provider_timeout' : 'provider_unavailable');
    }
  }

  /**
   * Ответ Nominatim → подсказки. Город без пояса не отдаётся: пояс берём у
   * ближайшего города справочника в пределах порога, иначе — отказ.
   */
  private placesOf(places: readonly NominatimPlace[]): GeoPlace[] {
    const result: GeoPlace[] = [];
    let rejectedNoTimezone = 0;
    let approximate = 0;

    for (const place of places) {
      const lat = Number(place.lat);
      const lon = Number(place.lon);
      const address = place.address;
      const name =
        place.namedetails?.name ??
        address?.city ??
        address?.town ??
        address?.village ??
        address?.municipality;

      if (name === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }

      const country = (address?.country_code ?? '').toUpperCase();
      if (country.length !== 2) {
        continue;
      }

      const timezone = this.timezoneOf(place, lat, lon);
      if (timezone === null) {
        // Пояс «на глаз» не подставляем: ошибка на час хуже пустого списка.
        rejectedNoTimezone += 1;
        this.logger.warn('geo_tz_unknown', { country });
        continue;
      }
      if (timezone.approximate) {
        approximate += 1;
      }

      result.push({
        name,
        region: address?.state ?? null,
        country,
        lat,
        lon,
        tz: timezone.tz,
      });
    }

    if (result.length === 0 && rejectedNoTimezone > 0) {
      throw this.providerUnavailable('no_timezone');
    }

    if (approximate > 0) {
      // Пометка для карты: `approximate_place` в `ChartResponse.warnings`
      // ставится на `POST /charts` — там видно, что город не из справочника.
      this.logger.info('geo_timezone_approximate', { count: approximate });
    }
    this.logger.info('geo_nominatim_used', { places: result.length });
    return result;
  }

  /**
   * Пояс города: явный из ответа, иначе — ближайший город справочника не
   * дальше `GEO_TZ_MAX_DISTANCE_KM`.
   */
  private timezoneOf(
    place: NominatimPlace,
    lat: number,
    lon: number,
  ): { readonly tz: string; readonly approximate: boolean } | null {
    const explicit = place.timezone;
    if (explicit !== undefined && isTimeZone(explicit)) {
      return { tz: explicit, approximate: false };
    }

    const nearest = findNearestCity(
      lat,
      lon,
      this.env.GEO_TZ_MAX_DISTANCE_KM,
      this.cities,
    );
    if (nearest === null) {
      return null;
    }

    return { tz: nearest.record.tz, approximate: true };
  }

  /**
   * 503 `GEO_NOT_FOUND` — недоступность провайдера или невозможность честно
   * определить пояс. `details.reason` — машинная причина: `provider_timeout |
   * provider_unavailable | not_configured | no_timezone`.
   */
  private providerUnavailable(reason: GeoProviderReason): ApiError {
    return new ApiError('GEO_NOT_FOUND', 503, { reason, details: { reason } });
  }

  get datasetVersion(): string {
    return CITY_DATASET_VERSION;
  }
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
