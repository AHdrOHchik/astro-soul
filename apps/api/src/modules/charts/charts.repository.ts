import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { AstroChartData } from '../astro/astro.client';

export interface ChartRow {
  readonly id: string;
  readonly created_at: Date;
  readonly data: AstroChartData;
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
  }): Promise<ChartRow> {
    const row = await this.db.queryOne<{
      id: string;
      created_at: Date;
      data: AstroChartData;
      inserted: boolean;
    }>(
      `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (user_id, input_hash) DO UPDATE SET input_hash = EXCLUDED.input_hash
       RETURNING id, created_at, data, (xmax = 0) AS inserted`,
      [input.userId, input.inputHash, JSON.stringify(input.data), input.engineVersion, input.timeKnown],
    );

    if (row === null) {
      // Единственная причина — гонка с удалением пользователя.
      throw new Error('не удалось сохранить карту');
    }

    return row;
  }

  /** Карта конкретного пользователя: чужая карта неотличима от несуществующей. */
  async findOwnedBy(chartId: string, userId: string): Promise<{ id: string; created_at: Date; data: AstroChartData } | null> {
    return this.db.queryOne<{ id: string; created_at: Date; data: AstroChartData }>(
      `SELECT id, created_at, data FROM charts WHERE id = $1 AND user_id = $2`,
      [chartId, userId],
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
