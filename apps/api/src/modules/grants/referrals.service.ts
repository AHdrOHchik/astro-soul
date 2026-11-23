import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { GrantsService } from './grants.service';
import { GrantsRepository } from './grants.repository';

/**
 * Приглашения друзей (итерация 39, контракт 1.6.14).
 *
 * Правила, и каждое из них — про деньги:
 *   • **один уровень.** Приглашённый не приносит наград за своих приглашённых:
 *     иначе появляется «пирамида», и считать её стоимость невозможно;
 *   • **только новые.** Тот, у кого уже есть карта, приглашённым не считается:
 *     «пригласи себя старым аккаунтом» — самый дешёвый способ получить месяц;
 *   • **награда после карты.** Переход по ссылке ничего не стоит; 30 дней
 *     начисляются, когда приглашённый построил карту, то есть начал
 *     пользоваться продуктом;
 *   • **потолок 90 дней** на человека из этого источника. Три приглашённых
 *     друга — 90 дней; четвёртый ссылку принимает, но награды не приносит
 *     (проверяется **до** начисления, а не после);
 *   • **себя пригласить нельзя.** Ни через `ref_` своего же `short_id`, ни
 *     повторным переходом по чужой ссылке после регистрации.
 *
 * Ссылка — `t.me/<bot>?start=ref_<short_id>`. В `short_id` нет ни `telegram_id`,
 * ни `user_id`: ссылка не ПДн и её можно переслать.
 */

/** Дней доступа за одного приглашённого друга. */
export const REFERRAL_REWARD_DAYS = 30;

/** Потолок дней из этого источника на одного приглашающего. */
export const REFERRAL_MAX_DAYS = 90;

/** Алфавит `short_id` — как у карточек: без похожих символов, только строчные. */
const SHORT_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SHORT_LENGTH = 8;

/** `ref_<short>` из значения `start`/`startapp`. */
const REFERRAL_PATTERN = /^ref_([a-z2-9]{8})$/u;

export function parseReferralStart(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const match = REFERRAL_PATTERN.exec(value.trim());
  return match?.[1] ?? null;
}

function generateShortId(): string {
  let result = '';
  for (let index = 0; index < SHORT_LENGTH; index += 1) {
    result += SHORT_ALPHABET[randomInt(SHORT_ALPHABET.length)];
  }
  return result;
}

export type ReferralJoinResult = 'joined' | 'already' | 'self' | 'existing' | 'unknown';

export interface ReferralReward {
  readonly rewarded: boolean;
  readonly reason:
    | 'rewarded'
    | 'no_referral'
    | 'no_chart'
    | 'already_rewarded'
    | 'cap'
    | 'budget'
    | 'referrer_gone';
  readonly days: number;
}

