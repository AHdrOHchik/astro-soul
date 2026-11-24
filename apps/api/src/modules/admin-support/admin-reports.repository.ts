import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';

/**
 * Разборы глазами поддержки (контракт 1.6.16).
 *
 * В списке — идентификаторы, статус, код ошибки, стоимость и счётчик
 * перезапусков. Текста разбора и вопросов человека здесь нет: поддержке нужно
 * ответить «почему не собралось», а не читать чужой разбор.
 */
export interface AdminReportRow {
  readonly id: string;
  readonly user_id: string;
  readonly chart_id: string;
  readonly kind: string;
  readonly status: string;
  readonly error_code: string | null;
  /** `reports.attempts` — сколько попыток генерации уже было (не лимит). */
  readonly attempts: number;
  readonly llm_cost_rub: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface AdminReportFilter {
  readonly status: string | null;
  readonly kind: string | null;
  readonly userId: string | null;
  readonly limit: number;
}

const COLUMNS = `id::text AS id, user_id::text AS user_id, chart_id::text AS chart_id,
  kind::text AS kind, status::text AS status, error_code, attempts, llm_cost_rub::text,
  created_at, updated_at`;

@Injectable()
export class AdminReportsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Список с фильтрами. `LIMIT + 1` — чтобы отдать `truncated` без второго
   * `COUNT(*)` по `reports` (таблица растёт, а панели нужен первый экран).
   */
  async list(filter: AdminReportFilter): Promise<{ rows: readonly AdminReportRow[]; truncated: boolean }> {
    const rows = await this.db.query<AdminReportRow>(
      `SELECT ${COLUMNS}
         FROM reports
        WHERE ($1::text IS NULL OR status::text = $1)
          AND ($2::text IS NULL OR kind::text = $2)
          AND ($3::uuid IS NULL OR user_id = $3::uuid)
        ORDER BY updated_at DESC, id
        LIMIT $4`,
      [filter.status, filter.kind, filter.userId, filter.limit + 1],
    );

    return { rows: rows.slice(0, filter.limit), truncated: rows.length > filter.limit };
  }

  async byId(id: string): Promise<AdminReportRow | null> {
    return this.db.queryOne<AdminReportRow>(`SELECT ${COLUMNS} FROM reports WHERE id = $1`, [id]);
  }

  /**
   * Вернуть упавший разбор в очередь.
   *
   * `attempts` и лимит `MAX_ATTEMPTS` (`reports.service`) **не меняются**:
   * это счётчик попыток одной генерации, и перезапуск из панели не должен
   * ни обнулять его, ни обходить лимит. Меняются только `status`, `error_code`
   * и отметки времени — «разбор снова в очереди, ошибка забыта».
   *
   * Новых платежей не создаётся: перезапуск — это повтор уже оплаченной
   * работы, а не вторая покупка.
   */
  async requeue(
    client: PoolClient,
    id: string,
  ): Promise<AdminReportRow | null | 'not_failed'> {
    const current = await client.query<AdminReportRow>(
      `SELECT ${COLUMNS} FROM reports WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = current.rows[0];

    if (row === undefined) {
      return null;
    }

    if (row.status !== 'failed') {
      return 'not_failed';
    }

    const updated = await client.query<AdminReportRow>(
      `UPDATE reports
          SET status = 'queued',
              error_code = NULL,
              started_at = NULL,
              finished_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id],
    );

    return updated.rows[0] ?? null;
  }
}
