/**
 * Правка названия счёта: `pnpm plans:set-titles --code=month_399 --title="Подписка на месяц"`.
 *
 * Зачем скрипт, а не «руками в таблице»: название счёта — единственная строка
 * тарифа, которую видит Bot API, и у неё жёсткий лимит 1–32 символа. Длинное
 * название — это `400` от Telegram, `502` для человека и «оплата не проходит»
 * в поддержке (итерации 25–26). Скрипт:
 *   • меняет только `invoice_title` — `title` и `paywall_title` (витрина) не
 *     трогает вовсе: у них своя жизнь и свои лимиты;
 *   • валидирует длину по **символам** (кириллица в UTF-8 занимает два байта,
 *     но Bot API считает символы) и запрещает пустое название;
 *   • работает только с существующей строкой: новый тариф заводится
 *     миграцией и сидом, опечатка в коде не должна создавать план;
 *   • печатает «было → стало» и строку `plan_invoice_title_changed` — у правки
 *     появляется след, которого в таблице нет;
 *   • тестовый тариф требует `PAYMENTS_TEST_PLANS=1` — как `plans:set-price`.
 *
 * Изменение действует на **новые** счета. Уже выставленный счёт живёт по своей
 * ссылке: `invoice_link` в `invoices` не пересоздаётся.
 */
import path from 'node:path';
import { Pool } from 'pg';

/** Лимит Bot API на `createInvoiceLink.title`, в символах. */
export const INVOICE_TITLE_MIN_CHARS = 1;
export const INVOICE_TITLE_MAX_CHARS = 32;

export interface SetTitlesArgs {
  readonly code: string;
  readonly title: string;
}

/** Длина в символах, как её считает Bot API (а не в байтах UTF-8). */
export function charsLength(value: string): number {
  return [...value].length;
}

/**
 * Подсказка «как сократить»: режем по границе слова, чтобы предложение не
 * обрывалось на «подписка на ме». Если границы нет — просто по лимиту.
 */
export function suggestShorter(title: string): string {
  const chars = [...title.trim()];

  if (chars.length <= INVOICE_TITLE_MAX_CHARS) {
    return chars.join('');
  }

  const head = chars.slice(0, INVOICE_TITLE_MAX_CHARS).join('');
  const cut = head.lastIndexOf(' ');

  return (cut > 0 ? head.slice(0, cut) : head).trim();
}

/** Проверка названия до похода в базу: то же правило, что и `CHECK` в схеме. */
export function validateInvoiceTitle(title: string): string {
  const trimmed = title.trim();
  const length = charsLength(trimmed);

  if (length < INVOICE_TITLE_MIN_CHARS) {
    throw new Error('название счёта не может быть пустым');
  }

  if (length > INVOICE_TITLE_MAX_CHARS) {
    throw new Error(
      `название счёта длиннее лимита Bot API: ${String(length)} символов при максимуме ${String(INVOICE_TITLE_MAX_CHARS)}. ` +
        `Сократи: «${trimmed}» → например «${suggestShorter(trimmed)}»`,
    );
  }

  return trimmed;
}

/** Разбор аргументов: `--code=… --title=…` (или `--code … --title …`). */
export function parseArgs(argv: readonly string[]): SetTitlesArgs {
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
  const title = values.get('title');

  if (code === undefined || title === undefined) {
    throw new Error('нужны оба аргумента: --code=<код плана> и --title=<название 1..32>');
  }

  return { code, title: validateInvoiceTitle(title) };
}

export interface SetTitlesResult {
  readonly code: string;
  readonly from: string | null;
  readonly to: string;
  readonly testOnly: boolean;
}

/**
 * Обновление названия счёта. Кода нет — ошибка, а не `INSERT`: создание
 * тарифа — только миграцией/сидом, чтобы опечатка не завела план.
 */
export async function setInvoiceTitle(
  pool: Pool,
  args: SetTitlesArgs,
  options: { readonly testPlansEnabled: boolean },
): Promise<SetTitlesResult> {
  const title = validateInvoiceTitle(args.title);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const found = await client.query<{ invoice_title: string | null; test_only: boolean }>(
      `SELECT invoice_title, test_only FROM plans WHERE code = $1 FOR UPDATE`,
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

    if (row.invoice_title === title) {
      await client.query('COMMIT');
      return { code: args.code, from: row.invoice_title, to: title, testOnly: row.test_only };
    }

    await client.query(`UPDATE plans SET invoice_title = $2, updated_at = now() WHERE code = $1`, [
      args.code,
      title,
    ]);
    await client.query('COMMIT');

    return { code: args.code, from: row.invoice_title, to: title, testOnly: row.test_only };
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
    throw new Error('DATABASE_URL не задан: скрипт правит название в базе, а не в файле');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await setInvoiceTitle(pool, args, {
      testPlansEnabled: process.env['PAYMENTS_TEST_PLANS'] === '1',
    });

    process.stdout.write(
      result.from === result.to
        ? `${result.code}: название счёта уже «${result.to}» (${String(charsLength(result.to))} символов) — без изменений\n`
        : `${result.code}: название счёта «${result.from ?? '—'}» → «${result.to}» (${String(charsLength(result.to))} символов)\n`,
    );
    if (result.testOnly) {
      process.stdout.write('это тестовый тариф: он продаётся только при PAYMENTS_TEST_PLANS=1\n');
    }
    // След правки: без ПДн, только код и названия. Новые счета возьмут новое
    // название; уже выставленные живут по своей ссылке.
    process.stdout.write(
      `${JSON.stringify({
        event: 'plan_invoice_title_changed',
        plan: result.code,
        from: result.from,
        to: result.to,
        chars: charsLength(result.to),
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
