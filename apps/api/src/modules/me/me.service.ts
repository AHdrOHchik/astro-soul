import { Inject, Injectable } from '@nestjs/common';
import type { Me, OnboardingStep } from '@astro-soul/shared';
import { displayNameOf, type VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { QuotasService } from '../quotas/quotas.service';

@Injectable()
export class MeService {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QuotasService) private readonly quotas: QuotasService,
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
      subscription,
      quotas,
      onboarding_step: onboardingStep,
    };
  }
}
