import { createHash } from 'node:crypto';
import { ApiError } from '../src/common/api-error';
import type {
  AstroChartData,
  AstroDayFacts,
  CardBuildRequest,
  CardBuildResponse,
  PdfBuildRequest,
  PdfBuildResponse,
  WheelTheme,
} from '../src/modules/astro/astro.client';
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
  wheelPng(data: AstroChartData, theme: WheelTheme, size?: number): Promise<Buffer>;
  buildPdf(input: PdfBuildRequest): Promise<PdfBuildResponse>;
  buildCard(input: CardBuildRequest): Promise<CardBuildResponse>;
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
     * `POST /wheel/png`: настоящий PNG-заголовок, а не заглушка-строка.
     *
     * Минимальный валидный PNG (1×1) собирается здесь же, чтобы тесты могли
     * проверить хотя бы сигнатуру файла и что в хранилище легли именно байты, а
     * не base64-текст. Размер колеса в подмене не важен: он проверяется в
     * `packages/astro`.
     */
    wheelPng(_data: AstroChartData, theme: WheelTheme): Promise<Buffer> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }

      // 1×1 PNG, тёмный или светлый пиксель — от темы, чтобы подмена была
      // чувствительна к аргументу.
      const pixel = theme === 'dark' ? 'ff1a1230' : 'ffffffff';
      return Promise.resolve(
        Buffer.from(
          `89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf${pixel}0000000049454e44ae426082`,
          'hex',
        ),
      );
    },
    /**
     * `POST /pdf/build`: документ-«заглушка» с теми же полями, что отдаёт
     * сайдкар. Байты — валидный префикс PDF, чтобы проверка «в хранилище лежит
     * PDF, а не текст» была настоящей.
     */
    buildPdf(input: PdfBuildRequest): Promise<PdfBuildResponse> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }

      const pdf = Buffer.from(
        `%PDF-1.4\n% ${input.chapters.length} chapters, ${input.actions.length} actions\n%%EOF\n`,
        'utf8',
      );

      return Promise.resolve({
        pdf_base64: pdf.toString('base64'),
        bytes: pdf.byteLength,
        pages: Math.max(1, input.chapters.length + 1),
        wheel_scale: input.wheel_png_base64 === null ? 0 : 1,
        build_ms: 1,
      });
    },
    /** `POST /card/build`: PNG нужного карточке размера (1080×1920 / 1080×1080). */
    buildCard(input: CardBuildRequest): Promise<CardBuildResponse> {
      if (options.down === true) {
        return Promise.reject(new ApiError('INTERNAL', 503, { reason: 'astro_unavailable' }));
      }

      const width = 1080;
      const height = input.kind === 'insight' ? 1080 : 1920;
      const png = Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from(`${input.kind}:${String(height)}`, 'utf8'),
      ]);

      return Promise.resolve({
        png_base64: png.toString('base64'),
        bytes: png.byteLength,
        width,
        height,
      });
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
