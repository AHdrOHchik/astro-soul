/**
 * `pnpm payments:diagnose` — один ответ на вопрос «почему оплата не проходит».
 *
 * Зачем: итерация 25 началась с блокера «модал открывается, после лоадера —
 * ошибка оплаты», и выяснить причину можно было только руками: `getWebhookInfo`
 * в браузере, логи бота, состояние `invoices`/`payments` в psql, размеры
 * названий тарифов... Пять фактов собирались в пяти местах, и ни один из них
 * не был обязательным. Скрипт собирает их за один запуск.
 *
 * Что печатает:
 *   1. **Бот** — `getMe`: id и username. Счёт может подтвердить только бот,
 *      создавший ссылку; токен в `.env` мог остаться от другого бота.
 *   2. **Вебхук** — `getWebhookInfo` + адрес, собранный из `MINI_APP_URL` и
 *      `TELEGRAM_WEBHOOK_SECRET`, + вердикт: доставляются ли апдейты.
 *   3. **Каталог** — проходит ли каждый тариф лимиты Bot API (название ≤ 32
 *      символов, период подписки = 2 592 000). Это проверка без сети.
 *   4. **Периоды** (`--periods`) — живой `createInvoiceLink` на каждый период:
 *      какие Telegram принимает. Один вызов на тариф, счета не создаются.
 *   5. **Деньги** — счета по статусам, платежи за 24 часа, зависшие платежи,
 *      последние события `pre_checkout_*` / `payment_*` и последние отказы.
 *
 * Режимы:
 *   --json        машиночитаемый вывод (для отчёта и CI-артефакта);
 *   --periods     сделать живые вызовы `createInvoiceLink` по периодам;
 *   --set-webhook перерегистрировать вебхук (по умолчанию только проверка);
 *   --no-db       не ходить в БД (когда нужен только транспорт).
 *
 * Ничего не меняет, кроме `--set-webhook`: по умолчанию это **чтение**.
 */
import path from 'node:path';
import { Pool } from 'pg';
import { loadEnv, type AppEnv } from '../src/config/env';
import { JsonLogger } from '../src/common/logger';
import { TelegramClient } from '../src/modules/telegram/telegram.client';
import { TelegramWebhookService } from '../src/modules/telegram/telegram-webhook.service';
import {
  XTR_SUBSCRIPTION_PERIOD_SECONDS,
  invoiceParamsViolation,
  subscriptionPeriodSupported,
} from '../src/modules/telegram/invoice-params';
import { DbService } from '../src/db/db.service';

export interface DiagnoseOptions {
  readonly json: boolean;
  readonly periods: boolean;
  readonly setWebhook: boolean;
  readonly db: boolean;
}

export function parseArgs(argv: readonly string[]): DiagnoseOptions {
  const options = { json: false, periods: false, setWebhook: false, db: true };

  // Флаги складываются, а не «первый победил»: `--periods --json` должен дать
  // и живую проверку, и машиночитаемый ответ.
  for (const arg of argv) {
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--periods':
        options.periods = true;
        break;
      case '--set-webhook':
        options.setWebhook = true;
        break;
      case '--no-db':
        options.db = false;
        break;
      default:
        throw new Error(`неизвестный аргумент: ${arg}`);
    }
  }

  return options;
}

interface CatalogueRow {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly price_label: string;
  readonly stars: number;
  readonly kind: 'one_off' | 'subscription';
  readonly period_seconds: number | null;
}

interface MoneyFacts {
  readonly invoices_24h: readonly { status: string; total: number }[];
  readonly payments_24h: readonly { status: string; total: number }[];
  readonly pending_payments_now: number;
  readonly pre_checkout_events: readonly { name: string; total: number }[];
  readonly last_rejections: readonly { reason: string | null; total: number }[];
  readonly last_events: readonly { name: string; created_at: string; props: unknown }[];
}

