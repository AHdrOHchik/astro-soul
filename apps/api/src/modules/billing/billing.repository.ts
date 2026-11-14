import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PlanCode } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

export interface InvoiceRow {
  readonly id: string;
  readonly plan_code: PlanCode;
  readonly idem_key: string;
  readonly payload: string;
  readonly invoice_link: string;
  readonly status: 'created' | 'paid' | 'expired' | 'invalidated';
  readonly chart_id: string | null;
  readonly created_at: Date;
}

/**
 * Причины отказа по деньгам (QA-11 + QA-15).
 * Первые три — сверка платежа; `invoice_invalidated` и `user_deleted` —
 * оплата после удаления данных.
 */
export type RejectReason =
  | 'no_invoice'
  | 'amount_mismatch'
  | 'unknown_plan'
  | 'invoice_invalidated'
  | 'user_deleted';

export interface NewPayment {
  readonly userId: string | null;
  readonly telegramId: number | null;
  /** `null` допустим только у `rejected`: у неизвестного плана плана нет. */
  readonly planCode: PlanCode | null;
  readonly totalAmount: number;
  readonly currency: string;
  readonly chargeId: string;
  readonly providerChargeId: string | null;
  readonly invoicePayload: string;
  readonly subscriptionExpiresAt: Date | null;
}

export interface NewRejectedPayment extends NewPayment {
  readonly rejectReason: RejectReason;
}

/** Строка платежа в объёме, нужном для повторной сверки и выдачи доступа. */
export interface PaymentForResolution {
  readonly telegram_payment_charge_id: string;
  readonly telegram_id: string | null;
  readonly currency: string;
  readonly total_amount: number;
  readonly invoice_payload: string | null;
  readonly subscription_expires_at: Date | null;
  readonly provider_payment_charge_id: string | null;
  readonly status: string;
  readonly processed: boolean;
}

export interface GrantInput {
  readonly userId: string;
  readonly kind: 'report' | 'compat' | 'solar';
  readonly chartId: string | null;
  readonly partnerChartId: string | null;
  readonly paymentId: string;
}

/**
 * Все запросы биллинга. Методы, которые должны выполняться в одной транзакции,
 * принимают `PoolClient` первым аргументом — так порядок блокировок виден
 * в одном месте (payments.md §3.2).
 */
