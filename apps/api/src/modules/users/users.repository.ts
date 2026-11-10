import { Inject, Injectable } from '@nestjs/common';
import type { OnboardingStep } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { userIdFromTelegramId } from './pseudonym';

export interface ProfileState {
  readonly hasProfile: boolean;
  readonly hasChart: boolean;
  readonly onboardingStep: OnboardingStep | null;
}

export interface EnsureUserInput {
  readonly telegramUserId: bigint;
  readonly languageCode: string | undefined;
}

export interface EnsureUserResult {
  readonly userId: string;
  readonly isNew: boolean;
}

@Injectable()
export class UsersRepository {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  userIdFor(telegramUserId: bigint): string {
    return userIdFromTelegramId(telegramUserId, this.env.PSEUDONYM_PEPPER);
  }

  /**
   * Идемпотентно создаёт пользователя. Побочный эффект только один:
   * при первом входе появляется строка `users` (это и есть `is_new`).
   */
  async ensureUser(input: EnsureUserInput): Promise<EnsureUserResult> {
    const userId = this.userIdFor(input.telegramUserId);

    const row = await this.db.queryOne<{ id: string; is_new: boolean }>(
      `INSERT INTO users (id, telegram_id, language_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE
         SET language_code = COALESCE(EXCLUDED.language_code, users.language_code)
       RETURNING id, (xmax = 0) AS is_new`,
      [userId, input.telegramUserId.toString(), input.languageCode ?? null],
    );

    if (row === null) {
      // Единственный способ получить null — конфликт по id с другой строкой,
      // то есть рассогласование перца. Это ошибка конфигурации, а не пользователя.
      throw new Error('Не удалось создать пользователя: конфликт идентификатора');
    }

    return { userId: row.id, isNew: row.is_new };
  }

  async getProfileState(userId: string): Promise<ProfileState> {
    const row = await this.db.queryOne<{
      has_profile: boolean;
      has_chart: boolean;
      onboarding_step: OnboardingStep | null;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM profiles WHERE user_id = $1) AS has_profile,
         EXISTS (SELECT 1 FROM charts WHERE user_id = $1) AS has_chart,
         (SELECT onboarding_step::text FROM profiles WHERE user_id = $1) AS onboarding_step`,
      [userId],
    );

    return {
      hasProfile: row?.has_profile ?? false,
      hasChart: row?.has_chart ?? false,
      onboardingStep: row?.onboarding_step ?? null,
    };
  }
}
