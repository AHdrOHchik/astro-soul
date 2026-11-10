import { Inject, Injectable } from '@nestjs/common';
import type { Chart, GeoPlace } from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';

/** Жёсткий таймаут вызова сайдкара (ТЗ: 2 с). */
export const ASTRO_TIMEOUT_MS = 2000;

export interface AstroBirthInput {
  readonly birth_date: string;
  readonly birth_time: string | null;
  readonly time_precision: 'exact' | 'approximate' | 'unknown';
  readonly birth_place: GeoPlace;
}

/** Внутренние числа движка: в контракт не попадают, нужны транзитам и колесу. */
export interface AstroInternal {
  readonly planets: readonly { readonly key: string; readonly longitude: number; readonly speed: number }[];
  readonly houses: readonly number[] | null;
  readonly asc: number | null;
  readonly mc: number | null;
  readonly engine_mode: 'fallback' | 'swisseph';
  readonly house_system: string | null;
}

export interface AstroChartData {
  /** Ответ в форме контракта `Chart` (без chart_id и created_at). */
  readonly chart: Omit<Chart, 'chart_id' | 'created_at'>;
  readonly internal: AstroInternal;
  readonly input_hash: string;
  readonly omitted_planets: readonly string[];
}

export interface AstroTransitReport {
  readonly date: string;
  readonly positions: readonly Record<string, unknown>[];
  readonly aspects: readonly Record<string, unknown>[];
  readonly engine_version: string;
}

export type WheelTheme = 'dark' | 'light';

/**
 * Клиент локального Python-сайдкара (`packages/astro`).
 *
 * Правила от владельца продукта: сайдкар слушает 127.0.0.1, таймаут 2 с,
 * при недоступности API отвечает 503 с `Problem.code=INTERNAL`, а не падает.
 */
@Injectable()
export class AstroClient {
  private readonly baseUrl: string | undefined;

  constructor(
    @Inject(APP_ENV) env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.baseUrl = env.ASTRO_SERVICE_URL;
  }

  get isConfigured(): boolean {
    return this.baseUrl !== undefined;
  }

  async createChart(input: AstroBirthInput): Promise<AstroChartData> {
    return this.post<AstroChartData>('/chart', input);
  }

  async transits(date: string, data: AstroChartData): Promise<AstroTransitReport> {
    return this.post<AstroTransitReport>('/transits', { date, data });
  }

  async wheelSvg(data: AstroChartData, theme: WheelTheme, size = 560): Promise<string> {
    const response = await this.post<{ svg: string }>('/wheel', { data, theme, size });
    return response.svg;
  }

  /** Для `/health`: сам факт ответа, без разбора тела. */
  async health(): Promise<'ok' | 'down'> {
    try {
      await this.request('/health', { method: 'GET' });
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return (await response.json()) as T;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    if (this.baseUrl === undefined) {
      throw this.unavailable('astro_not_configured');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(ASTRO_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error('astro_unavailable', {
        path,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw this.unavailable('astro_unavailable');
    }

    if (!response.ok) {
      this.logger.error('astro_bad_status', { path, status: response.status });
      throw this.unavailable(`astro_status_${response.status}`);
    }

    return response;
  }

  private unavailable(reason: string): ApiError {
    // Наружу — единый INTERNAL/503: клиент не должен видеть внутренние детали.
    return new ApiError('INTERNAL', 503, { reason, logFields: { reason } });
  }
}
