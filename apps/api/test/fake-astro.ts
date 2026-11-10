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
    createChart(): Promise<AstroChartData> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }
      return Promise.resolve(data);
    },
    transits(): Promise<never> {
      return Promise.reject(new Error('транзиты в этих тестах не используются'));
    },
    wheelSvg(_data: AstroChartData, theme: WheelTheme): Promise<string> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }
      return Promise.resolve(`<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}"></svg>`);
    },
    health(): Promise<'ok' | 'down'> {
      return Promise.resolve(options.down === true ? 'down' : 'ok');
    },
  };
}
