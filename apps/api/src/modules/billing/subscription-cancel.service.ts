import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { JsonLogger } from '../../common/logger';
import { EventsRepository } from '../events/events.repository';
import { TelegramClient, type StarSubscriptionCancelResult } from '../telegram/telegram.client';

/**
 * Отмена автопродления звёздной подписки в Telegram (задача A итерации 12).
 *
 * Локальная строка `subscriptions` и подписка в Telegram — разные сущности.
 * `DELETE /me` отменял только первую, поэтому Telegram продолжал списывать
 * звёзды за следующий период уже после удаления данных: сервер такой платёж
 * отклоняет и возвращает, но «списали и вернули» — это обращение в поддержку
 * и вопрос от Telegram, а не «не списали».
 *
 * Правила, которые здесь зашиты:
 *
 *   1. **Telegram раньше транзакции.** Пара (telegram_id, charge_id) читается,
 *      пока `user_id` ещё не обнулён; вызов идёт до `DELETE users`.
 *   2. **Ошибка Telegram не блокирует удаление.** Право человека на удаление
 *      первично (152-ФЗ), поэтому результат вызова — это состояние в БД и
 *      событие, а не исключение наружу.
 *   3. **Подписки нет — вызова нет.** `editUserStarSubscription` «на всякий
 *      случай» вернул бы `subscription not active` и забил метрики.
 *   4. **Неуспех повторяется**, пока не истекло окно возврата: charge_id живёт
 *      `PAYMENT_REFUND_WINDOW_DAYS`, попыток не больше `CANCEL_MAX_ATTEMPTS`.
 *
 * `charge_id` берём из `subscriptions.telegram_payment_charge_id` — он
 * обновляется каждым продлением, то есть это последний успешный платёж
 * подписки. Если строки там нет (старые данные), ищем последний успешный
 * платёж пользователя по подписке.
 */

/** Сколько раз пробуем отменить автопродление (успех тоже считается попыткой). */
export const CANCEL_MAX_ATTEMPTS = 5;

/** Повтор не чаще раза в час: Telegram не любит шквал одинаковых вызовов. */
export const CANCEL_RETRY_INTERVAL_HOURS = 1;

/** Окно, в котором `editUserStarSubscription` вообще имеет смысл. */
export const CANCEL_RETRY_WINDOW_DAYS = 30;

export type CancelState = 'none' | 'cancelled' | 'failed' | 'gave_up';

export interface CancelOutcome {
  /** Что записать в `subscriptions.telegram_cancel_state`. */
  readonly state: CancelState;
  /** Попытка была (нужно увеличить `telegram_cancel_attempts`). */
  readonly attempted: boolean;
  /** Причина отказа — для события и метрик. */
  readonly code?: 'telegram_error' | 'timeout' | 'no_charge_id';
  /** Совпадает с `payments.telegram_payment_charge_id`; в логи идёт хвостом. */
  readonly chargeId?: string;
  /** Строка подписки, к которой относится результат. */
  readonly subscriptionId?: string;
}

interface SubjectRow {
  readonly subscription_id: string;
  readonly charge_id: string | null;
  readonly telegram_id: string | null;
}

