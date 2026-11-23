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
 *   3. **синхронизирует тестовые тарифы** с сидом: у `test_1` период,
 *      `invoice_title` и тексты — фикстура для проверки оплаты, а не данные
 *      владельца. Без этого стенд, где `test_1` когда-то создался недельным,
 *      оставался недельным навсегда: `ON CONFLICT DO NOTHING` не обновляет
 *      существующую строку, и тестовая оплата не выставлялась вовсе
 *      (итерация 26, задача 2). Цена и `is_active` не трогаются и здесь;
 *   4. тестовые тарифы вставляет только при `PAYMENTS_TEST_PLANS=1` и не в
 *      проде: строка `is_active = false` не продаётся, а в прод-базе её не
 *      должно быть вовсе.
 */
export interface SeedPlansResult {
  readonly inserted: number;
  readonly backfilled: number;
  /** Тестовые строки, приведённые к сиду (период, название счёта, тексты). */
  readonly syncedTestPlans: number;
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
    let syncedTestPlans = 0;

    for (const plan of PLAN_SEED) {
      if (plan.testOnly && !includeTestPlans) {
        continue;
      }

      const insertedRow = await client.query(
        `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds,
                            title, invoice_title, description, price_label, paywall_title,
                            paywall_subtitle, grants, sort, is_active, test_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [
          plan.code,
          plan.kind,
          plan.subscriptionPlan,
          plan.stars,
          plan.periodSeconds,
          plan.title,
          plan.invoiceTitle,
          plan.description,
          plan.priceLabel,
          plan.paywallTitle,
          plan.paywallSubtitle,
          grantsJson(plan),
          plan.sort,
          // Тестовый тариф лежит в таблице только потому, что на неё ссылаются
          // инвойсы и платежи; в каталоге он неактивен. Цена основателя — тоже
          // вне витрины: её продают только человеку из первых 50, и решает это
          // сервер, а не список планов в приложении.
          !plan.testOnly && plan.founderOnly !== true,
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

      // Тестовый тариф — фикстура, а не данные владельца: период, название
      // счёта и тексты приводим к сиду при каждом прогоне. Иначе стенд, где
      // `test_1` создался недельным, никогда не станет тридцатидневным, и
      // «тестовая оплата» не выставляется (Bot API принимает только 2 592 000).
      // Цена основателя обязана быть неактивной всегда: это не «данные
      // владельца», а правило витрины. Если строку когда-то создали активной
      // (или владелец включил её руками), витрина показала бы `founder_month`
      // всем — то есть скидку, которую нельзя получить.
      if (plan.founderOnly === true) {
        const hidden = await client.query(
          `UPDATE plans
              SET is_active = false, updated_at = now()
            WHERE code = $1 AND is_active
            RETURNING code`,
          [plan.code],
        );

        if (hidden.rowCount === 1) {
          backfilled += 1;
        }
      }

      if (plan.testOnly) {
        const synced = await client.query(
          `UPDATE plans
              SET period_seconds   = $2,
                  invoice_title    = $3,
                  description      = $4,
                  paywall_subtitle = $5,
                  updated_at       = now()
            WHERE code = $1
              AND (period_seconds IS DISTINCT FROM $2
                OR invoice_title IS DISTINCT FROM $3
                OR description IS DISTINCT FROM $4
                OR paywall_subtitle IS DISTINCT FROM $5)
            RETURNING code`,
          [plan.code, plan.periodSeconds, plan.invoiceTitle, plan.description, plan.paywallSubtitle],
        );

        if (synced.rowCount === 1) {
          syncedTestPlans += 1;
        }
      }
    }

    await client.query('COMMIT');
    return { inserted, backfilled, syncedTestPlans };
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
        `, тестовых строк приведено к сиду ${String(result.syncedTestPlans)}` +
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
