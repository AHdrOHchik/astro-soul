import { createHash } from 'node:crypto';
import { ApiError } from '../src/common/api-error';
import type { AstroChartData, AstroDayFacts, WheelTheme } from '../src/modules/astro/astro.client';
import { engineChartPayload } from './fixtures/chart-payload';
import { compatFactsPayload } from './fixtures/compat-facts';

/**
 * Подмена сайдкара в интеграционных тестах: без Python-процесса и сети.
 * Числа — настоящие, из `packages/astro` (`test/fixtures/chart-payload.ts`).
 */
export interface FakeAstro {
  isConfigured: boolean;
  createChart(input: unknown): Promise<AstroChartData>;
  transits(date: string, data: AstroChartData): Promise<never>;
  synastry(a: AstroChartData, b: AstroChartData): Promise<unknown>;
  wheelSvg(data: AstroChartData, theme: WheelTheme, size?: number): Promise<string>;
  health(): Promise<'ok' | 'down'>;
  forecastFacts(date: string, timezone: string, data: AstroChartData): Promise<AstroDayFacts>;
}

export function makeFakeAstro(
  options: {
    readonly down?: boolean;
    /** Свой ответ `POST /synastry`: по умолчанию — эталонная карта сама с собой. */
    readonly facts?: unknown;
  } = {},
): FakeAstro {
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
    synastry(): Promise<unknown> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }
      // Факты посчитаны настоящим движком (`fixtures/compat-facts.ts`):
      // подмена не выдумывает углы, иначе валидаторы проверяли бы воздух.
      return Promise.resolve(options.facts ?? compatFactsPayload);
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
    /**
     * `POST /forecast/facts`: та же форма, что у сайдкара, и та же главная
     * гарантия — одинаковый вход даёт одинаковый ответ. Даты и пояса разные в
     * разных тестах, поэтому значения зависят от них, но детерминированно.
     */
    forecastFacts(date: string, timezone: string): Promise<AstroDayFacts> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }

      const dayNumber = Number(date.slice(8, 10));
      const signs = ['Овен', 'Телец', 'Близнецы', 'Рак', 'Лев', 'Дева', 'Весы', 'Скорпион', 'Стрелец', 'Козерог', 'Водолей', 'Рыбы'];
      const phases = ['растущая', 'полная', 'убывающая', 'новолуние'];

      return Promise.resolve({
        date,
        timezone,
        timezone_note: 'часовой пояс места рождения',
        engine_version: '1.1.0',
        noon_utc: `${date}T09:00:00Z`,
        moon: {
          sign: signs[dayNumber % 12] ?? 'Овен',
          degree: dayNumber % 30,
          minute: 44,
          phase: phases[dayNumber % 4] ?? 'растущая',
          illumination: 0.777,
          retrograde: false,
        },
        retrograde: [{ key: 'saturn', name: 'Сатурн' }],
        ruler: { key: 'venus', name: 'Венера', weekday: 5 },
        transits: [
          {
            transit_name: 'Юпитер',
            natal_name: 'Солнце',
            type_ru: 'квадрат',
            orb: 0.09,
          },
        ],
        windows: [
          { from: `${date}T00:00:00`, to: `${date}T06:00:00`, label: 'транзит Луны к Венере' },
          { from: `${date}T06:00:00`, to: `${date}T12:00:00`, label: 'транзит Луны к Меркурию' },
        ],
      });
    },
    health(): Promise<'ok' | 'down'> {
      return Promise.resolve(options.down === true ? 'down' : 'ok');
    },
  };
}
