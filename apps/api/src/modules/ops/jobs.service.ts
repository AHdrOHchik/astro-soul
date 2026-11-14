import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { JsonLogger } from '../../common/logger';
import { EventsRepository } from '../events/events.repository';
import { TelegramClient } from '../telegram/telegram.client';
import { PaymentsService } from '../billing/payments.service';

/** Через сколько минут недоставленный товар считаем поводом для возврата. */
export const REFUND_AFTER_MINUTES = 10;
/** Баннер «подписка закончилась» — не чаще одного раза в 30 дней. */
export const EXPIRY_NOTICE_DAYS = 30;
/** Предел работы одного запуска: крон не должен висеть бесконечно. */
const BATCH = 50;

/** Сколько месяцев без активности считаем поводом удалить ПДн (152-ФЗ, §2 legal). */
export const RETENTION_MONTHS = 24;

export type JobName =
  | 'subscriptions_downgrade'
  | 'pending_payments_resolve'
  | 'refund_undelivered'
  | 'report_refund'
  | 'pdn_retention_cleanup';

export const JOB_NAMES: readonly JobName[] = [
  'subscriptions_downgrade',
  'pending_payments_resolve',
  'refund_undelivered',
  'report_refund',
  'pdn_retention_cleanup',
];

export type MutableJobRunResult = { -readonly [K in keyof JobRunResult]: JobRunResult[K] };

export interface JobRunResult {
  readonly subscriptions_expired: number;
  readonly expiry_notices_sent: number;
  readonly pending_payments_processed: number;
  readonly pending_payments_rejected: number;
  readonly refunds_attempted: number;
  readonly refunds_done: number;
  readonly report_refunds_done: number;
  readonly pdn_users_deleted: number;
}

/**
 * Джобы, которые двигает крон (`POST /internal/jobs/run`).
 *
 * Здесь только те работы, которые обещаны в payments.md:
 *   §3.4 `subscriptions_downgrade` — истёкшие подписки теряют доступ и
 *        получают одно сообщение «продлить?» (не чаще раза в 30 дней);
 *   §3.2 автоматический возврат, если товар не был доставлен: платёж
 *        `processed = false` дольше 10 минут — возвращаем звёзды сами.
 *
 * Обе операции идемпотентны: повторный запуск ничего не дублирует.
 */
