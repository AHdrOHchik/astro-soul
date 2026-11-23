import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';

/**
 * Строки `admin_sessions`. Репозиторий ничего не решает про «годна/не годна»:
 * это правило сервиса. Здесь только SQL — и одна важная деталь: `insert`
 * принимает клиент транзакции, потому что вход пишет сессию и запись журнала
 * одной транзакцией.
 */

export interface AdminSessionRow {
  readonly id: string;
  readonly tg_id: string;
  readonly name: string;
  readonly csrf_token: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly last_seen_at: Date | null;
}

const SELECT_COLUMNS = `id, tg_id, name, csrf_token, created_at, expires_at, revoked_at, last_seen_at`;

export interface InsertSessionInput {
  readonly tgId: bigint;
  readonly name: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

@Injectable()
export class AdminSessionsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async insert(client: PoolClient, input: InsertSessionInput): Promise<AdminSessionRow> {
    const result = await client.query<AdminSessionRow>(
      `INSERT INTO admin_sessions (tg_id, name, csrf_token, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SELECT_COLUMNS}`,
      [input.tgId.toString(), input.name, input.csrfToken, input.expiresAt],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('admin_sessions insert вернул пустую строку');
    }
    return row;
  }

  findById(id: string): Promise<AdminSessionRow | null> {
    return this.db.queryOne<AdminSessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM admin_sessions WHERE id = $1`,
      [id],
    );
  }

  /**
   * `last_seen_at` — не чаще раза в минуту на сессию.
   *
   * Обновление на каждый запрос означало бы запись в базу на каждое открытие
   * экрана панели (и лишний WAL на ровном месте). `WHERE` с условием делает
   * «не чаще минуты» свойством запроса, а не памяти процесса: два экземпляра
   * API не будут спорить, кто обновлял последним.
   */
  async touch(id: string): Promise<void> {
    await this.db.query(
      `UPDATE admin_sessions
          SET last_seen_at = now()
        WHERE id = $1
          AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`,
      [id],
    );
  }

  /** Отзыв идемпотентен: повторный `logout` не двигает исходное время выхода. */
  async revoke(client: PoolClient, id: string): Promise<AdminSessionRow | null> {
    const result = await client.query<AdminSessionRow>(
      `UPDATE admin_sessions
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1
        RETURNING ${SELECT_COLUMNS}`,
      [id],
    );

    return result.rows[0] ?? null;
  }

  /** Уборка: `expires_at < now() - days`. Считает только удалённые строки. */
  async purgeExpired(olderThanDays: number, client?: PoolClient): Promise<number> {
    const sql = `WITH removed AS (
                   DELETE FROM admin_sessions
                    WHERE expires_at < now() - make_interval(days => $1)
                    RETURNING 1
                 )
                 SELECT count(*) AS purged FROM removed`;

    if (client !== undefined) {
      const result = await client.query<{ purged: string }>(sql, [olderThanDays]);
      return Number(result.rows[0]?.purged ?? 0);
    }

    const row = await this.db.queryOne<{ purged: string }>(sql, [olderThanDays]);
    return Number(row?.purged ?? 0);
  }

  /** `flags.admin_auth.sessions_active` в `/health`: живые сессии прямо сейчас. */
  async countActive(): Promise<number> {
    const row = await this.db.queryOne<{ active: string }>(
      `SELECT count(*) AS active
         FROM admin_sessions
        WHERE revoked_at IS NULL
          AND expires_at > now()`,
    );

    return Number(row?.active ?? 0);
  }
}