interface PeriodProbe {
  readonly code: string;
  readonly period_seconds: number;
  readonly ok: boolean;
  readonly status: number;
  readonly description: string | null;
}

export interface DiagnoseReport {
  readonly bot: {
    readonly reachable: boolean;
    readonly id: number | null;
    readonly username: string | null;
    readonly latency_ms: number | null;
    readonly error: string | null;
  };
  readonly webhook: {
    readonly state: string;
    readonly description: string;
    readonly expected_url_masked: string | null;
    readonly actual_url_masked: string | null;
    readonly pending_update_count: number;
    readonly last_error_message: string | null;
    readonly last_error_date: string | null;
  };
  readonly catalogue: readonly {
    readonly code: string;
    readonly title_chars: number;
    readonly period_seconds: number | null;
    readonly problem: string | null;
    /**
     * `fail` — счёт не выставится вовсе (название/описание/payload вне лимита),
     * `warn` — платформа не принимает период тарифа, а что с тарифом делать,
     * решает владелец (`payments.md` §3.6). На код возврата влияет только `fail`.
     */
    readonly severity: 'fail' | 'warn' | null;
  }[];
  readonly periods: readonly PeriodProbe[] | null;
  readonly money: MoneyFacts | null;
}

/** Секрет в пути не печатаем целиком: последних четырёх символов хватает. */
function maskUrl(url: string): string {
  return url.replace(/webhook\/(.+)$/, (_match, secret: string) => `webhook/***${secret.slice(-4)}`);
}

function isoOrNull(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}

/**
 * Живой `createInvoiceLink` по каждому периоду подписки.
 *
 * Счета не создаются: payload черновой (`diagnose`), в БД ничего не пишется.
 * Нам нужен только ответ Bot API — принимает он этот `subscription_period` или
 * нет. Цена — 1 ⭐ (минимально допустимая), чтобы случайный платёж стоил копейку.
 */
async function probePeriods(
  client: TelegramClient,
  rows: readonly CatalogueRow[],
): Promise<readonly PeriodProbe[]> {
  const probes: PeriodProbe[] = [];

  for (const row of rows) {
    if (row.kind !== 'subscription' || row.period_seconds === null) {
      continue;
    }

    const answer = await client.safeCall<string>('createInvoiceLink', {
      title: row.title.slice(0, 32),
      description: row.description.slice(0, 255),
      payload: 'diagnose',
      currency: 'XTR',
      prices: [{ label: 'diagnose', amount: 1 }],
      subscription_period: row.period_seconds,
    });

    probes.push({
      code: row.code,
      period_seconds: row.period_seconds,
      ok: answer.ok,
      status: answer.status,
      description: answer.description,
    });
  }

  return probes;
}

