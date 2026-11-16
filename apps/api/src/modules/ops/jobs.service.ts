import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { JsonLogger } from '../../common/logger';
import { EventsRepository } from '../events/events.repository';
import { TelegramClient } from '../telegram/telegram.client';
import { PaymentsService } from '../billing/payments.service';
import { SubscriptionCancelService } from '../billing/subscription-cancel.service';
import { EngagementService } from '../engagement/engagement.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/** Через сколько минут недоставленный товар считаем поводом для возврата. */
export const REFUND_AFTER_MINUTES = 10;
/** Баннер «подписка закончилась» — не чаще одного раза в 30 дней. */
export const EXPIRY_NOTICE_DAYS = 30;
/** Предел работы одного запуска: крон не должен висеть бесконечно. */
const BATCH = 50;

/**
 * Ключи advisory-локов: один джоб — один ключ.
 * 91_004_001 занят `pdn_retention_cleanup`; прогноз и пуш получают свои,
 * чтобы ночная генерация и рассылка не мешали друг другу.
 */
export const FORECAST_LOCK = 91_004_002;
export const PUSH_LOCK = 91_004_003;

/**
 * Сколько дней после `DELETE /me` храним `payments.telegram_id`.
 *
 * Bot API возвращает звёзды только по паре (user_id, charge_id), поэтому без
 * telegram_id возврат удалённому человеку невозможен. Окно — с запасом над
 * 21 днём, которые Telegram держит звёзды в балансе бота. После окна
 * идентификатор снимается: строка платежа остаётся бухгалтерией, но уже без
 * связи с человеком.
 */
export const PAYMENT_REFUND_WINDOW_DAYS = 30;

/** Сколько месяцев без активности считаем поводом удалить ПДн (152-ФЗ, §2 legal). */
export const RETENTION_MONTHS = 24;

export type JobName =
  | 'subscriptions_downgrade'
  | 'pending_payments_resolve'
  | 'refund_undelivered'
  | 'report_refund'
  | 'pdn_retention_cleanup'
  | 'forecast_nightly'
  | 'forecast_push';

export const JOB_NAMES: readonly JobName[] = [
  'subscriptions_downgrade',
  'pending_payments_resolve',
  'refund_undelivered',
  'report_refund',
  'pdn_retention_cleanup',
  'forecast_nightly',
  'forecast_push',
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
  /** Отмена автопродления в Telegram, повторенная ночным джобом (задача A). */
  readonly telegram_cancel_retried: number;
  readonly telegram_cancel_cancelled: number;
  readonly telegram_cancel_gave_up: number;
  /** Удержание: ночная генерация прогнозов. */
  readonly forecasts_generated: number;
  readonly forecasts_skipped: number;
  readonly forecasts_failed: number;
  /** Удержание: пуш 08:00 по месту рождения. */
  readonly pushes_sent: number;
  readonly pushes_skipped_inactive: number;
  readonly pushes_deferred: number;
  readonly pushes_failed: number;
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
    @Inject(SubscriptionCancelService) private readonly subscriptionCancel: SubscriptionCancelService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(EngagementService) private readonly engagement: EngagementService,
    @Inject(APP_ENV) private readonly env: AppEnv,
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
      telegram_cancel_retried: 0,
      telegram_cancel_cancelled: 0,
      telegram_cancel_gave_up: 0,
      forecasts_generated: 0,
      forecasts_skipped: 0,
      forecasts_failed: 0,
      pushes_sent: 0,
      pushes_skipped_inactive: 0,
      pushes_deferred: 0,
      pushes_failed: 0,
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

    if (pick('forecast_nightly')) {
      // Ночная генерация: без лока два экземпляра крона сгенерировали бы
      // один и тот же прогноз дважды и заплатили за это дважды.
      const nightly = await this.db.withAdvisoryLock(FORECAST_LOCK, () => this.engagement.runNightly());

      if (nightly === null) {
        this.logger.warn('forecast_nightly_locked', { reason: 'another_run' });
      } else {
        result.forecasts_generated = nightly.generated;
        result.forecasts_skipped = nightly.skipped;
        result.forecasts_failed = nightly.failed;
      }
    }

    if (pick('forecast_push')) {
      const push = await this.db.withAdvisoryLock(PUSH_LOCK, () => this.engagement.runPush());

      if (push === null) {
        this.logger.warn('forecast_push_locked', { reason: 'another_run' });
      } else {
        result.pushes_sent = push.sent;
        result.pushes_skipped_inactive = push.skippedInactive;
        result.pushes_deferred = push.deferred;
        result.pushes_failed = push.failed;
      }
    }

    if (pick('pdn_retention_cleanup')) {
      result.pdn_users_deleted = await this.cleanupPdn();

      // Отмена автопродления в Telegram живёт в том же ночном прогоне: это
      // тоже удержание, и отдельный таймер здесь ни к чему. Повтор идёт по
      // строкам `cancelled` + `failed`, не чаще раза в час (задача A, п. 3).
      const retry = await this.subscriptionCancel.retryFailed();
      result.telegram_cancel_retried = retry.retried;
      result.telegram_cancel_cancelled = retry.cancelled;
      result.telegram_cancel_gave_up = retry.gaveUp;
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
   *
   * **По умолчанию выключено** (`REFUND_ON_REPORT_FAILED=false`, итерация 17,
   * решение владельца): автовозврата за неудавшийся разбор нет. Код не удалён
   * — возврат включается флагом `REFUND_ON_REPORT_FAILED=1`; при выключенном
   * флаге джоб не делает ни одного запроса и оставляет разбор в `failed`.
   */
  private async refundFailedReports(): Promise<number> {
    if (this.env.REFUND_ON_REPORT_FAILED !== '1') {
      this.logger.info('report_refund_disabled', { flag: 'REFUND_ON_REPORT_FAILED' });
      return 0;
    }

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
   * остаётся бухгалтерией, но обезличивается — как в `DELETE /me`. Заодно
   * джоб снимает `payments.telegram_id` у платежей, у которых истекло окно
   * возврата (`PAYMENT_REFUND_WINDOW_DAYS`).
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

    // Окно возврата истекло — снимаем telegram_id у уже обезличенных платежей.
    // Отдельным запросом, а не внутри транзакции выше: это не удаление ПДн, а
    // досрочное снятие идентификатора, и оно не должно зависать на блокировке.
    const cleared = await this.db.query<{ id: string }>(
      `UPDATE payments
          SET telegram_id = NULL
        WHERE telegram_id IS NOT NULL
          AND anonymized_at IS NOT NULL
          AND anonymized_at <= now() - make_interval(days => $1::int)
        RETURNING id`,
      [PAYMENT_REFUND_WINDOW_DAYS],
    );

    if (deleted > 0) {
      this.logger.info('pdn_retention_cleanup', { deleted, months: RETENTION_MONTHS });
    }

    if (cleared.length > 0) {
      this.logger.info('payments_telegram_ids_cleared', {
        cleared: cleared.length,
        days: PAYMENT_REFUND_WINDOW_DAYS,
      });
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
