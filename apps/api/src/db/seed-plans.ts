import path from 'node:path';
import { Pool } from 'pg';
import { PLANS } from '@astro-soul/shared';

/**
 * Синхронизация таблицы `plans` с packages/shared/src/plans.ts
 * (payments.md §1: цены живут в одном месте и зеркалятся в БД).
 * Идемпотентно: можно запускать на каждом деплое.
 */
export async function seedPlans(pool: Pool): Promise<number> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const plan of Object.values(PLANS)) {
      await client.query(
        `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds,
                            title, description, price_label, sort, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (code) DO UPDATE SET
           kind = EXCLUDED.kind,
           subscription_plan = EXCLUDED.subscription_plan,
           stars = EXCLUDED.stars,
           period_seconds = EXCLUDED.period_seconds,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           price_label = EXCLUDED.price_label,
           sort = EXCLUDED.sort,
           is_active = true,
           updated_at = now()`,
        [
          plan.code,
          plan.kind,
          plan.subscriptionPlan,
          plan.stars,
          plan.periodSeconds,
          plan.title,
          plan.description,
          plan.priceLabel,
          plan.sort,
        ],
      );
    }
    await client.query('COMMIT');
    return Object.keys(PLANS).length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
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
    const count = await seedPlans(pool);
    process.stdout.write(`plans синхронизированы: ${count}\n`);
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
