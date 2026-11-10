import { Pool } from 'pg';
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate';
import { seedPlans } from '../src/db/seed-plans';
import { applyTestEnv, TEST_DATABASE_URL } from './test-env';

/** Перед прогоном: чистая тестовая БД со свежей схемой и планами. */
export async function setup(): Promise<void> {
  applyTestEnv();

  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await runMigrations(pool, resolveMigrationsDir(), () => undefined);
    await seedPlans(pool);
  } finally {
    await pool.end();
  }
}

/** После прогона соединения закрываются воркерами, здесь — только страховка. */
export async function teardown(): Promise<void> {
  // Ничего не удаляем: схема переиспользуется, данные чистятся в каждом тесте.
}
