import { Inject, Injectable } from '@nestjs/common';
import { ApiError, conflict, internalError, notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { currentRequestId } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { assertAdmin, type AdminActor } from '../admin-auth/admin-actor';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { TelegramClient } from '../telegram/telegram.client';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AdminUsersRepository, type AdminUserRow } from './admin-users.repository';
import {
  isUuid,
  parseAdminBan,
  parseAdminRefund,
  type AdminUserSearch,
} from './admin-support.dto';

/** Строка списка: без даты рождения, без места, без `telegram_id`. */
export interface AdminUserSummary {
  readonly user_id: string;
  readonly alias: string;
  readonly has_subscription: boolean;
  readonly subscription_plan: string | null;
  readonly subscription_expires_at: string | null;
  readonly banned: boolean;
  readonly created_at: string;
  readonly last_seen_at: string | null;
}

export interface AdminUserPage {
  readonly items: readonly AdminUserSummary[];
  readonly truncated: boolean;
}

export interface AdminPayment {
  readonly charge_id: string;
  readonly plan_code: string;
  readonly amount_stars: number;
  readonly status: string;
  readonly is_test: boolean;
  readonly paid_at: string;
  readonly refunded_at: string | null;
}

export interface AdminUserCard {
  readonly user_id: string;
  readonly alias: string;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  /**
   * `telegram_id` — единственное «сырое» поле карточки, и оно здесь потому, что
   * поддержке нужно сверить человека с чатом Telegram. Чтение карточки пишется
   * в аудит (`user.card_view`), поэтому доступ к нему оставляет след.
   */
  readonly telegram_id: string | null;
  readonly push_enabled: boolean;
  readonly banned: boolean;
  readonly banned_at: string | null;
  readonly ban_reason: string | null;
  readonly profile: {
    readonly birth_date: string;
    readonly birth_time: string | null;
    /** `exact | approximate | unknown` — как в `Chart.birth.time_precision`. */
    readonly time_precision: string;
    readonly place_name: string;
    readonly place_region: string | null;
    readonly place_country: string;
    readonly place_tz: string;
  } | null;
  readonly chart: {
    readonly chart_id: string;
    readonly time_known: boolean;
    readonly engine_version: string;
    readonly created_at: string;
  } | null;
  readonly subscription: {
    readonly plan: string;
    readonly is_active: boolean;
    readonly expires_at: string | null;
    readonly auto_renew: boolean;
    readonly stars_paid_total: number;
  } | null;
  readonly grants: readonly {
    readonly id: string;
    readonly kind: string;
    readonly source: string;
    readonly days: number | null;
    readonly starts_at: string | null;
    readonly expires_at: string | null;
    readonly consumed_at: string | null;
    readonly revoked_at: string | null;
    readonly created_at: string;
  }[];
  readonly payments: readonly AdminPayment[];
  readonly counts: {
    readonly reports: number;
    readonly compatibility: number;
    readonly questions: number;
    readonly forecasts: number;
  };
  readonly cost_rub: number;
}

export interface AdminRefundResult {
  readonly ok: true;
  readonly charge_id: string;
  /** Полная сумма платежа из БД — в запросе её нет и быть не может. */
  readonly amount_stars: number;
  readonly refunded_at: string;
  /** Всегда `false`: возврат в этой волне не отзывает доступ автоматически. */
  readonly access_revoked: false;
}

export interface AdminBanResult {
  readonly user_id: string;
  readonly banned: boolean;
  readonly banned_at: string | null;
  readonly reason: string | null;
}

export interface AdminPushResult {
  readonly user_id: string;
  readonly sent: true;
  readonly sent_at: string;
  readonly kind: 'test';
}

