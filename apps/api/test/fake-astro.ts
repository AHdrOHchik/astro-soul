import { createHash } from 'node:crypto';
import { ApiError } from '../src/common/api-error';
import type { AstroChartData, WheelTheme } from '../src/modules/astro/astro.client';
import { engineChartPayload } from './fixtures/chart-payload';

/**
 * Подмена сайдкара в интеграционных тестах: без Python-процесса и сети.
 * Числа — настоящие, из `packages/astro` (`test/fixtures/chart-payload.ts`).
 */
export interface FakeAstro {
  isConfigured: boolean;
  createChart(input: unknown): Promise<AstroChartData>;
  transits(date: string, data: AstroChartData): Promise<never>;
  wheelSvg(data: AstroChartData, theme: WheelTheme, size?: number): Promise<string>;
  health(): Promise<'ok' | 'down'>;
}

export function makeFakeAstro(options: { readonly down?: boolean } = {}): FakeAstro {
  const data = engineChartPayload as unknown as AstroChartData;

  return {
    isConfigured: true,
    createChart(input: unknown): Promise<AstroChartData> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }

      // Движок обязан эхом вернуть time_precision — подмена делает то же самое,
      // иначе тесты не заметят, что поле потерялось по дороге.
      const precision = (input as { time_precision?: 'exact' | 'approximate' | 'unknown' })
        .time_precision;
      const birthTime = (input as { birth_time?: string | null }).birth_time ?? null;

      return Promise.resolve({
        ...data,
        // Настоящий движок хэширует вход: от этого зависит идемпотентность
        // POST /charts (201 против 200). Подмена обязана вести себя так же.
        input_hash: `sha256:${createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex')}`,
        chart: {
          ...data.chart,
          birth: {
            ...data.chart.birth,
            time: birthTime,
            time_known: birthTime !== null,
            ...(precision === undefined ? {} : { time_precision: precision }),
          },
        },
      });
    },
    transits(): Promise<never> {
      return Promise.reject(new Error('транзиты в этих тестах не используются'));
    },
    wheelSvg(_data: AstroChartData, theme: WheelTheme): Promise<string> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }
      // Валидный SVG с размерами: конвертер в PNG обязан его растеризовать.
      return Promise.resolve(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560" width="560" height="560" data-theme="${theme}">` +
          '<circle cx="280" cy="280" r="200" fill="none" stroke="#8b7fd4"/></svg>',
      );
    },
    health(): Promise<'ok' | 'down'> {
      return Promise.resolve(options.down === true ? 'down' : 'ok');
    },
  };
}