async function readMoneyFacts(db: DbService): Promise<MoneyFacts> {
  const [invoices, payments, pending, events, rejections, lastEvents] = await Promise.all([
    db.query<{ status: string; total: number }>(
      `SELECT status, count(*)::int AS total FROM invoices
        WHERE created_at >= now() - interval '24 hours' GROUP BY status ORDER BY status`,
    ),
    db.query<{ status: string; total: number }>(
      `SELECT status, count(*)::int AS total FROM payments
        WHERE created_at >= now() - interval '24 hours' GROUP BY status ORDER BY status`,
    ),
    db.queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM payments WHERE processed = false AND status = 'paid'`,
    ),
    db.query<{ name: string; total: number }>(
      `SELECT name, count(*)::int AS total FROM events
        WHERE name IN ('pre_checkout_received', 'pre_checkout_rejected', 'pre_checkout_timeout',
                       'payment_processed', 'subscription_renewed', 'payment_rejected')
          AND COALESCE(occurred_at, created_at) >= now() - interval '24 hours'
        GROUP BY name ORDER BY name`,
    ),
    db.query<{ reason: string | null; total: number }>(
      `SELECT reject_reason AS reason, count(*)::int AS total FROM payments
        WHERE status = 'rejected' AND created_at >= now() - interval '7 days'
        GROUP BY reject_reason ORDER BY total DESC LIMIT 5`,
    ),
    db.query<{ name: string; created_at: string; props: unknown }>(
      `SELECT name, created_at::text, props FROM events
        WHERE name LIKE 'pre\\_checkout%' OR name LIKE 'payment\\_%'
        ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT 10`,
    ),
  ]);

  return {
    invoices_24h: invoices,
    payments_24h: payments,
    pending_payments_now: pending?.total ?? 0,
    pre_checkout_events: events,
    last_rejections: rejections,
    last_events: lastEvents,
  };
}

export async function diagnose(options: DiagnoseOptions, env: AppEnv = loadEnv()): Promise<DiagnoseReport> {
  const logger = new JsonLogger('error');
  const client = new TelegramClient(env, logger);
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const db = new DbService(pool);

  try {
    const startedAt = Date.now();
    const me = await client.getMe();
    const latency = me.reachable ? Date.now() - startedAt : null;

    // Проверяем вебхук тем же кодом, что и старт API. `--set-webhook` — единственное,
    // что вообще меняет состояние; без него режим «только чтение».
    const webhookEnv: AppEnv = options.setWebhook ? env : { ...env, TELEGRAM_WEBHOOK_AUTO: '0' };
    const webhookService = new TelegramWebhookService(client, webhookEnv, logger);
    const webhook = await webhookService.ensureRegistered();

    const catalogueRows = await db.query<CatalogueRow>(
      `SELECT code, title, description, price_label, stars, kind, period_seconds
         FROM plans ORDER BY sort`,
    );

    const catalogue = catalogueRows.map((row) => {
      // Всё, что мы можем проверить без сети: лимиты Bot API на параметры
      // счёта и период звёздной подписки.
      const violation = invoiceParamsViolation({
        title: row.title,
        description: row.description,
        payload: 'diagnose',
        prices: [{ label: row.price_label, amount: row.stars }],
      });

      if (violation !== null) {
        return {
          code: row.code,
          title_chars: [...row.title].length,
          period_seconds: row.period_seconds,
          problem: `${violation.field}: ${String(violation.actual)} > лимита ${String(violation.limit)}`,
          severity: 'fail' as const,
        };
      }

      if (!subscriptionPeriodSupported(row.period_seconds)) {
        return {
          code: row.code,
          title_chars: [...row.title].length,
          period_seconds: row.period_seconds,
          problem: `subscription_period ${String(row.period_seconds)} ≠ ${String(XTR_SUBSCRIPTION_PERIOD_SECONDS)}: Telegram отклонит счёт`,
          severity: 'warn' as const,
        };
      }

      return {
        code: row.code,
        title_chars: [...row.title].length,
        period_seconds: row.period_seconds,
        problem: null,
        severity: null,
      };
    });

    const periods = options.periods ? await probePeriods(client, catalogueRows) : null;
    const money = options.db ? await readMoneyFacts(db) : null;

    return {
      bot: {
        reachable: me.reachable,
        id: me.result?.id ?? null,
        username: me.result?.username ?? null,
        latency_ms: latency,
        error: me.reachable ? (me.ok ? null : me.description) : 'unreachable',
      },
      webhook: {
        state: webhook.state,
        description: webhookService.describe(webhook),
        expected_url_masked: webhook.expectedUrl === null ? null : maskUrl(webhook.expectedUrl),
        actual_url_masked: webhook.actualUrl === null ? null : maskUrl(webhook.actualUrl),
        pending_update_count: webhook.pendingUpdateCount,
        last_error_message: webhook.lastErrorMessage,
        last_error_date: isoOrNull(webhook.lastErrorDate),
      },
      catalogue,
      periods,
      money,
    };
  } finally {
    await pool.end();
  }
}

/** Человекочитаемый вывод: сначала вердикт, потом факты. */
export function formatReport(report: DiagnoseReport): string {
  const lines: string[] = [];

  lines.push('Бот');
  lines.push(
    report.bot.reachable
      ? `  id=${String(report.bot.id)} @${report.bot.username ?? '—'}  ответ ${String(report.bot.latency_ms)} мс`
      : `  НЕДОСТУПЕН: ${report.bot.error ?? 'unknown'}`,
  );

  lines.push('');
  lines.push('Вебхук');
  lines.push(`  ${report.webhook.state}: ${report.webhook.description}`);
  lines.push(`  ожидается: ${report.webhook.expected_url_masked ?? '—'}`);
  lines.push(`  зарегистрирован: ${report.webhook.actual_url_masked ?? '—'}`);
  lines.push(`  в очереди: ${String(report.webhook.pending_update_count)}`);
  if (report.webhook.last_error_message !== null) {
    lines.push(
      `  последняя ошибка доставки: ${report.webhook.last_error_message} (${report.webhook.last_error_date ?? '—'})`,
    );
  }

  lines.push('');
  lines.push('Каталог и лимиты Bot API');
  for (const row of report.catalogue) {
    const mark = row.severity === 'fail' ? '✗' : row.severity === 'warn' ? '!' : ' ';
    lines.push(
      `  ${mark} ${row.code.padEnd(14)} title=${String(row.title_chars).padStart(2)}  period=${String(row.period_seconds ?? '—').padStart(9)}  ${row.problem ?? 'ok'}`,
    );
  }

  if (report.periods !== null) {
    lines.push('');
    lines.push('Живая проверка периодов (createInvoiceLink, 1 ⭐, без записи в БД)');
    for (const probe of report.periods) {
      lines.push(
        `  ${probe.code.padEnd(14)} period=${String(probe.period_seconds).padStart(9)}  → ${probe.ok ? 'ok' : `HTTP ${String(probe.status)}: ${probe.description ?? '—'}`}`,
      );
    }
  }

  if (report.money !== null) {
    lines.push('');
    lines.push('Деньги за 24 часа');
    lines.push(
      `  счета: ${report.money.invoices_24h.map((row) => `${row.status}=${String(row.total)}`).join(' ') || 'нет'}`,
    );
    lines.push(
      `  платежи: ${report.money.payments_24h.map((row) => `${row.status}=${String(row.total)}`).join(' ') || 'нет'}`,
    );
    lines.push(`  зависшие (paid, не выданы): ${String(report.money.pending_payments_now)}`);
    lines.push(
      `  события: ${report.money.pre_checkout_events.map((row) => `${row.name}=${String(row.total)}`).join(' ') || 'нет'}`,
    );
    if (report.money.last_rejections.length > 0) {
      lines.push(
        `  отказы за 7 дней: ${report.money.last_rejections.map((row) => `${row.reason ?? '—'}=${String(row.total)}`).join(' ')}`,
      );
    }
    if (report.money.last_events.length > 0) {
      lines.push('  последние события:');
      for (const event of report.money.last_events) {
        lines.push(`    ${event.created_at} ${event.name}`);
      }
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await diagnose(options);

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);

  // Код возврата: 0 — доставка и параметры счетов в порядке; 1 — есть что
  // чинить. Период тарифа, который Telegram не принимает, — исключение: это
  // ожидаемое состояние до решения владельца (`payments.md` §3.6), и валить
  // из-за него весь диагностический прогон значило бы приучить игнорировать
  // ненулевой код.
  const broken =
    !report.bot.reachable ||
    report.webhook.state === 'unreachable' ||
    report.webhook.state === 'not_configured' ||
    report.webhook.state === 'failed' ||
    report.catalogue.some((row) => row.severity === 'fail') ||
    (report.periods ?? []).some((probe) => !probe.ok);

  process.exitCode = broken ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
