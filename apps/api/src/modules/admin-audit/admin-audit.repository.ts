import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';

/**
 * Чтение и запись `admin_audit` (итерация 40).
 *
 * Запись всегда идёт через уже открытую транзакцию: журнал и изменение —
 * одна атомарная операция. Репозиторий поэтому не открывает свою транзакцию
 * никогда — иначе «аудит записан, действие отвалилось» стало бы возможным.
 */

export interface AdminAuditRow {
  readonly id: string;
  readonly at: Date;
  readonly actor_tg_id: string;
  readonly actor_name: string;
  readonly action: string;
  readonly entity: string;
  readonly entity_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly request_id: string | null;
}

export interface AdminAuditInsert {
  readonly actorTgId: bigint;
  readonly actorName: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string | null;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly reason?: string | null;
  readonly requestId?: string | null;
}

export interface AdminAuditFilters {
  readonly entity?: string;
  readonly entityId?: string;
  readonly action?: string;
  readonly actorTgId?: bigint;
  readonly limit: number;
  /** Курсор `(at, id)` последней строки предыдущей страницы. */
  readonly cursor?: { readonly at: Date; readonly id: string };
}

/** `bigint` из `pg` приходит строкой: jsonb-поля — объектами. */
const SELECT_COLUMNS = `id, at, actor_tg_id, actor_name, action, entity, entity_id,
                       before, after, reason, request_id`;

@Injectable()
export class AdminAuditRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async insert(client: PoolClient, entry: AdminAuditInsert): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO admin_audit
         (actor_tg_id, actor_name, action, entity, entity_id, before, after, reason, request_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING id`,
      [
        entry.actorTgId.toString(),
        entry.actorName,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
        entry.reason ?? null,
        entry.requestId ?? null,
      ],
    );

    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error('admin_audit insert вернул пустой id');
    }
    return id;
  }

  /**
   * Страница журнала: `at DESC, id DESC` и курсор `(at, id)`.
   *
   * Сравнение кортежем, а не `at < $cursor`: события в одну микросекунду
   * случаются (выход и вход в соседних вкладках), и `at <` потерял бы часть
   * строк между страницами. `id` разрешает ничью однозначно.
   */
  async list(filters: AdminAuditFilters): Promise<readonly AdminAuditRow[]> {
    const params: unknown[] = [];
    const where: string[] = [];

    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.entity !== undefined) {
      where.push(`entity = ${push(filters.entity)}`);
    }
    if (filters.entityId !== undefined) {
      where.push(`entity_id = ${push(filters.entityId)}`);
    }
    if (filters.action !== undefined) {
      where.push(`action = ${push(filters.action)}`);
    }
    if (filters.actorTgId !== undefined) {
      where.push(`actor_tg_id = ${push(filters.actorTgId.toString())}`);
    }
    if (filters.cursor !== undefined) {
      where.push(`(at, id) < (${push(filters.cursor.at)}, ${push(filters.cursor.id)})`);
    }

    const limit = push(filters.limit);
    const sql = `SELECT ${SELECT_COLUMNS}
                   FROM admin_audit
                  ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
                  ORDER BY at DESC, id DESC
                  LIMIT ${limit}`;

    return this.db.query<AdminAuditRow>(sql, params);
  }

  /** Метрики `admin_logins_24h` и `admin_audit_writes_24h` — один запрос. */
  async totals24h(): Promise<{ readonly logins: number; readonly writes: number }> {
    const row = await this.db.queryOne<{ logins: string; writes: string }>(
      `SELECT count(*) FILTER (WHERE action = 'session.login') AS logins,
              count(*) AS writes
         FROM admin_audit
        WHERE at > now() - interval '24 hours'`,
    );

    return { logins: Number(row?.logins ?? 0), writes: Number(row?.writes ?? 0) };
  }

  /**
   * Сколько сессий убрал джоб за сутки. Считается по записям самого джоба
   * (`session.purge`, `after.purged`): отдельный счётчик в памяти процесса
   * обнулялся бы при каждом рестарте и врал бы на дежурстве.
   */
  async purged24h(): Promise<number> {
    const row = await this.db.queryOne<{ purged: string | null }>(
      `SELECT COALESCE(SUM((after->>'purged')::int), 0) AS purged
         FROM admin_audit
        WHERE action = 'session.purge'
          AND at > now() - interval '24 hours'`,
    );

    return Number(row?.purged ?? 0);
  }
}
