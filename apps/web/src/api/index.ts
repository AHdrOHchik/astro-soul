import { ApiError, isApiError, isRecord } from './errors';
import { createHttpClient, type HttpClientOptions } from './http';
import type { components, paths } from './schema.gen';

export { ApiError, isAbortError, isApiError, type ApiErrorCode } from './errors';

/*
 * Every type below is derived from api.openapi.yaml (see `pnpm gen:api`).
 * A field that is not in the contract does not exist for this app.
 */
export type Me = components['schemas']['Me'];
export type GeoPlace = components['schemas']['GeoPlace'];
export type Chart = components['schemas']['Chart'];
export type ChartCreateRequest = components['schemas']['ChartCreateRequest'];
type ChartCreated = paths['/api/v1/charts']['post']['responses'][201]['content']['application/json'];
export type MiniReading = NonNullable<ChartCreated['mini_reading']>;
/**
 * `POST /charts` answer. The contract lists no required keys; the client insists
 * on `chart` because there is nothing to show without it.
 */
export type ChartResult = ChartCreated & { chart: Chart };
type GeoResolveRequest = paths['/api/v1/geo/resolve']['post']['requestBody']['content']['application/json'];

/** Root of every API path; relative URLs returned by the API (`wheel_url`) resolve against it. */
export const API_ROOT = '/api/v1/';

const PATHS = {
  me: '/api/v1/me',
  geoResolve: '/api/v1/geo/resolve',
  charts: '/api/v1/charts',
} as const satisfies Record<string, keyof paths>;

export interface Api {
  getMe(signal?: AbortSignal): Promise<Me>;
  /** Candidates for a birth place; an empty list when nothing matches (404 GEO_NOT_FOUND). */
  resolveGeo(query: string, signal?: AbortSignal): Promise<GeoPlace[]>;
  /** Idempotent on the server by input hash, so it is safe to retry. */
  createChart(input: ChartCreateRequest, signal?: AbortSignal): Promise<ChartResult>;
}

function invalid(): ApiError {
  return new ApiError('INVALID_RESPONSE');
}

function isGeoPlace(value: unknown): value is GeoPlace {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.country === 'string' &&
    typeof value.tz === 'string' &&
    typeof value.lat === 'number' &&
    typeof value.lon === 'number'
  );
}

/**
 * Brings the keys the screens read without checking to the shapes the contract
 * gives them. `asc`, `mc` and `houses` are null when the birth time is unknown;
 * a missing or malformed value is treated the same way: not calculated.
 */
function withContractShapes(chart: Record<string, unknown>): Record<string, unknown> {
  return {
    ...chart,
    birth: isRecord(chart.birth) ? chart.birth : {},
    asc: isRecord(chart.asc) ? chart.asc : null,
    mc: isRecord(chart.mc) ? chart.mc : null,
    planets: Array.isArray(chart.planets) ? chart.planets : [],
    houses: Array.isArray(chart.houses) ? chart.houses : null,
  };
}

export function createApi(options: HttpClientOptions): Api {
  const request = createHttpClient(options);

  return {
    async getMe(signal) {
      const me = await request<unknown>('GET', PATHS.me, { signal });
      if (!isRecord(me)) throw invalid();
      return me as Me;
    },

    async resolveGeo(query, signal) {
      const body: GeoResolveRequest = { query };
      let places: unknown;
      try {
        places = await request<unknown>('POST', PATHS.geoResolve, { body, signal });
      } catch (error) {
        // "Nothing found" is an empty result for the UI, not a failure.
        if (isApiError(error) && (error.code === 'GEO_NOT_FOUND' || error.code === 'NOT_FOUND')) return [];
        throw error;
      }
      if (!Array.isArray(places) || !places.every(isGeoPlace)) throw invalid();
      return places;
    },

    async createChart(input, signal) {
      const result = await request<unknown>('POST', PATHS.charts, { body: input, signal });
      if (!isRecord(result) || !isRecord(result.chart) || typeof result.chart.chart_id !== 'string') throw invalid();
      return { ...result, chart: withContractShapes(result.chart) } as ChartResult;
    },
  };
}

/** Absolute URL for a path or URL returned by the API; null when it cannot be parsed. */
export function absoluteApiUrl(pathOrUrl: string, baseUrl: string, origin: string): string | null {
  try {
    return new URL(pathOrUrl, new URL(API_ROOT, baseUrl === '' ? origin : baseUrl)).href;
  } catch {
    return null;
  }
}
