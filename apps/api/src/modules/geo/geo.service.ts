import { Inject, Injectable } from '@nestjs/common';
import {
  CITY_DATASET_VERSION,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  searchCities,
  normalizeCityQuery,
  CITIES,
  type GeoPlace,
} from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, invalidFields } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';

export interface NominatimPlace {
  readonly display_name?: string;
  readonly lat?: string;
  readonly lon?: string;
  readonly address?: {
    readonly city?: string;
    readonly town?: string;
    readonly village?: string;
    readonly state?: string;
    readonly country_code?: string;
  };
  readonly namedetails?: { readonly name?: string };
}

const NOMINATIM_TIMEOUT_MS = 2000;

/**
 * Поиск города для места рождения (`geo.md`).
 *
 * По умолчанию — только локальный справочник: никаких сетевых запросов,
 * никаких ПДн наружу. Nominatim включается явно (`GEO_PROVIDER=nominatim`)
 * и используется как фолбэк, когда справочник ничего не нашёл.
 */
@Injectable()
export class GeoService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async resolve(rawQuery: unknown, rawLimit: unknown): Promise<GeoPlace[]> {
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    const limit = this.parseLimit(rawLimit);

    if (query.length === 0) {
      throw invalidFields(
        [{ field: 'query', message: 'Начни вводить название города' }],
        { reason: 'geo_query_empty' },
      );
    }

    if (query.length > MAX_QUERY_LENGTH) {
      throw invalidFields(
        [{ field: 'query', message: 'Слишком длинный запрос — введи название города' }],
        { reason: 'geo_query_too_long' },
      );
    }

    // До трёх символов не ищем: это ещё не запрос, а мигание клавиатуры.
    if (query.length < MIN_QUERY_LENGTH) {
      return [];
    }

    const local = searchCities(query, limit);
    if (local.length > 0 || this.env.GEO_PROVIDER !== 'nominatim') {
      return local;
    }

    return this.searchNominatim(query, limit);
  }

  private parseLimit(rawLimit: unknown): number {
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
      return 5;
    }
    return Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT);
  }

  /**
   * Единственный сетевой вызов в сервисе. Наружу уходят только название
   * и страна — никогда дата/время рождения и telegram_id.
   *
   * Недоступность провайдера — это 503 `GEO_NOT_FOUND` (контракт 1.2.1),
   * а не пустой массив: пустой массив означает «такого города нет».
   */
  private async searchNominatim(query: string, limit: number): Promise<GeoPlace[]> {
    const url = new URL('/search', this.env.GEO_NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('accept-language', 'ru');

    try {
      const response = await fetch(url, {
        headers: {
          // Политика Nominatim: представиться и дать контакт.
          'user-agent': `astro-soul/1.0 (${this.env.GEO_CONTACT_EMAIL ?? 'support@example.com'})`,
          'accept-language': 'ru',
        },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`nominatim_status_${response.status}`);
      }

      const places = (await response.json()) as NominatimPlace[];
      return places.flatMap((place) => this.toPlace(place));
    } catch (error) {
      this.logger.warn('geo_provider_unavailable', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      // 503 только когда провайдер недоступен: пустой массив — это «города нет».
      throw new ApiError('GEO_NOT_FOUND', 503, {
        reason: 'geo_provider_unavailable',
        details: { provider: 'nominatim' },
      });
    }
  }

  private toPlace(place: NominatimPlace): GeoPlace[] {
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    const address = place.address;
    const name = place.namedetails?.name ?? address?.city ?? address?.town ?? address?.village;

    if (name === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return [];
    }

    const country = (address?.country_code ?? '').toUpperCase();
    if (country.length !== 2) {
      return [];
    }

    // Nominatim поясов не отдаёт, а без IANA-пояса карту не построить:
    // часовой пояс берём только из справочника. Нет пояса — не предлагаем
    // город вовсе (лучше пустой список, чем карта с ошибкой на час).
    const tz = this.timeZoneFromDataset(name, country);
    if (tz === null) {
      this.logger.warn('geo_tz_unknown', { country });
      return [];
    }

    return [
      {
        name,
        region: address?.state ?? null,
        country,
        lat,
        lon,
        tz,
      },
    ];
  }

  /** Пояс из справочника по названию и стране; `null`, если такого города нет. */
  private timeZoneFromDataset(name: string, country: string): string | null {
    const wanted = normalizeCityQuery(name);
    const city = CITIES.find(
      (record) =>
        record.country === country &&
        [record.name, ...(record.aliases ?? [])].some(
          (candidate) => normalizeCityQuery(candidate) === wanted,
        ),
    );

    return city?.tz ?? null;
  }

  get datasetVersion(): string {
    return CITY_DATASET_VERSION;
  }
}
