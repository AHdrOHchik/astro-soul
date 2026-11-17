import { Pool } from 'pg';
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate';
import { seedPlans } from '../src/db/seed-plans';
import { checkTestDatabase } from '../scripts/check-test-db';
import { applyTestEnv, TEST_DATABASE_URL } from './test-env';

/** Перед прогоном: чистая тестовая БД со свежей схемой и планами. */
export async function setup(): Promise<void> {
  applyTestEnv();

  // Та же проверка, что и в `pnpm test`, но и здесь: vitest можно запустить
  // напрямую, и тогда без неё прогон падал на «No test files found».
  const problem = await checkTestDatabase();
  if (problem !== null) {
    throw new Error(problem);
  }

  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await runMigrations(pool, resolveMigrationsDir(), () => undefined);
    // Тестовые тарифы нужны тестам (`test-plans.spec.ts`), но только здесь:
    // в прод-базу сид их не кладёт.
    await seedPlans(pool, { includeTestPlans: true });
  } finally {
    await pool.end();
  }
}

/** После прогона соединения закрываются воркерами, здесь — только страховка. */
export async function teardown(): Promise<void> {
  // Ничего не удаляем: схема переиспользуется, данные чистятся в каждом тесте.
}
