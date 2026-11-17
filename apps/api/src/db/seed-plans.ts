import path from 'node:path';
import { Pool } from 'pg';
import { PLAN_SEED, testPlansAllowed, type PlanSeedRow } from './plans-seed';

/**
 * Сид таблицы `plans` из `plans-seed.ts`.
 *
 * Итерация 23 (дополнение): `plans` — единственный источник цен, поэтому сид
 * больше **не перезаписывает** цены. Владелец правит цену через
 * `pnpm plans:set-price --code=… --stars=…`, и повторный `db:seed` на деплое
 * обязан эту правку сохранить — иначе «поменял цену» снова означало бы «до
 * следующего релиза».
 *
 * Что делает:
 *   1. вставляет отсутствующие строки каталога (полные значения);
 *   2. дозаполняет тексты и права там, где они пустые (миграция 0025 добавила
 *      колонки с `''` и `'{}'`) — но не трогает `stars`;
 *   3. тестовые тарифы вставляет только при `PAYMENTS_TEST_PLANS=1` и не в
 *      проде: строка `is_active = false` не продаётся, а в прод-базе её не
 *      должно быть вовсе.
 */
export interface SeedPlansResult {
  readonly inserted: number;
  readonly backfilled: number;
}

function grantsJson(row: PlanSeedRow): string {
  return JSON.stringify(row.grants);
}

export async function seedPlans(
  pool: Pool,
  options: { readonly includeTestPlans?: boolean } = {},
): Promise<SeedPlansResult> {
  const client = await pool.connect();
  const includeTestPlans = options.includeTestPlans ?? false;

  try {
    await client.query('BEGIN');
    let inserted = 0;
    let backfilled = 0;

    for (const plan of PLAN_SEED) {
      if (plan.testOnly && !includeTestPlans) {
        continue;
      }

      const insertedRow = await client.query(
        `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds,
                            title, description, price_label, paywall_title,
                            paywall_subtitle, grants, sort, is_active, test_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [
          plan.code,
          plan.kind,
          plan.subscriptionPlan,
          plan.stars,
          plan.periodSeconds,
          plan.title,
          plan.description,
          plan.priceLabel,
          plan.paywallTitle,
          plan.paywallSubtitle,
          grantsJson(plan),
          plan.sort,
          // Тестовый тариф лежит в таблице только потому, что на неё ссылаются
          // инвойсы и платежи; в каталоге он неактивен.
          !plan.testOnly,
          plan.testOnly,
        ],
      );

      if (insertedRow.rowCount === 1) {
        inserted += 1;
        continue;
      }

      // Строка уже есть: трогаем только пустые тексты и права. `stars`,
      // `is_active` и `sort` — данные владельца, сид их не переписывает.
      const updated = await client.query(
        `UPDATE plans
            SET paywall_title    = CASE WHEN paywall_title = '' THEN $2 ELSE paywall_title END,
                paywall_subtitle = CASE WHEN paywall_subtitle = '' THEN $3 ELSE paywall_subtitle END,
                grants           = CASE WHEN grants = '{}'::jsonb THEN $4::jsonb ELSE grants END,
                updated_at       = now()
          WHERE code = $1
            AND (paywall_title = '' OR paywall_subtitle = '' OR grants = '{}'::jsonb)
          RETURNING code`,
        [plan.code, plan.paywallTitle, plan.paywallSubtitle, grantsJson(plan)],
      );

      if (updated.rowCount === 1) {
        backfilled += 1;
      }
    }

    await client.query('COMMIT');
    return { inserted, backfilled };
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

  // Тестовые тарифы кладём только на стенде и только по флагу: в прод-базе их
  // не должно быть вовсе, даже неактивными.
  const includeTestPlans = testPlansAllowed(
    { NODE_ENV: process.env['NODE_ENV'] },
    process.env['PAYMENTS_TEST_PLANS'] === '1',
  );

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await seedPlans(pool, { includeTestPlans });
    process.stdout.write(
      `plans: добавлено ${String(result.inserted)}, дозаполнено текстов ${String(result.backfilled)}` +
        `${includeTestPlans ? ' (тестовые тарифы включены)' : ' (тестовые тарифы не создаются)'}\n`,
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
