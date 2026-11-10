import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

/**
 * Накат миграций: обычные .sql-файлы из `migrations/`, без ORM.
 * Причины: миграции после мерджа неизменяемы (AGENTS.md §4), а SQL-файл
 * нельзя «случайно» перегенерировать, как это бывает с ORM-схемой.
 */

/** Фиксированный ключ advisory-лока: одновременно миграции катит только один процесс. */
export const MIGRATION_LOCK_ID = 918_273_645;

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: number;
}

/** Каталог `migrations/` в корне репозитория (рядом с pnpm-workspace.yaml). */
export function resolveMigrationsDir(startDir: string = __dirname): string {
  let current = startDir;

  for (let depth = 0; depth < 10; depth += 1) {
    const workspaceFile = path.join(current, 'pnpm-workspace.yaml');
    const migrationsDir = path.join(current, 'migrations');

    if (existsSync(workspaceFile) && existsSync(migrationsDir)) {
      return migrationsDir;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error('Не найден каталог migrations/ (ищу вверх от ' + startDir + ')');
}

async function readMigrations(dir: string): Promise<readonly { version: string; sql: string }[]> {
  const entries = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();

  if (entries.length === 0) {
    throw new Error(`В ${dir} нет файлов миграций`);
  }

  return Promise.all(
    entries.map(async (file) => ({
      version: path.basename(file, '.sql'),
      sql: await readFile(path.join(dir, file), 'utf8'),
    })),
  );
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function runMigrations(
  pool: Pool,
  dir: string,
  log: (message: string) => void = () => undefined,
): Promise<MigrationResult> {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((row) => [row.version, row.checksum]));

    const applied: string[] = [];
    let skipped = 0;

    for (const migration of migrations) {
      const digest = checksum(migration.sql);
      const previous = alreadyApplied.get(migration.version);

      if (previous !== undefined) {
        if (previous !== digest) {
          throw new Error(
            `Миграция ${migration.version} изменена после наката ` +
              `(checksum ${previous} → ${digest}). Изменять применённые миграции нельзя — добавь новую.`,
          );
        }
        skipped += 1;
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          migration.version,
          digest,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Миграция ${migration.version} не применилась: ` +
            (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }

      applied.push(migration.version);
      log(`применена ${migration.version}`);
    }

    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL не задан');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await runMigrations(pool, resolveMigrationsDir(), (message) =>
      process.stdout.write(message + '\n'),
    );
    process.stdout.write(
      `Готово: применено ${result.applied.length}, пропущено ${result.skipped}\n`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
