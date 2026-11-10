import { ApiError, isRecord } from './errors';
import { createHttpClient, type HttpClientOptions } from './http';
import type { components, paths } from './schema.gen';

export { ApiError, fieldErrorsOf, isAbortError, isApiError, type ApiErrorCode, type FieldError } from './errors';

/*
 * Every type below is derived from api.openapi.yaml (see `pnpm gen:api`).
 * A field that is not in the contract does not exist for this app.
 */
export type Me = components['schemas']['Me'];
export type GeoPlace = components['schemas']['GeoPlace'];
export type Chart = components['schemas']['Chart'];
export type ChartCreateRequest = components['schemas']['ChartCreateRequest'];
/** How well the birth time is known: `exact`, `approximate` or `unknown`. */
export type TimePrecision = ChartCreateRequest['time_precision'];
/** Answer of `POST /charts`: the chart, its short reading and the paths of the wheel pictures. */
export type ChartResult = components['schemas']['ChartResponse'];
export type MiniReading = ChartResult['mini_reading'];
/** A product event as `POST /events` takes it. */
export type ClientEvent = components['schemas']['ClientEvent'];
type EventsBatch = components['schemas']['EventsBatch'];
type GeoResolveRequest = paths['/api/v1/geo/resolve']['post']['requestBody']['content']['application/json'];

/** Root of every API path; relative URLs returned by the API (`wheel_url`) resolve against it. */
export const API_ROOT = '/api/v1/';

const PATHS = {
  me: '/api/v1/me',
  geoResolve: '/api/v1/geo/resolve',
  charts: '/api/v1/charts',
  events: '/api/v1/events',
} as const satisfies Record<string, keyof paths>;

export interface Api {
  getMe(signal?: AbortSignal): Promise<Me>;
  /**
   * Candidates for a birth place; an empty list when nothing matches. A failure of the
   * geodata provider is an error (503 `GEO_NOT_FOUND`), not an empty list.
   */
  resolveGeo(query: string, signal?: AbortSignal): Promise<GeoPlace[]>;
  /** Idempotent on the server by input hash, so it is safe to retry. */
  createChart(input: ChartCreateRequest, signal?: AbortSignal): Promise<ChartResult>;
  /**
   * One batch of product events, 1 to 20 of them. Sent once and never repeated: the caller
   * has no use for the answer, and a batch that arrived twice would be counted twice.
   * `keepalive` lets the browser deliver it while the page is being closed.
   */
  sendEvents(events: ClientEvent[], options?: { keepalive?: boolean }): Promise<void>;
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

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The reading is required by the contract; a missing or malformed line becomes an empty one, which the screen leaves out. */
function toMiniReading(value: unknown): MiniReading {
  const reading = isRecord(value) ? value : {};
  return { sun: text(reading.sun), moon: text(reading.moon), asc: text(reading.asc), summary: text(reading.summary) };
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
      const places = await request<unknown>('POST', PATHS.geoResolve, { body, signal });
      if (!Array.isArray(places) || !places.every(isGeoPlace)) throw invalid();
      return places;
    },

    async createChart(input, signal) {
      const result = await request<unknown>('POST', PATHS.charts, { body: input, signal });
      // Without a chart there is nothing to show; the rest of the answer degrades to "absent".
      if (!isRecord(result) || !isRecord(result.chart) || typeof result.chart.chart_id !== 'string') throw invalid();
      const wheelPng = text(result.wheel_png_url);
      return {
        chart: withContractShapes(result.chart) as Chart,
        mini_reading: toMiniReading(result.mini_reading),
        wheel_url: text(result.wheel_url),
        // Optional in the contract: a server older than 1.3.0 does not send it.
        ...(wheelPng !== '' && { wheel_png_url: wheelPng }),
      };
    },

    async sendEvents(events, { keepalive } = {}) {
      const body: EventsBatch = { events };
      await request<unknown>('POST', PATHS.events, { body, keepalive, retry: false });
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
