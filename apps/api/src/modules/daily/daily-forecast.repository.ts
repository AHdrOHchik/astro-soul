import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { AstroDayFacts } from '../astro/astro.client';
import { breakerState } from '../reports/breaker';

/**
 * Строка `daily_forecasts`. `body_md` — тот же markdown, что видит человек:
 * при разборе инцидента его читают глазами, а не через JSON-парсер.
 */
export interface DailyForecastRow {
  readonly id: string;
  readonly local_date: string;
  readonly timezone: string;
  readonly engine_version: string;
  readonly prompt_version: string;
  readonly status: 'pending' | 'ready' | 'failed';
  readonly body_md: string | null;
  readonly chars: number | null;
  readonly warnings: readonly string[];
  readonly facts: AstroDayFacts;
  readonly cost_rub: string;
  readonly error_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ClaimInput {
  readonly userId: string;
  readonly localDate: string;
  readonly timezone: string;
  readonly engineVersion: string;
  readonly promptVersion: string;
  readonly facts: AstroDayFacts;
}

const COLUMNS = `id, local_date::text AS local_date, timezone, engine_version, prompt_version,
                 status, body_md, chars, warnings, facts,
                 cost_rub::text AS cost_rub, error_code, created_at, updated_at`;

@Injectable()
export class DailyForecastRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Один прогноз в сутки — свойство продукта, а не ограничение.
   *
   * `insert … on conflict do nothing` — это и есть single-flight: кто первый
   * вставил строку, тот и вызывает модель; второй читает существующую. Два
   * параллельных запроса не дают двух вызовов, потому что вызов стоит денег.
   */
  async claim(input: ClaimInput): Promise<{ row: DailyForecastRow; created: boolean }> {
    const inserted = await this.db.queryOne<DailyForecastRow>(
      `INSERT INTO daily_forecasts
         (user_id, local_date, timezone, engine_version, prompt_version, status, facts)
       VALUES ($1, $2::date, $3, $4, $5, 'pending', $6::jsonb)
       ON CONFLICT (user_id, local_date, prompt_version) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        input.localDate,
        input.timezone,
        input.engineVersion,
        input.promptVersion,
        JSON.stringify(input.facts),
      ],
    );

    if (inserted !== null) {
      return { row: inserted, created: true };
    }

    const existing = await this.find(
      input.userId,
      input.localDate,
      input.promptVersion,
    );

    // Строка исчезла между вставкой и чтением — возможно только при `DELETE
    // /me` в этот же момент. Пусть вызывающий ответит «попробуй ещё раз».
    if (existing === null) {
      throw new Error('daily_forecast_claim_race');
    }

    return { row: existing, created: false };
  }

  async find(
    userId: string,
    localDate: string,
    promptVersion: string,
  ): Promise<DailyForecastRow | null> {
    return this.db.queryOne<DailyForecastRow>(
      `SELECT ${COLUMNS}
         FROM daily_forecasts
        WHERE user_id = $1 AND local_date = $2::date AND prompt_version = $3`,
      [userId, localDate, promptVersion],
    );
  }

  async findById(id: string): Promise<DailyForecastRow | null> {
    return this.db.queryOne<DailyForecastRow>(
      `SELECT ${COLUMNS} FROM daily_forecasts WHERE id = $1`,
      [id],
    );
  }

  /**
   * Захват «зависшей» строки: `pending` старше `staleSeconds`.
   *
   * Таймаут генерации оставляет строку `pending` — иначе следующий запрос
   * ждал бы вечно. Захват атомарный: из двух одновременных запросов
   * сгенерирует один, второй пойдёт ждать результат.
   */
  async claimStale(id: string, staleSeconds: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `UPDATE daily_forecasts
          SET updated_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND updated_at <= now() - make_interval(secs => $2)
        RETURNING id`,
      [id, staleSeconds],
    );
    return row !== null;
  }

  /**
   * Часовой пояс места рождения (`profiles.place_tz`).
   *
   * Именно он, а не текущее место: другого пояса у нас нет. Ограничение
   * описано в маршруте и в `geo.md`, чтобы его не «чинили» догадкой.
   */
  async profileTimezone(userId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ place_tz: string | null }>(
      `SELECT place_tz FROM profiles WHERE user_id = $1`,
      [userId],
    );
    return row?.place_tz ?? null;
  }

  /** Возврат `failed` → `pending` перед новой попыткой (после паузы). */
  async markPending(id: string): Promise<void> {
    await this.db.query(
      `UPDATE daily_forecasts
          SET status = 'pending', error_code = NULL, updated_at = now()
        WHERE id = $1 AND status = 'failed'`,
      [id],
    );
  }

  /**
   * Состояние брейкера по последним строкам.
   *
   * Серия считается по `status`, а не по `error_code`: любой провал генерации
   * (таймаут, формат, запрещённый текст) — один и тот же сигнал «сегодня
   * модель не работает».
   */
  async breaker(): Promise<{ streak: number; open: boolean; retry_after_ms: number | null }> {
    const rows = await this.db.query<{ status: string; updated_at: Date }>(
      `SELECT status, updated_at FROM daily_forecasts ORDER BY updated_at DESC LIMIT 20`,
    );

    let streak = 0;
    let lastFailedAt: Date | null = null;
    for (const row of rows) {
      if (row.status === 'failed') {
        streak += 1;
        lastFailedAt ??= row.updated_at;
      } else if (row.status === 'ready') {
        break;
      }
    }

    const state = breakerState(streak, lastFailedAt);
    return {
      streak: state.streak,
      open: state.open,
      retry_after_ms: state.retry_after_ms,
    };
  }

  async markReady(
    id: string,
    bodyMd: string,
    chars: number,
    warnings: readonly string[] = [],
  ): Promise<void> {
    await this.db.query(
      `UPDATE daily_forecasts
          SET status = 'ready', body_md = $2, chars = $3, warnings = $4::jsonb, error_code = NULL
        WHERE id = $1`,
      [id, bodyMd, chars, JSON.stringify(warnings)],
    );
  }

  async markFailed(id: string, errorCode: string): Promise<void> {
    await this.db.query(
      `UPDATE daily_forecasts SET status = 'failed', error_code = $2 WHERE id = $1`,
      [id, errorCode],
    );
  }

  /** Стоимость пишется сразу после вызова: провал тоже стоит денег. */
  async addCost(id: string, costRub: number): Promise<void> {
    await this.db.query(
      `UPDATE daily_forecasts SET cost_rub = cost_rub + $2::numeric WHERE id = $1`,
      [id, costRub],
    );
  }

  /** Расходы на прогнозы за 30 дней — для месячного потолка. */
  async monthCostRub(): Promise<number> {
    const row = await this.db.queryOne<{ cost: string }>(
      `SELECT COALESCE(SUM(cost_rub), 0)::text AS cost
         FROM daily_forecasts
        WHERE created_at >= now() - interval '30 days'`,
    );
    return Number(row?.cost ?? '0');
  }
}
