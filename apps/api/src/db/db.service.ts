import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { AppEnv } from '../config/env';

export const PG_POOL = Symbol('PG_POOL');

export type Sql = string;
export type SqlParams = readonly unknown[];

@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async query<T extends QueryResultRow>(sql: Sql, params: SqlParams = []): Promise<T[]> {
    const result = await this.pool.query<T>(sql, [...params]);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow>(sql: Sql, params: SqlParams = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
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