@Injectable()
export class SubscriptionCancelService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `DELETE /me`: отменить автопродление до локальной транзакции.
   *
   * Возвращает состояние, которое транзакция запишет в строку подписки. Ни при
   * каких обстоятельствах не бросает: удаление данных не может зависеть от
   * доступности чужого API.
   */
  async cancelForUser(userId: string): Promise<CancelOutcome> {
    const subject = await this.subjectOf(userId);

    if (subject === null) {
      // Подписки нет — вызова нет. Иначе `subscription not active` от Telegram
      // на пустом месте попадёт в события и метрики.
      return { state: 'none', attempted: false };
    }

    const result = await this.invoke(subject);

    if (result.ok) {
      this.logger.info('telegram_cancel_state', {
        state: 'cancelled',
        subscription_id: subject.subscription_id,
        charge_tail: tailOf(subject.charge_id),
      });
      return {
        state: 'cancelled',
        attempted: true,
        chargeId: subject.charge_id ?? undefined,
        subscriptionId: subject.subscription_id,
      };
    }

    // `no_charge_id` — не «Telegram отказал», а «звать некого». Состояние всё
    // равно `failed`: строка должна быть видна в `subscriptions_cancelled_pending_telegram`,
    // иначе такие подписки молча останутся с живым автопродлением.
    this.logger.warn('telegram_cancel_state', {
      state: 'failed',
      code: result.code,
      subscription_id: subject.subscription_id,
      charge_tail: tailOf(subject.charge_id),
    });

    await this.events.log({
      name: 'subscription_cancel_failed',
      props: { code: result.code },
    });

    return {
      state: 'failed',
      attempted: true,
      code: result.code,
      chargeId: subject.charge_id ?? undefined,
      subscriptionId: subject.subscription_id,
    };
  }

  /**
   * Ночной джоб: повторить отмену для строк, где прошлый вызов не прошёл.
   *
   * Условия повтора: `status = 'cancelled'`, `telegram_cancel_state = 'failed'`,
   * попыток меньше `CANCEL_MAX_ATTEMPTS`, последняя попытка была больше часа
   * назад, окно (30 дней с обезличивания) не истекло. Не нашли telegram_id —
   * повтор невозможен в принципе, сразу `gave_up`.
   */
  async retryFailed(
    limit = 20,
  ): Promise<{ retried: number; cancelled: number; gaveUp: number }> {
    const rows = await this.db.query<SubjectRow>(
      `SELECT s.id AS subscription_id,
              s.telegram_payment_charge_id AS charge_id,
              p.telegram_id::text AS telegram_id
         FROM subscriptions s
         LEFT JOIN payments p
                ON p.telegram_payment_charge_id = s.telegram_payment_charge_id
        WHERE s.status = 'cancelled'
          AND s.telegram_cancel_state = 'failed'
          AND s.telegram_cancel_attempts < $1
          AND (s.telegram_cancel_last_at IS NULL
               OR s.telegram_cancel_last_at <= now() - make_interval(hours => $2))
          AND COALESCE(s.anonymized_at, s.updated_at)
              > now() - make_interval(days => $3)
        ORDER BY s.telegram_cancel_last_at NULLS FIRST
        LIMIT $4`,
      [CANCEL_MAX_ATTEMPTS, CANCEL_RETRY_INTERVAL_HOURS, CANCEL_RETRY_WINDOW_DAYS, limit],
    );

    let cancelled = 0;
    let gaveUp = 0;

    for (const row of rows) {
      const result = await this.invoke(row);

      if (result.ok) {
        await this.db.query(
          `UPDATE subscriptions
              SET telegram_cancel_state = 'cancelled',
                  telegram_cancel_attempts = telegram_cancel_attempts + 1,
                  telegram_cancel_last_at = now()
            WHERE id = $1`,
          [row.subscription_id],
        );
        cancelled += 1;
        this.logger.info('telegram_cancel_state', {
          state: 'cancelled',
          subscription_id: row.subscription_id,
          retry: true,
        });
        continue;
      }

      // Пятая неудача — или отсутствие пары, без которой повтор бессмысленен.
      // `no_charge_id` сразу `gave_up`: сколько ни повторяй, звать некого.
      const attempts = await this.bumpAttempts(row.subscription_id);
      const state: CancelState =
        result.code === 'no_charge_id' || attempts >= CANCEL_MAX_ATTEMPTS ? 'gave_up' : 'failed';

      await this.db.query(
        `UPDATE subscriptions SET telegram_cancel_state = $2 WHERE id = $1`,
        [row.subscription_id, state],
      );

      await this.events.log({
        name: 'subscription_cancel_failed',
        props: { code: result.code },
      });

      if (state === 'gave_up') {
        gaveUp += 1;
      }

      this.logger.warn('telegram_cancel_state', {
        state,
        code: result.code,
        attempts,
        subscription_id: row.subscription_id,
        charge_tail: tailOf(row.charge_id),
      });
    }

    return { retried: rows.length, cancelled, gaveUp };
  }

  /** Пара для вызова: строка подписки, charge_id и telegram_id. */
  private async subjectOf(userId: string): Promise<SubjectRow | null> {
    const row = await this.db.queryOne<SubjectRow>(
      `SELECT s.id AS subscription_id,
              COALESCE(
                s.telegram_payment_charge_id,
                (SELECT p.telegram_payment_charge_id
                   FROM payments p
                  WHERE p.user_id = $1
                    AND p.status IN ('paid', 'processed')
                    AND p.telegram_payment_charge_id IS NOT NULL
                  ORDER BY p.paid_at DESC NULLS LAST, p.created_at DESC
                  LIMIT 1)
              ) AS charge_id,
              COALESCE(
                (SELECT p.telegram_id::text
                   FROM payments p
                  WHERE p.user_id = $1
                    AND p.telegram_id IS NOT NULL
                  ORDER BY p.paid_at DESC NULLS LAST, p.created_at DESC
                  LIMIT 1),
                (SELECT p2.telegram_id::text
                   FROM payments p2
                  WHERE p2.telegram_payment_charge_id = s.telegram_payment_charge_id
                  LIMIT 1)
              ) AS telegram_id
         FROM subscriptions s
        WHERE s.user_id = $1 AND s.status = 'active'
        LIMIT 1`,
      [userId],
    );

    return row ?? null;
  }

  private async invoke(subject: SubjectRow): Promise<StarSubscriptionCancelResult> {
    const telegramId =
      subject.telegram_id === null || subject.telegram_id === ''
        ? null
        : Number(subject.telegram_id);

    return this.telegram.editUserStarSubscription(
      telegramId === null || Number.isFinite(telegramId) ? telegramId : null,
      subject.charge_id,
    );
  }

  private async bumpAttempts(subscriptionId: string): Promise<number> {
    const row = await this.db.queryOne<{ attempts: number }>(
      `UPDATE subscriptions
          SET telegram_cancel_attempts = telegram_cancel_attempts + 1,
              telegram_cancel_last_at = now()
        WHERE id = $1
        RETURNING telegram_cancel_attempts::int AS attempts`,
      [subscriptionId],
    );
    return row?.attempts ?? CANCEL_MAX_ATTEMPTS;
  }
}

/** Хвост charge_id для логов: полный идентификатор в тексте не нужен. */
function tailOf(chargeId: string | null): string | null {
  return chargeId === null ? null : chargeId.slice(-6);
}
