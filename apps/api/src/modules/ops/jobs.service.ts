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

export interface JobRunResult {
  readonly subscriptions_expired: number;
  readonly expiry_notices_sent: number;
  readonly refunds_attempted: number;
  readonly refunds_done: number;
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

  async run(): Promise<JobRunResult> {
    const expired = await this.downgradeSubscriptions();
    const refunds = await this.refundUndelivered();

    return {
      subscriptions_expired: expired.expired,
      expiry_notices_sent: expired.notices,
      refunds_attempted: refunds.attempted,
      refunds_done: refunds.done,
    };
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
