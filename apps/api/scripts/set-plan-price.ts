/**
 * Правка цены плана: `pnpm plans:set-price --code=compat_249 --stars=1`.
 *
 * Зачем скрипт, а не «руками в таблице»: владелец уже правил цену руками, и
 * получил три разных ответа (витрина, счёт, окно Telegram). Скрипт — один
 * безопасный путь:
 *   • работает только с существующей строкой (`plans` создаёт сид и миграция):
 *     опечатка в коде не заводит новый тариф;
 *   • проверяет значение: целое, 1..10000 (ноль и отрицательное запрещены
 *     самой схемой, но объяснить это человеку должен скрипт);
 *   • печатает «было → стало» и пишет строку `plan_price_changed` в stdout —
 *     у правки цены появляется след, которого не было;
 *   • тестовый тариф требует `PAYMENTS_TEST_PLANS=1`: в проде он не продаётся.
 *
 * Изменение действует на **новые** инвойсы. Уже выставленный счёт живёт по
 * снимку `invoices.stars` — см. `payments.md` §1.
 */
import path from 'node:path';
import { Pool } from 'pg';

/** Разумный диапазон цены в звёздах: 0 не бывает, 10 000 — уже абсурд. */
export const MIN_STARS = 1;
export const MAX_STARS = 10_000;

export interface SetPriceArgs {
  readonly code: string;
  readonly stars: number;
}

/** Разбор аргументов: `--code=… --stars=…` (или `--code …`). */
export function parseArgs(argv: readonly string[]): SetPriceArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      throw new Error(`неизвестный аргумент: ${arg}`);
    }
    const [flag, inline] = arg.slice(2).split('=', 2);
    if (flag === undefined || flag === '') {
      throw new Error(`неизвестный аргумент: ${arg}`);
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || value === '') {
      throw new Error(`у --${flag} нет значения`);
    }
    if (inline === undefined) {
      index += 1;
    }
    values.set(flag, value);
  }

  const code = values.get('code');
  const rawStars = values.get('stars');

  if (code === undefined || rawStars === undefined) {
    throw new Error('нужны оба аргумента: --code=<код плана> и --stars=<целое 1..10000>');
  }

  if (!/^\d+$/.test(rawStars)) {
    throw new Error(`--stars должен быть целым положительным числом, получено «${rawStars}»`);
  }

  const stars = Number(rawStars);
  if (!Number.isSafeInteger(stars) || stars < MIN_STARS || stars > MAX_STARS) {
    throw new Error(`--stars вне диапазона ${String(MIN_STARS)}..${String(MAX_STARS)}: ${rawStars}`);
  }

  return { code, stars };
}

export interface SetPriceResult {
  readonly code: string;
  readonly from: number;
  readonly to: number;
  readonly testOnly: boolean;
}

/**
 * Обновление цены в БД. Кода нет — ошибка, а не `INSERT`: создание тарифа —
 * только миграцией/сидом, чтобы опечатка не завела план.
 */
export async function setPlanPrice(
  pool: Pool,
  args: SetPriceArgs,
  options: { readonly testPlansEnabled: boolean },
): Promise<SetPriceResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const found = await client.query<{ stars: number; test_only: boolean; code: string }>(
      `SELECT code, stars, test_only FROM plans WHERE code = $1 FOR UPDATE`,
      [args.code],
    );
    const row = found.rows[0];

    if (row === undefined) {
      throw new Error(
        `плана «${args.code}» нет в таблице plans. Скрипт не создаёт тарифы: новый план — только миграцией`,
      );
    }

    if (row.test_only && !options.testPlansEnabled) {
      throw new Error(
        `«${args.code}» — тестовый тариф, а PAYMENTS_TEST_PLANS не включён: в проде он не продаётся`,
      );
    }

    if (row.stars === args.stars) {
      await client.query('COMMIT');
      return { code: args.code, from: row.stars, to: args.stars, testOnly: row.test_only };
    }

    await client.query(`UPDATE plans SET stars = $2, updated_at = now() WHERE code = $1`, [
      args.code,
      args.stars,
    ]);
    await client.query('COMMIT');

    return { code: args.code, from: row.stars, to: args.stars, testOnly: row.test_only };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL не задан: скрипт правит цену в базе, а не в файле');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await setPlanPrice(pool, args, {
      testPlansEnabled: process.env['PAYMENTS_TEST_PLANS'] === '1',
    });

    process.stdout.write(`${result.code}: было ${String(result.from)} ⭐ → стало ${String(result.to)} ⭐\n`);
    if (result.testOnly) {
      process.stdout.write('это тестовый тариф: он продаётся только при PAYMENTS_TEST_PLANS=1\n');
    }
    // След правки: без ПДн, только код плана и суммы. Новые инвойсы возьмут
    // новую цену; уже выставленные живут по снимку `invoices.stars`.
    process.stdout.write(
      `${JSON.stringify({
        event: 'plan_price_changed',
        plan: result.code,
        from: result.from,
        to: result.to,
      })}\n`,
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