@Injectable()
export class JobsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Один запуск крона. `only` позволяет дёргать конкретный джоб
   * (`POST /internal/jobs/run?job=pending_payments_resolve`): у него свой таймер.
   *
   * Порядок важен: сначала `pending_payments_resolve` доводит зависшие платежи,
   * и только то, что он не смог, забирает `refund_undelivered`.
   */
  async run(only?: JobName): Promise<JobRunResult> {
    const pick = (job: JobName): boolean => only === undefined || only === job;
    const result: MutableJobRunResult = {
      subscriptions_expired: 0,
      expiry_notices_sent: 0,
      pending_payments_processed: 0,
      pending_payments_rejected: 0,
      refunds_attempted: 0,
      refunds_done: 0,
      report_refunds_done: 0,
      pdn_users_deleted: 0,
    };

    if (pick('subscriptions_downgrade')) {
      const expired = await this.downgradeSubscriptions();
      result.subscriptions_expired = expired.expired;
      result.expiry_notices_sent = expired.notices;
    }

    if (pick('pending_payments_resolve')) {
      const pending = await this.resolvePendingPayments();
      result.pending_payments_processed = pending.processed;
      result.pending_payments_rejected = pending.rejected;
    }

    if (pick('refund_undelivered')) {
      const refunds = await this.refundUndelivered();
      result.refunds_attempted = refunds.attempted;
      result.refunds_done = refunds.done;
    }

    if (pick('report_refund')) {
      result.report_refunds_done = await this.refundFailedReports();
    }

    if (pick('pdn_retention_cleanup')) {
      result.pdn_users_deleted = await this.cleanupPdn();
    }

    return result;
  }

  /**
   * `pending_payments_resolve` (QA-14, R-4): платёж, который старше 10 минут
   * остался `processed = false`, доводим до конца тем же кодом, что и вебхук.
   *
   * Доставка возможна — выдаём доступ (пользователь получил то, за что заплатил).
   * Сверка не сходится — помечаем `rejected` с причиной; звёзды не возвращаем,
   * это решение владельца (QA-11).
   *
   * Идемпотентность: второй запуск не находит ни одного платежа и возвращает нули.
   */
  private async resolvePendingPayments(): Promise<{ processed: number; rejected: number }> {
    const charges = await this.payments.staleCharges(REFUND_AFTER_MINUTES, BATCH);
    let processed = 0;
    let rejected = 0;

    for (const chargeId of charges) {
      try {
        const outcome = await this.payments.resolvePending(chargeId);
        if (outcome === 'processed') {
          processed += 1;
        } else if (outcome === 'rejected') {
          rejected += 1;
        }
        this.logger.info('pending_payment_resolved', { charge: chargeId, outcome });
      } catch (error) {
        // Платёж остаётся `paid`/`unprocessed`: им займётся `refund_undelivered`.
        this.logger.error('pending_payment_resolve_failed', {
          charge: chargeId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    if (charges.length > 0) {
      this.logger.info('pending_payments_resolve', { found: charges.length, processed, rejected });
    }

    return { processed, rejected };
  }

  /**
   * `report_refund`: звёзды за разбор, который так и не собрался (`failed`).
   * Платёж ищется через entitlement карты, поэтому возврат идёт ровно за тот
   * заказ, из которого выдан доступ. Повторный запуск ничего не делает:
   * у разбора появляется `refunded_at`, статус — `refunded`.
   */
  private async refundFailedReports(): Promise<number> {
    const reports = await this.db.query<{ id: string; user_id: string; chart_id: string; kind: string }>(
      `SELECT id, user_id, chart_id, kind::text AS kind
         FROM reports
        WHERE status = 'failed' AND refunded_at IS NULL
        ORDER BY updated_at
        LIMIT $1`,
      [BATCH],
    );

    let done = 0;

    for (const report of reports) {
      const payment = await this.db.queryOne<{ charge_id: string }>(
        `SELECT p.telegram_payment_charge_id AS charge_id
           FROM entitlements e
           JOIN payments p ON p.id = e.payment_id
          WHERE e.user_id = $1 AND e.chart_id = $2 AND e.kind = $3
            AND e.status = 'active'
          ORDER BY e.granted_at DESC
          LIMIT 1`,
        [report.user_id, report.chart_id, report.kind],
      );

      const refunded =
        payment !== null && (await this.payments.refund(payment.charge_id, 'report_failed'));

      // Разбор помечаем в любом случае: без платежа возвращать нечего, и второй
      // заход за тем же разбором бессмыслен. Причину видно в логе.
      await this.db.query(
        `UPDATE reports SET status = 'refunded', refunded_at = now() WHERE id = $1`,
        [report.id],
      );

      if (refunded) {
        done += 1;
        await this.events.log({
          name: 'refund_issued',
          userId: report.user_id,
          props: { code: 'report_failed' },
        });
      }

      this.logger.info('report_refund', {
        report_id: report.id,
        refunded,
        reason: payment === null ? 'no_payment' : refunded ? 'refunded' : 'refund_failed',
      });
    }

    return done;
  }

  /**
   * `pdn_retention_cleanup`: ПДн пользователей без активности дольше 24 месяцев.
   *
   * Активность — последнее событие, а если событий не было — дата создания
   * пользователя. Удаление идёт под advisory lock: два экземпляра крона
   * (например, при деплое) не будут удалять одни и те же строки. Платёж
   * остаётся бухгалтерией, но обезличивается — как в `DELETE /me`.
   *
   * Повторный запуск идемпотентен: удалённых пользователей он уже не находит.
   */
  private async cleanupPdn(): Promise<number> {
    const deleted = await this.db.withTransaction(async (client) => {
      // Ключ блокировки — произвольная константа: важно, что она одна на джоб.
      await client.query(`SELECT pg_advisory_xact_lock(91_004_001)`);

      const candidates = await client.query<{ id: string }>(
        `SELECT u.id
           FROM users u
          WHERE COALESCE(
                  (SELECT max(e.created_at) FROM events e WHERE e.user_id = u.id),
                  u.created_at
                ) < now() - make_interval(months => $1::int)
          ORDER BY u.created_at
          LIMIT $2
          FOR UPDATE`,
        [RETENTION_MONTHS, BATCH],
      );

      for (const row of candidates.rows) {
        await client.query(
          `UPDATE payments SET telegram_id = NULL, anonymized_at = now()
            WHERE user_id = $1 AND anonymized_at IS NULL`,
          [row.id],
        );
        await client.query(`DELETE FROM quotas WHERE user_id = $1`, [row.id]);
        await client.query(`DELETE FROM users WHERE id = $1`, [row.id]);
      }

      return candidates.rows.length;
    });

    if (deleted > 0) {
      this.logger.info('pdn_retention_cleanup', { deleted, months: RETENTION_MONTHS });
    }

    return deleted;
  }

  /**
   * `subscriptions_downgrade`: помечаем истёкшие и пишем каждому одно
   * сообщение. Доступ при этом уже не работает — `getEntitlements` проверяет
   * `expires_at > now()`, — джоб нужен ради статуса и уведомления, а не ради
   * отзыва доступа.
   */
  private async downgradeSubscriptions(): Promise<{ expired: number; notices: number }> {
    const rows = await this.db.query<{ user_id: string }>(
      `UPDATE subscriptions
          SET status = 'expired'
        WHERE status = 'active' AND expires_at <= now()
        RETURNING user_id`,
    );

    let notices = 0;

    for (const row of rows) {
      const alreadyNotified = await this.db.queryOne<{ notified: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM events
            WHERE user_id = $1
              AND name = 'subscription_expired'
              AND created_at > now() - make_interval(days => $2::int)
         ) AS notified`,
        [row.user_id, EXPIRY_NOTICE_DAYS],
      );

      if (alreadyNotified?.notified === true) {
        continue;
      }

      const user = await this.db.queryOne<{ telegram_id: string | null }>(
        `SELECT telegram_id FROM users WHERE id = $1`,
        [row.user_id],
      );

      if (user?.telegram_id !== null && user?.telegram_id !== undefined) {
        await this.telegram.sendMessage(
          Number(user.telegram_id),
          'Подписка закончилась. Продлить можно в приложении — прогнозы и разборы снова откроются.',
        );
        notices += 1;
      }

      // Отметку ставим и без отправки: попытка была, второй раз за 30 дней
      // пользователя не трогаем (у него может не быть чата с ботом).
      await this.events.log({
        name: 'subscription_expired',
        userId: row.user_id,
        props: { notified: user?.telegram_id !== null && user?.telegram_id !== undefined },
      });
    }

    if (rows.length > 0) {
      this.logger.info('subscriptions_downgrade', { expired: rows.length, notices });
    }

    return { expired: rows.length, notices };
  }

  /**
   * Автовозврат за недоставленный товар (payments.md §3.2).
   *
   * «Недоставлен» = платёж принят и записан, но `processed = false` дольше
   * 10 минут: значит обработчик упал после записи и доступ так и не выдан.
   */
  private async refundUndelivered(): Promise<{ attempted: number; done: number }> {
    const rows = await this.db.query<{ telegram_payment_charge_id: string }>(
      `SELECT telegram_payment_charge_id
         FROM payments
        WHERE processed = false
          AND status = 'paid'
          AND paid_at <= now() - make_interval(mins => $1::int)
        LIMIT $2`,
      [REFUND_AFTER_MINUTES, BATCH],
    );

    let done = 0;

    for (const row of rows) {
      const ok = await this.payments.refund(row.telegram_payment_charge_id, 'not_delivered');
      if (ok) {
        done += 1;
      }
      this.logger.info('payment_auto_refund', {
        charge: row.telegram_payment_charge_id,
        ok,
      });
    }

    return { attempted: rows.length, done };
  }
}