@Injectable()
export class ReferralsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(GrantsRepository) private readonly grantsRepo: GrantsRepository,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Ссылка приглашения. `null` без `BOT_USERNAME`: битая ссылка хуже пустой. */
  linkFor(shortId: string): string | null {
    const bot = this.env.BOT_USERNAME;
    return bot === undefined ? null : `https://t.me/${bot}?start=ref_${shortId}`;
  }

  /** Сколько людей пришло по ссылке и сколько из них уже принесли награду. */
  async statsFor(userId: string): Promise<{ joined: number; rewarded: number }> {
    const row = await this.db.queryOne<{ joined: number; rewarded: number }>(
      `SELECT count(*)::int AS joined,
              count(*) FILTER (WHERE rewarded_at IS NOT NULL)::int AS rewarded
         FROM referrals
        WHERE referrer_id = $1`,
      [userId],
    );

    return { joined: row?.joined ?? 0, rewarded: row?.rewarded ?? 0 };
  }

  /**
   * `short_id` для ссылки. Генерируется лениво и один раз: ссылка, которая
   * меняется от запроса к запросу, ломает уже отправленные приглашения.
   */
  async ensureShortId(userId: string): Promise<string> {
    const current = await this.db.queryOne<{ referral_short_id: string | null }>(
      `SELECT referral_short_id FROM users WHERE id = $1`,
      [userId],
    );

    if (current?.referral_short_id !== null && current?.referral_short_id !== undefined) {
      return current.referral_short_id;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateShortId();
      const updated = await this.db.queryOne<{ referral_short_id: string }>(
        `UPDATE users
            SET referral_short_id = $2
          WHERE id = $1 AND referral_short_id IS NULL
          RETURNING referral_short_id`,
        [userId, candidate],
      );

      if (updated !== null) {
        return updated.referral_short_id;
      }

      // Либо другой процесс успел записать `short_id` (тогда он и правильный),
      // либо кандидат занят — обе причины различаются повторным чтением.
      const again = await this.db.queryOne<{ referral_short_id: string | null }>(
        `SELECT referral_short_id FROM users WHERE id = $1`,
        [userId],
      );

      if (again?.referral_short_id !== null && again?.referral_short_id !== undefined) {
        return again.referral_short_id;
      }
    }

    throw new Error('referral_short_id_failed');
  }

  /**
   * Запись приглашения (`/start ref_<short>` или `GET /me?start=ref_<short>`).
   *
   * Вызывается только для «нового» человека: `existing` — если у него уже есть
   * карта. Проверка на «мёртвый аккаунт» (`telegram_id IS NULL` после удаления)
   * тоже здесь: удалённого приглашать бессмысленно, он не вернётся.
   */
  async joinByShortId(shortId: string, referredUserId: string): Promise<ReferralJoinResult> {
    const referrer = await this.db.queryOne<{ id: string; telegram_id: string | null }>(
      `SELECT id, telegram_id FROM users WHERE referral_short_id = $1`,
      [shortId],
    );

    if (referrer === null || referrer.telegram_id === null) {
      return 'unknown';
    }

    if (referrer.id === referredUserId) {
      return 'self';
    }

    return this.db.withTransaction(async (client) => {
      const state = await client.query<{ has_chart: boolean; referred_by: string | null }>(
        `SELECT EXISTS (SELECT 1 FROM charts WHERE user_id = $1) AS has_chart,
                (SELECT referred_by FROM users WHERE id = $1) AS referred_by`,
        [referredUserId],
      );

      const row = state.rows[0];
      if (row === undefined) {
        return 'unknown';
      }

      if (row.referred_by !== null) {
        return 'already';
      }

      if (row.has_chart) {
        return 'existing';
      }

      await client.query(`UPDATE users SET referred_by = $2 WHERE id = $1`, [
        referredUserId,
        referrer.id,
      ]);

      await client.query(
        `INSERT INTO referrals (referred_id, referrer_id)
         VALUES ($1, $2)
         ON CONFLICT (referred_id) DO NOTHING`,
        [referredUserId, referrer.id],
      );

      this.logger.info('referral_joined', {
        referrer: referrer.id,
        referred: referredUserId,
      });

      return 'joined';
    });
  }

  /**
   * Награда после первой карты приглашённого.
   *
   * Вызывается из `POST /charts` **после** коммита карты: награда не должна
   * откатываться вместе с картой (человек карту построил, и это факт), но и
   * начисляться до неё не должна.
   *
   * Потолок 90 дней проверяется по сумме дневных грантов источника `referral`:
   * считаем выданные дни, а не число друзей, потому что «друг» — это строка,
   * которую можно добавить, а дни — то, что стоит денег.
   */
  async rewardAfterChart(referredUserId: string): Promise<ReferralReward> {
    const referral = await this.db.queryOne<{
      referrer_id: string;
      rewarded_at: Date | null;
      chart_created_at: Date | null;
    }>(
      `SELECT referrer_id, rewarded_at, chart_created_at
         FROM referrals
        WHERE referred_id = $1`,
      [referredUserId],
    );

    if (referral === null) {
      return { rewarded: false, reason: 'no_referral', days: 0 };
    }

    if (referral.rewarded_at !== null) {
      return { rewarded: false, reason: 'already_rewarded', days: 0 };
    }

    // Награда — только за карту. Проверка стоит здесь, а не «на честном слове»
    // вызывающего: `rewardAfterChart` может дёрнуть и джоб, и повторная
    // обработка события, и тогда «пригласил, но не построил» приносило бы
    // месяц за переход по ссылке.
    const chart = await this.db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM charts WHERE user_id = $1 LIMIT 1`,
      [referredUserId],
    );

    if (chart === null) {
      return { rewarded: false, reason: 'no_chart', days: 0 };
    }

    await this.db.query(
      `UPDATE referrals SET chart_created_at = COALESCE(chart_created_at, now()) WHERE referred_id = $1`,
      [referredUserId],
    );

    const referrer = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [referral.referrer_id],
    );

    if (referrer === null) {
      // Пригласивший удалил аккаунт: награждать некого, и это не ошибка.
      return { rewarded: false, reason: 'referrer_gone', days: 0 };
    }

    const grantedDays = await this.grantsRepo.grantedDaysBySource(
      referral.referrer_id,
      'referral',
    );

    if (grantedDays + REFERRAL_REWARD_DAYS > REFERRAL_MAX_DAYS) {
      // Строка приглашения остаётся без `rewarded_at`: если владелец поднимет
      // потолок, награда доедет, а «начислено» задним числом не появится.
      await this.db.query(`UPDATE referrals SET rewarded_at = NULL WHERE referred_id = $1`, [
        referredUserId,
      ]);

      this.logger.info('referral_reward_capped', {
        referrer: referral.referrer_id,
        referred: referredUserId,
        granted_days: grantedDays,
        cap_days: REFERRAL_MAX_DAYS,
      });

      return { rewarded: false, reason: 'cap', days: 0 };
    }

    try {
      await this.grants.issue({
        userId: referral.referrer_id,
        kind: 'all_access',
        source: 'referral',
        days: REFERRAL_REWARD_DAYS,
        checkBudget: true,
      });
    } catch (error) {
      // Бюджет исчерпан — награда не выдаётся, но приглашение не теряется:
      // `rewarded_at` остаётся NULL, и следующий прогон попробует снова.
      this.logger.warn('referral_reward_skipped', {
        referrer: referral.referrer_id,
        referred: referredUserId,
        reason: error instanceof Error ? error.message : String(error),
      });

      return { rewarded: false, reason: 'budget', days: 0 };
    }

    await this.db.query(`UPDATE referrals SET rewarded_at = now() WHERE referred_id = $1`, [
      referredUserId,
    ]);

    this.logger.info('referral_rewarded', {
      referrer: referral.referrer_id,
      referred: referredUserId,
      days: REFERRAL_REWARD_DAYS,
    });

    return { rewarded: true, reason: 'rewarded', days: REFERRAL_REWARD_DAYS };
  }
}
