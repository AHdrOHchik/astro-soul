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

export type TimeMode = 'exact' | 'approximate' | 'unknown';

export interface UpsertProfileInput {
  readonly userId: string;
  readonly birthDate: string;
  readonly birthTime: string | null;
  readonly timeMode: TimeMode;
  readonly place: {
    readonly name: string;
    readonly region?: string | null;
    readonly country: string;
    readonly lat: number;
    readonly lon: number;
    readonly tz: string;
  };
  /** Версия текста согласия, которую показал фронт (контракт 1.2.1). */
  readonly consentVersion: string;
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

  /**
   * Профиль рождения сохраняется вместе с картой (`POST /charts`): это
   * завершение онбординга. `consent_at` пишется только при первом согласии —
   * повторное «я согласен» не переписывает дату задним числом.
   */
  async upsertProfile(input: UpsertProfileInput): Promise<void> {
    await this.db.query(
      `INSERT INTO profiles (
         user_id, birth_date, birth_time, time_mode, place_name, place_region,
         place_country, place_lat, place_lon, place_tz, consent_at, consent_version,
         onboarding_step
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, 'done')
       ON CONFLICT (user_id) DO UPDATE SET
         birth_date = EXCLUDED.birth_date,
         birth_time = EXCLUDED.birth_time,
         time_mode = EXCLUDED.time_mode,
         place_name = EXCLUDED.place_name,
         place_region = EXCLUDED.place_region,
         place_country = EXCLUDED.place_country,
         place_lat = EXCLUDED.place_lat,
         place_lon = EXCLUDED.place_lon,
         place_tz = EXCLUDED.place_tz,
         consent_at = COALESCE(profiles.consent_at, EXCLUDED.consent_at),
         consent_version = EXCLUDED.consent_version,
         onboarding_step = 'done'`,
      [
        input.userId,
        input.birthDate,
        input.birthTime,
        input.timeMode,
        input.place.name,
        input.place.region ?? null,
        input.place.country,
        input.place.lat,
        input.place.lon,
        input.place.tz,
        input.consentVersion,
      ],
    );
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
