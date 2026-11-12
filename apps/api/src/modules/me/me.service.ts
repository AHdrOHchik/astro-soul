import { Inject, Injectable } from '@nestjs/common';
import type { Entitlements, Me, OnboardingStep } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { conflict } from '../../common/api-error';
import { displayNameOf, type VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { QuotasService } from '../quotas/quotas.service';
import { EventsRepository } from '../events/events.repository';

/**
 * `Entitlements` (packages/shared, camelCase) → контракт (`Me.entitlements`,
 * snake_case, как и остальные поля ответа).
 */
export function toEntitlementsDto(entitlements: Entitlements): NonNullable<Me['entitlements']> {
  return {
    is_active: entitlements.isActive,
    plan: entitlements.plan,
    full_forecast: entitlements.fullForecast,
    ask_per_day: entitlements.askPerDay as 0 | 1 | 5 | -1,
    full_report: entitlements.fullReport,
    compat_per_month: entitlements.compatPerMonth,
    solar_included: entitlements.solarIncluded,
  };
}

@Injectable()
export class MeService {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QuotasService) private readonly quotas: QuotasService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
  ) {}

  async getMe(auth: VerifiedInitData): Promise<Me> {
    const { userId, isNew } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    const [profileState, entitlements, subscription] = await Promise.all([
      this.users.getProfileState(userId),
      this.entitlements.getEntitlements(userId),
      this.entitlements.getSubscriptionState(userId),
    ]);

    const quotas = await this.quotas.listQuotas(userId, entitlements);

    const onboardingStep: OnboardingStep =
      profileState.onboardingStep ?? (profileState.hasProfile ? 'done' : 'birth_date');

    return {
      user_id: userId,
      // Имя берём из проверенного initData и не сохраняем: это ПДн.
      display_name: displayNameOf(auth.user),
      is_new: isNew,
      has_profile: profileState.hasProfile,
      has_chart: profileState.hasChart,
      // Карта, к которой ведёт кнопка «моя карта» и `GET /charts/current`.
      chart_id: profileState.chartId,
      subscription,
      // Реальные права из getEntitlements(userId): фронт рисует по ним
      // пейволл, но доступ всё равно решается на сервере (payments.md §4).
      entitlements: toEntitlementsDto(entitlements),
      quotas,
      onboarding_step: onboardingStep,
    };
  }

  /**
   * `DELETE /me` (SPEC «Сценарий 6», ПДн).
   *
   * Удаляем ровно персональные данные: `users` и каскадом `profiles`, `charts`,
   * `reports`, `forecasts`, `asks`, плюс счётчики квот. Платежи и подписки
   * остаются (это бухгалтерия), но обезличиваются: `telegram_id = NULL`.
   *
   * 409 CONFLICT, если есть платёж, за который деньги уже списаны, а доступ
   * ещё не выдан — иначе пользователь потеряет оплаченное.
   */
  async deleteMe(auth: VerifiedInitData): Promise<void> {
    const userId = this.users.userIdFor(auth.telegramUserId);

    await this.db.withTransaction(async (client) => {
      const pending = await client.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM payments
            WHERE user_id = $1 AND processed = false AND status = 'paid'
         ) AS pending`,
        [userId],
      );

      if (pending.rows[0]?.pending === true) {
        throw conflict({ reason: 'payments_pending' });
      }

      // Платежи переживают удаление и без ПДн: charge_id нужен для возвратов.
      await client.query(
        `UPDATE payments SET telegram_id = NULL, anonymized_at = now()
          WHERE user_id = $1 AND anonymized_at IS NULL`,
        [userId],
      );

      await client.query(`DELETE FROM quotas WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });

    await this.events.log({ name: 'account_deleted' });
  }
}
