import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { AstroChartData } from '../astro/astro.client';

/** Строка карты в том виде, в каком она нужна конверту ответа. */
export interface OwnedChart {
  readonly id: string;
  readonly created_at: Date;
  readonly data: AstroChartData;
  readonly warnings: string[];
}

export interface ChartRow {
  readonly id: string;
  readonly created_at: Date;
  readonly data: AstroChartData;
  readonly warnings: string[];
  readonly inserted: boolean;
}

@Injectable()
export class ChartsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Идемпотентность `POST /charts`: уникальный индекс `(user_id, input_hash)`.
   * `ON CONFLICT DO UPDATE` возвращает строку и при вставке, и при повторе;
   * `xmax = 0` отличает одно от другого.
   */
  async upsert(input: {
    userId: string;
    inputHash: string;
    data: AstroChartData;
    engineVersion: string;
    timeKnown: boolean;
    /** `ChartResponse.warnings`, посчитанные на входе (контракт 1.4.0). */
    warnings: readonly string[];
  }): Promise<ChartRow> {
    const row = await this.db.queryOne<{
      id: string;
      created_at: Date;
      data: AstroChartData;
      warnings: string[];
      inserted: boolean;
    }>(
      `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known, warnings)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::text[])
       ON CONFLICT (user_id, input_hash) DO UPDATE SET input_hash = EXCLUDED.input_hash
       RETURNING id, created_at, data, warnings, (xmax = 0) AS inserted`,
      [
        input.userId,
        input.inputHash,
        JSON.stringify(input.data),
        input.engineVersion,
        input.timeKnown,
        input.warnings,
      ],
    );

    if (row === null) {
      // Единственная причина — гонка с удалением пользователя.
      throw new Error('не удалось сохранить карту');
    }

    return row;
  }

  /** Карта конкретного пользователя: чужая карта неотличима от несуществующей. */
  async findOwnedBy(chartId: string, userId: string): Promise<OwnedChart | null> {
    return this.db.queryOne<OwnedChart>(
      `SELECT id, created_at, data, warnings FROM charts WHERE id = $1 AND user_id = $2`,
      [chartId, userId],
    );
  }

  /**
   * Текущая карта пользователя для `GET /charts/current` (контракт 1.4.0).
   *
   * «Текущая» = последняя созданная: пересчёт с другими данными (пользователь
   * исправил время) даёт новую строку, и возвращаться к старой он не должен.
   */
  async findLatestByUser(userId: string): Promise<OwnedChart | null> {
    return this.db.queryOne<OwnedChart>(
      `SELECT id, created_at, data, warnings
         FROM charts
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId],
    );
  }

  /** Для подписанной ссылки на колесо: доступ проверяется подписью, не сессией. */
  async findById(chartId: string): Promise<{ id: string; data: AstroChartData } | null> {
    return this.db.queryOne<{ id: string; data: AstroChartData }>(
      `SELECT id, data FROM charts WHERE id = $1`,
      [chartId],
    );
  }
}
