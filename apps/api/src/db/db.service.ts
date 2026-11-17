import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { AppEnv } from '../config/env';
import { withDeadline } from '../common/deadline';

export const PG_POOL = Symbol('PG_POOL');

export type Sql = string;
export type SqlParams = readonly unknown[];

@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * `timeoutMs` — сколько вызывающий готов ждать **этот** запрос.
   *
   * Нужен платёжным обработчикам: у пула `statement_timeout` 10 с, а
   * `pre_checkout_query` обязан ответить Telegram за 10 с целиком — читать
   * счёт дольше 2 с бессмысленно, ответ всё равно опоздает.
   *
   * Реализация — гонка, а не отмена: node-postgres не умеет отменять запрос по
   * таймеру. Соединение освободится, когда сработает `statement_timeout` пула;
   * для нас важно, что вызывающий не ждёт и успевает ответить.
   */
  async query<T extends QueryResultRow>(
    sql: Sql,
    params: SqlParams = [],
    options: { readonly timeoutMs?: number } = {},
  ): Promise<T[]> {
    const work = this.pool.query<T>(sql, [...params]);

    if (options.timeoutMs === undefined) {
      const result = await work;
      return result.rows;
    }

    const result = await withDeadline(work, options.timeoutMs);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow>(
    sql: Sql,
    params: SqlParams = [],
    options: { readonly timeoutMs?: number } = {},
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params, options);
    return rows[0] ?? null;
  }

  /**
   * Транзакция с обязательным rollback при любой ошибке.
   * Платёжные обработчики обязаны работать только через неё (payments.md §3.2).
   */
  async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Для `/health`: доступна ли БД прямо сейчас. */
  /**
   * Сессионная advisory-блокировка на время длинной работы (джобы удержания).
   *
   * `withTransaction` здесь не годится: ночная генерация держит транзакцию
   * минутами и блокирует вакуум. Соединение берём из пула на весь прогон,
   * блокировку снимаем в `finally` — если процесс упадёт, её отпустит сервер.
   *
   * `null` — блокировку уже держит другой экземпляр крона: это не ошибка.
   */
  async withAdvisoryLock<T>(key: number, handler: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      const taken = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      if (taken.rows[0]?.locked !== true) {
        return null;
      }
      try {
        return await handler();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgPool(env: Pick<AppEnv, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // p95 без LLM ≤ 400 мс (SPEC): зависший запрос не должен съедать пул
    statement_timeout: 10_000,
    application_name: 'astro-soul-api',
  });
}
