import { Inject, Injectable } from '@nestjs/common';
import type { Chart, ChartCreatedResponse, PlanetPosition } from '@astro-soul/shared';
import { notFound, validationFailed, forbidden } from '../../common/api-error';
import type { VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { AstroClient, type WheelTheme } from '../astro/astro.client';
import { ChartsRepository } from './charts.repository';
import { parseChartCreate } from './charts.dto';
import { WheelSignatureService } from './wheel-signature.service';

export const API_PREFIX = '/api/v1';
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
  ) {}

  async create(auth: VerifiedInitData, body: unknown): Promise<ChartCreatedResponse> {
    const input = parseChartCreate(body);

    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    const data = await this.astro.createChart({
      birth_date: input.birth_date,
      birth_time: input.birth_time ?? null,
      birth_place: { ...input.birth_place, region: input.birth_place.region ?? null },
    });

    const row = await this.charts.upsert({
      userId,
      inputHash: data.input_hash,
      data,
      // Контракт допускает отсутствие полей — движок всегда их присылает,
      // но не полагаемся на это в записи в БД.
      engineVersion: data.chart.engine_version ?? 'unknown',
      timeKnown: input.birth_time !== null,
    });

    return {
      chart: {
        ...row.data.chart,
        chart_id: row.id,
        created_at: row.created_at.toISOString(),
      },
      mini_reading: buildMiniReading(row.data.chart),
      wheel_url: `${API_PREFIX}/charts/${row.id}/wheel.svg?sig=${encodeURIComponent(
        this.signature.sign(row.id),
      )}`,
    };
  }

  async getById(auth: VerifiedInitData, chartId: string): Promise<Chart> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const row = await this.charts.findOwnedBy(chartId, userId);

    if (row === null) {
      throw notFound({ reason: 'chart_not_found' });
    }

    return {
      ...row.data.chart,
      chart_id: row.id,
      created_at: row.created_at.toISOString(),
    };
  }

  /** Публичный (по подписи) SVG колеса. */
  async wheelSvg(chartId: string, signature: string | undefined, theme: string | undefined): Promise<string> {
    const resolvedTheme = (theme ?? 'dark') as WheelTheme;
    if (!WHEEL_THEMES.includes(resolvedTheme)) {
      throw validationFailed({ reason: 'unknown_wheel_theme', details: { field: 'theme' } });
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
}