@Injectable()
export class BillingRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // --- инвойсы -------------------------------------------------------------

  async countInvoicesSince(userId: string, interval: string): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM invoices
        WHERE user_id = $1 AND created_at > now() - $2::interval`,
      [userId, interval],
    );
    return Number(row?.count ?? '0');
  }

  /** Двойной тап: тот же план в пределах 5 минут отдаёт существующую ссылку. */
  async findRecentInvoice(
    userId: string,
    planCode: PlanCode,
    interval: string,
  ): Promise<InvoiceRow | null> {
    return this.db.queryOne<InvoiceRow>(
      `SELECT id, plan_code, idem_key, payload, invoice_link, status, chart_id, created_at
         FROM invoices
        WHERE user_id = $1 AND plan_code = $2 AND status = 'created'
          AND created_at > now() - $3::interval
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, planCode, interval],
    );
  }

  async createInvoice(input: {
    userId: string;
    planCode: PlanCode;
    idemKey: string;
    payload: string;
    invoiceLink: string;
    chartId: string | null;
  }): Promise<InvoiceRow> {
    const row = await this.db.queryOne<InvoiceRow>(
      `INSERT INTO invoices (user_id, plan_code, idem_key, payload, invoice_link, chart_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, plan_code, idem_key, payload, invoice_link, status, chart_id, created_at`,
      [input.userId, input.planCode, input.idemKey, input.payload, input.invoiceLink, input.chartId],
    );

    if (row === null) {
      throw new Error('инвойс не сохранён');
    }

    return row;
  }

  async findInvoiceByIdeaKey(userId: string, idemKey: string): Promise<InvoiceRow | null> {
    return this.db.queryOne<InvoiceRow>(
      `SELECT id, plan_code, idem_key, payload, invoice_link, status, chart_id, created_at
         FROM invoices WHERE user_id = $1 AND idem_key = $2`,
      [userId, idemKey],
    );
  }

  // --- платежи (в транзакции) ---------------------------------------------

  /** `SELECT ... FOR UPDATE`: вторая доставка того же charge_id ждёт первую. */
  async lockPayment(
    client: PoolClient,
    chargeId: string,
  ): Promise<{ id: string; processed: boolean; status: string } | null> {
    const result = await client.query<{ id: string; processed: boolean; status: string }>(
      `SELECT id, processed, status FROM payments WHERE telegram_payment_charge_id = $1 FOR UPDATE`,
      [chargeId],
    );
    return result.rows[0] ?? null;
  }

  async insertPayment(client: PoolClient, payment: NewPayment): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO payments (
         user_id, telegram_id, plan_code, currency, total_amount,
         telegram_payment_charge_id, provider_payment_charge_id, invoice_payload,
         subscription_expires_at, status, processed
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paid', false)
       ON CONFLICT (telegram_payment_charge_id) DO NOTHING
       RETURNING id`,
      [
        payment.userId,
        payment.telegramId,
        payment.planCode,
        payment.currency,
        payment.totalAmount,
        payment.chargeId,
        payment.providerChargeId,
        payment.invoicePayload,
        payment.subscriptionExpiresAt,
      ],
    );

    return result.rows[0]?.id ?? null;
  }

  /** Пометить уже записанный платёж отказом: `paid` + `processed = false` → `rejected`. */
  async markPaymentRejected(
    client: PoolClient,
    input: { chargeId: string; reason: RejectReason },
  ): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `UPDATE payments
          SET status = 'rejected', reject_reason = $2
        WHERE telegram_payment_charge_id = $1
          AND status = 'paid' AND processed = false
        RETURNING id`,
      [input.chargeId, input.reason],
    );
    return result.rows[0]?.id ?? null;
  }

  /**
   * Отказ по деньгам (QA-11): строка пишется, чтобы отказ был виден поддержке
   * и в метриках, но `processed` остаётся `false` — доступа она не даёт.
   * Возвращает `null`, если такой `charge_id` уже записан (повтор доставки).
   */
  async insertRejectedPayment(client: PoolClient, payment: NewRejectedPayment): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO payments (
         user_id, telegram_id, plan_code, currency, total_amount,
         telegram_payment_charge_id, provider_payment_charge_id, invoice_payload,
         subscription_expires_at, status, processed, reject_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rejected', false, $10)
       ON CONFLICT (telegram_payment_charge_id) DO NOTHING
       RETURNING id`,
      [
        payment.userId,
        payment.telegramId,
        payment.planCode,
        payment.currency,
        payment.totalAmount,
        payment.chargeId,
        payment.providerChargeId,
        payment.invoicePayload,
        payment.subscriptionExpiresAt,
        payment.rejectReason,
      ],
    );

    return result.rows[0]?.id ?? null;
  }

  async markPaymentProcessed(client: PoolClient, paymentId: string): Promise<void> {
    await client.query(
      `UPDATE payments SET processed = true, status = 'processed', paid_at = now() WHERE id = $1`,
      [paymentId],
    );
  }

  /** Есть ли ещё пользователь: платёж после `DELETE /me` выдавать доступ не должен. */
  async userExists(userId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM users WHERE id = $1`,
      [userId],
    );
    return row !== null;
  }

  /**
   * QA-15: `DELETE /me` аннулирует живые инвойсы в той же транзакции, что и
   * удаление. Иначе остаётся окно, в котором пользователя уже нет, а инвойс
   * ещё принимает оплату.
   */
  async invalidateInvoices(client: PoolClient, userId: string): Promise<number> {
    const result = await client.query(
      `UPDATE invoices
          SET status = 'invalidated', invalidated_at = now()
        WHERE user_id = $1 AND status = 'created'`,
      [userId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Отказ с автовозвратом: статус остаётся `rejected` (доступ не выдавался),
   * `refunded_at` отмечает, что звёзды вернулись. Сумма при этом не «исчезает»
   * из отчётности: строка rejected + refunded видна и в `payments_rejected_30d`,
   * и в `refunded_30d`.
   */
  async markRejectedRefunded(chargeId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE payments SET refunded_at = now(), processed = false
        WHERE telegram_payment_charge_id = $1 AND status = 'rejected' AND refunded_at IS NULL`,
      [chargeId],
    );
    return result.length > 0;
  }

  async markInvoicePaid(client: PoolClient, userId: string, idemKey: string): Promise<void> {
    await client.query(
      `UPDATE invoices SET status = 'paid' WHERE user_id = $1 AND idem_key = $2 AND status = 'created'`,
      [userId, idemKey],
    );
  }

  /**
   * Платёж, который можно довести до конца: `paid`, но доступ не выдан.
   * Нужен джобу `pending_payments_resolve` и `DELETE /me` — оба разрешают его
   * тем же путём, что и вебхук.
   */
  async findUnprocessedPayments(olderThanMinutes: number, limit: number): Promise<PaymentForResolution[]> {
    return this.db.query<PaymentForResolution>(
      `SELECT telegram_payment_charge_id, telegram_id::text AS telegram_id, currency,
              total_amount, invoice_payload, subscription_expires_at,
              provider_payment_charge_id, status, processed
         FROM payments
        WHERE processed = false
          AND status = 'paid'
          AND paid_at <= now() - make_interval(mins => $1::int)
        ORDER BY paid_at
        LIMIT $2`,
      [olderThanMinutes, limit],
    );
  }

  /** Все незавершённые платежи пользователя — для `DELETE /me`. */
  async listUnprocessedPaymentsOf(userId: string): Promise<PaymentForResolution[]> {
    return this.db.query<PaymentForResolution>(
      `SELECT telegram_payment_charge_id, telegram_id::text AS telegram_id, currency,
              total_amount, invoice_payload, subscription_expires_at,
              provider_payment_charge_id, status, processed
         FROM payments
        WHERE user_id = $1 AND processed = false AND status = 'paid'
        ORDER BY paid_at`,
      [userId],
    );
  }

  async findPaymentForResolution(chargeId: string): Promise<PaymentForResolution | null> {
    return this.db.queryOne<PaymentForResolution>(
      `SELECT telegram_payment_charge_id, telegram_id::text AS telegram_id, currency,
              total_amount, invoice_payload, subscription_expires_at,
              provider_payment_charge_id, status, processed
         FROM payments
        WHERE telegram_payment_charge_id = $1`,
      [chargeId],
    );
  }

  async hasPendingPayments(userId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM payments
          WHERE user_id = $1 AND processed = false AND status = 'paid'
       ) AS pending`,
      [userId],
    );
    return row?.pending === true;
  }

  // --- выдача доступа ------------------------------------------------------

  async grantEntitlement(client: PoolClient, grant: GrantInput): Promise<void> {
    await client.query(
      `INSERT INTO entitlements (user_id, kind, chart_id, partner_chart_id, payment_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [grant.userId, grant.kind, grant.chartId, grant.partnerChartId, grant.paymentId],
    );
  }

  /**
   * Продление (payments.md §3.3): срок только сдвигается вперёд, назад — никогда.
   * Предыдущее значение читаем под `FOR UPDATE` до апдейта: `RETURNING` в
   * `ON CONFLICT` показывает уже новую строку, и «до» из него не достать.
   */
  async upsertSubscription(
    client: PoolClient,
    input: {
      userId: string;
      plan: 'trial' | 'week' | 'month' | 'year';
      /**
       * Срок из `subscription_expiration_date` Telegram. `null` — Telegram его
       * не прислал (R-1): тогда период прибавляется к текущему сроку, а не
       * к «сейчас», иначе продление съедало бы остаток оплаченного времени.
       */
      requestedExpiresAt: Date | null;
      periodSeconds: number;
      chargeId: string;
    },
  ): Promise<{ expiresAt: Date; previousExpiresAt: Date | null }> {
    const existing = await client.query<{ expires_at: Date }>(
      `SELECT expires_at FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const previousExpiresAt = existing.rows[0]?.expires_at ?? null;

    const now = new Date();
    const base =
      previousExpiresAt !== null && previousExpiresAt.getTime() > now.getTime()
        ? previousExpiresAt
        : now;
    const requested = input.requestedExpiresAt ?? new Date(base.getTime() + input.periodSeconds * 1000);

    const nextExpiresAt =
      previousExpiresAt !== null && previousExpiresAt.getTime() > requested.getTime()
        ? previousExpiresAt
        : requested;

    const result = await client.query<{ expires_at: Date }>(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at, auto_renew, telegram_payment_charge_id)
       VALUES ($1, $2, 'active', $3, true, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET plan = EXCLUDED.plan,
             status = 'active',
             expires_at = EXCLUDED.expires_at,
             auto_renew = true,
             telegram_payment_charge_id = EXCLUDED.telegram_payment_charge_id
       RETURNING expires_at`,
      [input.userId, input.plan, nextExpiresAt, input.chargeId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('подписка не сохранена');
    }

    return { expiresAt: row.expires_at, previousExpiresAt };
  }

  // --- возвраты ------------------------------------------------------------

  async findRefundablePayment(chargeId: string): Promise<{
    id: string;
    user_id: string | null;
    telegram_id: string | null;
    plan_code: PlanCode;
    status: string;
  } | null> {
    return this.db.queryOne(
      `SELECT id, user_id, telegram_id::text AS telegram_id, plan_code, status
         FROM payments WHERE telegram_payment_charge_id = $1`,
      [chargeId],
    );
  }

  async registerRefund(input: {
    chargeId: string;
    reason: string;
  }): Promise<void> {
    await this.db.withTransaction(async (client) => {
      const payment = await client.query<{ id: string; user_id: string | null }>(
        `UPDATE payments
            SET status = 'refunded', refunded_at = now()
          WHERE telegram_payment_charge_id = $1 AND status <> 'refunded'
          RETURNING id, user_id`,
        [input.chargeId],
      );
      const row = payment.rows[0];
      if (row === undefined) {
        return;
      }

      // Доступ отзывается вместе с деньгами (payments.md §3.5).
      await client.query(
        `UPDATE entitlements SET status = 'refunded' WHERE payment_id = $1`,
        [row.id],
      );
      if (row.user_id !== null) {
        await client.query(
          `UPDATE subscriptions SET status = 'cancelled', expires_at = LEAST(expires_at, now())
            WHERE user_id = $1 AND telegram_payment_charge_id = $2`,
          [row.user_id, input.chargeId],
        );
        await client.query(
          `INSERT INTO events (user_id, name, props) VALUES ($1, 'refund_issued', $2::jsonb)`,
          [row.user_id, JSON.stringify({ code: input.reason })],
        );
      }
    });
  }
}
