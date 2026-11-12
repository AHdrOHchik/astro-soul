import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import type { Chart, ChartResponse, PlanetPosition } from '@astro-soul/shared';
import { notFound, validationFailed, forbidden } from '../../common/api-error';
import type { VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { AstroClient, type WheelTheme } from '../astro/astro.client';
import { ChartsRepository, type ChartRow, type OwnedChart } from './charts.repository';
import { parseChartCreate } from './charts.dto';
import { computeWarnings, WARNING_CODES, type ChartWarning } from './charts.warnings';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { WheelSignatureService } from './wheel-signature.service';

export const API_PREFIX = '/api/v1';
/** PNG для шаринга: 1080 px по ширине — стандарт для картинок в чатах. */
export const PNG_SIZE = 1080;
/** Разрешённые ширины PNG (контракт 1.4.0): других значений нет. */
export const PNG_SIZES: readonly number[] = [1080, 1600];
export const PNG_MAX_SIZE = 1600;
/** Плотность растеризации SVG: контуры глифов при 72 dpi выглядят рвано. */
const PNG_DENSITY = 144;
const WHEEL_THEMES: readonly WheelTheme[] = ['dark', 'light'];

function positionLabel(planet: PlanetPosition): string {
  return `${planet.sign}, ${planet.degree}°${planet.minute.toString().padStart(2, '0')}′`;
}

/**
 * Мини-разбор — бесплатный крючок на экране карты.
 * Пока это факты из карты без интерпретаций: тексты появятся в LLM-итерации,
 * выдумывать астрологические выводы на сервере мы не будем.
 */
export function buildMiniReading(chart: Omit<Chart, 'chart_id' | 'created_at'>): {
  sun: string;
  moon: string;
  asc: string;
  summary: string;
} {
  const sun = chart.planets.find((planet) => planet.key === 'sun');
  const moon = chart.planets.find((planet) => planet.key === 'moon');
  const asc = chart.asc;

  const sunText = sun === undefined ? '' : `Солнце в ${positionLabel(sun)}`;
  const moonText = moon === undefined ? '' : `Луна в ${positionLabel(moon)}`;
  const ascText =
    asc === null || asc === undefined
      ? 'Время рождения неизвестно — Асцендент не рассчитан'
      : `Асцендент в ${asc.sign}, ${asc.degree}°${(asc.minute ?? 0).toString().padStart(2, '0')}′`;

  return {
    sun: sunText,
    moon: moonText,
    asc: ascText,
    summary: [sunText, moonText, ascText].filter((part) => part !== '').join(' · '),
  };
}

@Injectable()
export class ChartsService {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(ChartsRepository) private readonly charts: ChartsRepository,
    @Inject(WheelSignatureService) private readonly signature: WheelSignatureService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * `POST /charts`. Возвращаем и флаг «создана / уже была»: контроллер по нему
   * ставит 201 или 200, а клиент по `is_restored` различает `chart_created`
   * и `chart_restored` (контракт 1.4.0).
   */
  async create(
    auth: VerifiedInitData,
    body: unknown,
  ): Promise<{ response: ChartResponse; created: boolean }> {
    const input = parseChartCreate(body, new Date(), this.env.CONSENT_VERSION);
    const birthTime = input.birth_time ?? null;

    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    // Профиль = завершение онбординга: дата/время/место + согласие.
    // Пишем до расчёта карты, чтобы согласие было зафиксировано, даже если
    // движок недоступен: пользователь уже согласился, повторно спрашивать нельзя.
    await this.users.upsertProfile({
      userId,
      birthDate: input.birth_date,
      birthTime,
      timeMode: input.time_precision,
      place: input.birth_place,
      consentVersion: input.consent.version,
    });

    const data = await this.astro.createChart({
      birth_date: input.birth_date,
      birth_time: birthTime,
      time_precision: input.time_precision,
      birth_place: { ...input.birth_place, region: input.birth_place.region ?? null },
    });

    const row = await this.charts.upsert({
      userId,
      inputHash: data.input_hash,
      data,
      // Контракт допускает отсутствие полей — движок всегда их присылает,
      // но не полагаемся на это в записи в БД.
      engineVersion: data.chart.engine_version ?? 'unknown',
      timeKnown: birthTime !== null,
      // Предупреждения считаем на входе и храним: `approximate_place` по самой
      // карте уже не восстановить, а ответ должен быть одинаковым всегда.
      warnings: computeWarnings({ timePrecision: input.time_precision, place: input.birth_place }),
    });

    // `inserted` различает вставку и попадание в существующую строку по
    // `(user_id, input_hash)`: это и есть 201 против 200.
    return { response: this.toResponse(row, !row.inserted), created: row.inserted };
  }

  /** `GET /charts/current` — карта пользователя или 404 (онбординг). */
  async getCurrent(auth: VerifiedInitData): Promise<ChartResponse> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const row = await this.charts.findLatestByUser(userId);

    if (row === null) {
      throw notFound({ reason: 'chart_not_found' });
    }

    return this.toResponse(row, true);
  }

  /** Тот же конверт, что и `POST /charts` (контракт 1.2.1). */
  async getById(auth: VerifiedInitData, chartId: string): Promise<ChartResponse> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const row = await this.charts.findOwnedBy(chartId, userId);

    if (row === null) {
      throw notFound({ reason: 'chart_not_found' });
    }

    return this.toResponse(row, true);
  }

  /**
   * Публичный (по подписи) PNG колеса — картинка для шаринга в чат.
   * Растеризуем тот же SVG, что и на экране: одна геометрия, один вид.
   */
  async wheelPng(
    chartId: string,
    signature: string | undefined,
    theme: string | undefined,
    size: number | undefined,
  ): Promise<Buffer> {
    // Контракт 1.4.0: только 1080 или 1600. Не подменяем размер молча —
    // клиент должен получать ровно тот ответ, который просил.
    const width = size ?? PNG_SIZE;
    if (!PNG_SIZES.includes(width)) {
      throw validationFailed({
        reason: 'unknown_png_size',
        details: {
          field_errors: [{ field: 'size', message: 'Размер картинки — 1080 или 1600' }],
        },
      });
    }

    const svg = await this.wheelSvg(chartId, signature, theme);

    return sharp(Buffer.from(svg, 'utf8'), { density: PNG_DENSITY })
      .resize({ width: Math.min(width, PNG_MAX_SIZE) })
      .png()
      .toBuffer();
  }

  /** Публичный (по подписи) SVG колеса. */
  async wheelSvg(
    chartId: string,
    signature: string | undefined,
    theme: string | undefined,
  ): Promise<string> {
    const resolvedTheme = (theme ?? 'dark') as WheelTheme;
    if (!WHEEL_THEMES.includes(resolvedTheme)) {
      throw validationFailed({
        reason: 'unknown_wheel_theme',
        details: { field_errors: [{ field: 'theme', message: 'Тема может быть dark или light' }] },
      });
    }

    if (!this.signature.verify(chartId, signature)) {
      // Подпись невалидна или истекла: 403, без подсказок о существовании карты.
      throw forbidden({ reason: 'wheel_signature_invalid' });
    }

    const row = await this.charts.findById(chartId);
    if (row === null) {
      throw notFound({ reason: 'chart_not_found' });
    }

    return this.astro.wheelSvg(row.data, resolvedTheme);
  }

  /**
   * Свежая подпись на каждый ответ: ссылка на колесо живёт 30 дней, а карта —
   * дольше. Подпись не хранится в БД, поэтому продлевается сама.
   */
  private toResponse(row: OwnedChart | ChartRow, isRestored: boolean): ChartResponse {
    // Одна подпись на оба адреса: SVG для экрана, PNG для шаринга.
    const signature = this.signature.sign(row.id);

    return {
      chart: {
        ...row.data.chart,
        chart_id: row.id,
        created_at: row.created_at.toISOString(),
      },
      mini_reading: buildMiniReading(row.data.chart),
      // Карты, созданные до 1.4.0, отдают `[]` — ровно как требует контракт.
      // Коды, которых нет в контракте (например, откатили релиз), не отдаём:
      // клиент обязан пропускать незнакомые, но сервер не имеет права их
      // изобретать — проще не отдать, чем отдать недокументированное.
      warnings: (row.warnings ?? []).filter((code): code is ChartWarning =>
        (WARNING_CODES as readonly string[]).includes(code),
      ),
      is_restored: isRestored,
      wheel_url: `${API_PREFIX}/charts/${row.id}/wheel.svg?sig=${encodeURIComponent(signature)}`,
      wheel_png_url: `${API_PREFIX}/charts/${row.id}/wheel.png?sig=${encodeURIComponent(signature)}`,
    };
  }
}