/**
 * Пользователи в панели поддержки (контракт 1.6.16).
 *
 * Три правила, из-за которых код выглядит именно так:
 *
 *   1. **Список без ПДн.** Дата, время и место рождения живут только в
 *      карточке, а карточка пишет `user.card_view` в `admin_audit` в той же
 *      транзакции, что и чтение: «посмотрел данные человека» — событие.
 *   2. **Сумма возврата — не из запроса.** Возврат всегда полный
 *      (`refundStarPayment` не умеет частичный), сумма берётся из
 *      `payments.total_amount`; панель присылает только `charge_id` и причину.
 *   3. **Ошибка Telegram ничего не помечает.** `502` до записи в БД: иначе
 *      платёж выглядел бы возвращённым, а звёзды человеку не вернулись.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(AdminUsersRepository) private readonly repo: AdminUsersRepository,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** `id` из пути должен быть UUID: иначе `404`, а не `500` из Postgres. */
  private requireUserId(userId: string): void {
    if (!isUuid(userId)) {
      throw notFound(reasonOptions('user_not_found', 'Такого пользователя нет'));
    }
  }

  private ensureAdmin(actor: AdminActor, action: string): void {
    assertAdmin(actor, this.env.ADMIN_TG_ID);
    void action;
  }

  async search(actor: AdminActor, search: AdminUserSearch): Promise<AdminUserPage> {
    this.ensureAdmin(actor, 'user.search');
    const { rows, truncated } = await this.repo.search(search);
    const items = await Promise.all(rows.map((row) => this.toSummary(row)));

    return { items, truncated };
  }

  private async toSummary(row: AdminUserRow): Promise<AdminUserSummary> {
    // Подписка — через `EntitlementsService`: прямой запрос к таблице подписок
    // вне биллинга запрещён стражем, и второй формулы «что такое активная
    // подписка» быть не должно.
    const subscription = await this.entitlements.getSubscriptionState(row.user_id);

    return {
      user_id: row.user_id,
      alias: row.alias,
      has_subscription: subscription.is_active,
      subscription_plan: subscription.plan === 'none' ? null : subscription.plan,
      subscription_expires_at: subscription.is_active ? subscription.expires_at : null,
      banned: row.banned_at !== null,
      created_at: row.created_at.toISOString(),
      last_seen_at: row.last_seen_at?.toISOString() ?? null,
    };
  }

  /**
   * Карточка. Аудит пишется **до** чтения ПДн и в своей транзакции: если журнал
   * недоступен, карточка не откроется вовсе (`500 admin_audit_write_failed`) —
   * иначе данные человека читались бы без следа.
   */
  async card(actor: AdminActor, userId: string): Promise<AdminUserCard> {
    this.ensureAdmin(actor, 'user.card_view');
    this.requireUserId(userId);

    const user = await this.repo.byId(userId);

    if (user === null) {
      throw notFound(reasonOptions('user_not_found', 'Такого пользователя нет'));
    }

    await this.audit.record(actor, {
      action: 'user.card_view',
      entity: 'user',
      entityId: userId,
      // В журнал — факт просмотра, без самих данных: `before`/`after` — только
      // изменённые поля, а тут ничего не меняется.
      before: null,
      after: { viewed: true },
      reason: null,
    });

    const [telegramId, profile, chart, subscription, grants, payments, counts] = await Promise.all([
      this.repo.telegramIdOf(userId),
      this.repo.profile(userId),
      this.repo.chart(userId),
      this.entitlements.getSubscriptionState(userId),
      this.repo.grants(userId),
      this.repo.payments(userId),
      this.repo.countsAndCost(userId),
    ]);

    return {
      user_id: user.user_id,
      alias: user.alias,
      created_at: user.created_at.toISOString(),
      last_seen_at: user.last_seen_at?.toISOString() ?? null,
      telegram_id: telegramId,
      push_enabled: user.push_enabled,
      banned: user.banned_at !== null,
      banned_at: user.banned_at?.toISOString() ?? null,
      ban_reason: user.ban_reason,
      profile:
        profile === null
          ? null
          : {
              birth_date: profile.birth_date,
              birth_time: profile.birth_time,
              time_precision: profile.time_precision,
              place_name: profile.place_name,
              place_region: profile.place_region,
              place_country: profile.place_country,
              place_tz: profile.place_tz,
            },
      chart:
        chart === null
          ? null
          : {
              chart_id: chart.id,
              time_known: chart.time_known,
              engine_version: chart.engine_version,
              created_at: chart.created_at.toISOString(),
            },
      subscription:
        subscription.plan === 'none'
          ? null
          : {
              plan: subscription.plan,
              is_active: subscription.is_active,
              expires_at: subscription.expires_at,
              auto_renew: subscription.auto_renew,
              // В контракте поле необязательное — в БД его может не быть у
              // старой строки, поэтому ноль, а не `undefined` в JSON.
              stars_paid_total: subscription.stars_paid_total ?? 0,
            },
      grants: grants.map((grant) => ({
        id: grant.id,
        kind: grant.kind,
        source: grant.source,
        days: grant.days,
        starts_at: grant.starts_at?.toISOString() ?? null,
        expires_at: grant.expires_at?.toISOString() ?? null,
        consumed_at: grant.consumed_at?.toISOString() ?? null,
        revoked_at: grant.revoked_at?.toISOString() ?? null,
        created_at: grant.created_at.toISOString(),
      })),
      payments: payments.map((payment) => ({
        charge_id: payment.telegram_payment_charge_id,
        plan_code: payment.plan_code,
        amount_stars: payment.total_amount,
        status: payment.status,
        is_test: payment.is_test,
        paid_at: payment.paid_at.toISOString(),
        refunded_at: payment.refunded_at?.toISOString() ?? null,
      })),
      counts: counts.counts,
      cost_rub: counts.costRub,
    };
  }

  /**
   * `POST /admin/users/{id}/refund`.
   *
   * Порядок жёсткий: сначала проверки и `refundStarPayment`, потом запись. Если
   * Telegram отказал (или недоступен) — `502`, и платёж остаётся `paid`: панель
   * покажет «не получилось», а не «возвращено».
   */
  async refund(actor: AdminActor, userId: string, body: unknown): Promise<AdminRefundResult> {
    this.ensureAdmin(actor, 'user.refund');
    this.requireUserId(userId);

    const input = parseAdminRefund(body);
    const payment = await this.repo.paymentByChargeId(input.chargeId);

    // Чужой (или несуществующий) платёж — `404`, а не `403`: панель не должна
    // узнавать, что `charge_id` существует у другого человека.
    if (payment === null || payment.user_id !== userId) {
      throw notFound(reasonOptions('charge_not_found', 'Такого платежа у этого человека нет'));
    }

    if (payment.status === 'refunded' || payment.refunded_at !== null) {
      throw conflict(reasonOptions('already_refunded', 'Этот платёж уже возвращён'));
    }

    if (payment.status !== 'paid' && payment.status !== 'processed') {
      throw conflict(
        reasonOptions('nothing_to_refund', 'По этому платежу возвращать нечего: доступ не выдавался'),
      );
    }

    if (payment.telegram_id === null) {
      // Аккаунт обезличен (`DELETE /me`): звёзды вернуть некому — Telegram
      // требует `user_id`. Это не сбой, а состояние данных.
      throw conflict(
        reasonOptions('nothing_to_refund', 'Аккаунт удалён: Telegram не примет возврат без user_id'),
      );
    }

    let refunded: boolean;
    try {
      refunded = await this.telegram.refundStarPayment(Number(payment.telegram_id), input.chargeId);
    } catch (error) {
      this.logger.error('admin_refund_failed', {
        charge_tail: input.chargeId.slice(-6),
        reason: error instanceof Error ? error.name : 'unknown',
        request_id: currentRequestId(),
      });
      throw internalError({
        status: 502,
        ...reasonOptions('telegram_refund_failed', 'Telegram не подтвердил возврат. Платёж не изменён'),
      });
    }

    if (!refunded) {
      this.logger.warn('admin_refund_refused', {
        charge_tail: input.chargeId.slice(-6),
        request_id: currentRequestId(),
      });
      throw internalError({
        status: 502,
        ...reasonOptions('telegram_refund_failed', 'Telegram не подтвердил возврат. Платёж не изменён'),
      });
    }

    const refundedAt = await this.db.withTransaction(async (client) => {
      const at = await this.repo.markRefunded(client, payment.id);

      if (at === null) {
        // Гонка двух админов: второй возврат Telegram уже не подтвердил бы, но
        // строка могла стать `refunded` между проверкой и записью.
        throw conflict(reasonOptions('already_refunded', 'Этот платёж уже возвращён'));
      }

      await this.audit.write(client, actor, {
        action: 'user.refund',
        entity: 'user',
        entityId: userId,
        before: { status: payment.status },
        after: { status: 'refunded', refunded_at: at.toISOString() },
        reason: input.reason,
      });

      return at;
    });

    this.logger.info('admin_refund_issued', {
      charge_tail: input.chargeId.slice(-6),
      amount: payment.total_amount,
      access_revoked: false,
    });

    return {
      ok: true,
      charge_id: input.chargeId,
      amount_stars: payment.total_amount,
      refunded_at: refundedAt.toISOString(),
      access_revoked: false,
    };
  }

  /**
   * `POST /admin/users/{id}/ban`.
   *
   * Бан не отменяет подписку и не удаляет покупки: доступ перестаёт выдаваться
   * проверкой в `AccessService.hasAccess`, а деньги остаются деньгами. Разбан
   * возвращает доступ тем же снятием двух колонок.
   */
  async ban(actor: AdminActor, userId: string, body: unknown): Promise<AdminBanResult> {
    this.ensureAdmin(actor, 'user.ban');
    this.requireUserId(userId);

    const input = parseAdminBan(body);

    const outcome = await this.db.withTransaction(async (client) => {
      const updated = await this.repo.setBan(client, userId, input);

      if (updated === null) {
        return null;
      }

      await this.audit.write(client, actor, {
        action: input.banned ? 'user.ban' : 'user.unban',
        entity: 'user',
        entityId: userId,
        before: { banned: !input.banned },
        after: { banned: input.banned },
        reason: input.reason,
      });

      return updated;
    });

    if (outcome === null) {
      throw notFound(reasonOptions('user_not_found', 'Такого пользователя нет'));
    }

    this.logger.info('admin_user_ban_changed', {
      user_id: userId,
      banned: outcome.banned_at !== null,
    });

    return {
      user_id: userId,
      banned: outcome.banned_at !== null,
      banned_at: outcome.banned_at?.toISOString() ?? null,
      reason: outcome.ban_reason,
    };
  }

  /**
   * `POST /admin/users/{id}/push` — тестовый пуш.
   *
   * Отличия от утренней рассылки ровно те, которые нужны поддержке: окно
   * 08:00–08:04 и `last_seen_at` не проверяются (проверять их значило бы
   * «тестовый пуш не приходит почти никогда»). Всё остальное — как в проде:
   * согласие `push_enabled` уважается, журнал `push_log` пишется заявкой
   * **до** отправки, поэтому второй тестовый пуш за сутки невозможен.
   */
  async pushTest(actor: AdminActor, userId: string): Promise<AdminPushResult> {
    this.ensureAdmin(actor, 'user.push_test');
    this.requireUserId(userId);

    const user = await this.repo.byId(userId);
    if (user === null) {
      throw notFound(reasonOptions('user_not_found', 'Такого пользователя нет'));
    }

    if (!user.push_enabled) {
      throw conflict(
        reasonOptions('push_disabled', 'Человек отключил пуши: тестовый пуш не отправится'),
      );
    }

    const telegramId = await this.repo.telegramIdOf(userId);
    if (telegramId === null) {
      throw conflict(reasonOptions('push_disabled', 'Аккаунт удалён: писать некуда'));
    }

    const localDate = await this.repo.localDateOf(userId);

    const claimed = await this.db.withTransaction(async (client) => {
      const taken = await this.repo.claimTestPush(client, userId, localDate);

      if (!taken) {
        return false;
      }

      await this.audit.write(client, actor, {
        action: 'user.push_test',
        entity: 'user',
        entityId: userId,
        before: null,
        after: { kind: 'test', local_date: localDate },
        reason: 'тестовый пуш из панели',
      });

      return true;
    });

    if (!claimed) {
      throw conflict(
        reasonOptions('push_test_sent_24h', 'Тестовый пуш этому человеку уже уходил сегодня'),
      );
    }

    // Текст без ПДн и без модели: это проверка доставки, а не прогноз.
    const result = await this.telegram.sendPush(
      Number(telegramId),
      '<b>Тестовое сообщение</b>\nЭто проверка доставки пушей из панели. Прогноз дня придёт как обычно.',
    );

    if (result.status !== 'sent') {
      await this.repo.finishTestPush(userId, localDate, result.error ?? result.status);
      this.logger.warn('admin_push_test_failed', { user_id: userId, status: result.status });

      throw new ApiError('INTERNAL', 502, {
        ...reasonOptions('telegram_push_failed', 'Telegram не доставил тестовый пуш'),
        details: {
          reason: 'telegram_push_failed',
          status: result.status,
          retry_after: result.retryAfterSeconds,
        },
      });
    }

    const sentAt = await this.repo.finishTestPush(userId, localDate, null);

    return {
      user_id: userId,
      sent: true,
      sent_at: (sentAt ?? new Date()).toISOString(),
      kind: 'test',
    };
  }
}
