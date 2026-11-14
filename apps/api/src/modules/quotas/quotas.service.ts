import { Inject, Injectable } from '@nestjs/common';
import { QUOTA_CODES, quotaLimits, type Entitlements, type Quota, type QuotaCode } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { localParts, nextLocalMidnight } from '../engagement/local-time';

type PeriodKind = 'day' | 'month';

const PERIOD_KIND: Readonly<Record<QuotaCode, PeriodKind>> = {
  forecast_daily: 'day',
  ask_daily: 'day',
  report_month: 'month',
  compat_month: 'month',
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Ключ периода. Дневные квоты считаются по местным суткам места рождения:
 * «1 вопрос в день» для человека означает его день, а не UTC (итерация 10).
 * Без пояса (UTC) поведение прежнее.
 */
function periodKey(kind: PeriodKind, now: Date, timeZone = 'UTC'): string {
  const local = localParts(now, timeZone);
  if (local !== null) {
    return kind === 'month' ? local.date.slice(0, 7) : local.date;
  }

  const year = now.getUTCFullYear();
  const month = pad(now.getUTCMonth() + 1);
  if (kind === 'month') {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${pad(now.getUTCDate())}`;
}

function periodResetAt(kind: PeriodKind, now: Date, timeZone = 'UTC'): Date {
  if (kind === 'month') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }
  return nextLocalMidnight(now, timeZone);
}

/**
 * Квоты только читаются отсюда; списание делает соответствующий обработчик
 * (`POST /engagement/ask` и т.д.) — в следующих итерациях.
 * Лимиты выводятся из `Entitlements`, второй правды о доступах нет.
 */
@Injectable()
export class QuotasService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async listQuotas(
    userId: string,
    entitlements: Entitlements,
    now: Date = new Date(),
    timeZone = 'UTC',
  ): Promise<Quota[]> {
    const limits = quotaLimits(entitlements);

    const keys = new Map<QuotaCode, string>(
      QUOTA_CODES.map((code) => [code, periodKey(PERIOD_KIND[code], now, timeZone)]),
    );

    const usage = await this.db.query<{ code: QuotaCode; period_key: string; used: number }>(
      `SELECT code::text AS code, period_key, used
         FROM quotas
        WHERE user_id = $1 AND period_key = ANY($2::text[])`,
      [userId, [...new Set(keys.values())]],
    );

    const usedByCode = new Map<QuotaCode, number>();
    for (const row of usage) {
      if (keys.get(row.code) === row.period_key) {
        usedByCode.set(row.code, row.used);
      }
    }

    return QUOTA_CODES.map((code) => ({
      code,
      used: usedByCode.get(code) ?? 0,
      limit: limits[code],
      reset_at: periodResetAt(PERIOD_KIND[code], now, timeZone).toISOString(),
    }));
  }

  /** Одна квота из тех же данных: используется в ответах `/engagement/ask`. */
  async one(
    userId: string,
    code: QuotaCode,
    entitlements: Entitlements,
    now: Date = new Date(),
    timeZone = 'UTC',
  ): Promise<Quota> {
    const all = await this.listQuotas(userId, entitlements, now, timeZone);
    return all.find((quota) => quota.code === code) ?? {
      code,
      used: 0,
      limit: quotaLimits(entitlements)[code],
      reset_at: periodResetAt(PERIOD_KIND[code], now, timeZone).toISOString(),
    };
  }

  /**
   * Списать одну единицу квоты. Возвращает `false`, если лимит уже выбран:
   * проверка и запись — один `UPDATE`, поэтому два параллельных вопроса
   * не могут оба пройти в последнюю единицу.
   *
   * `limit = -1` — безлимит: списываем, но не ограничиваем.
   */
  async consume(
    userId: string,
    code: QuotaCode,
    entitlements: Entitlements,
    now: Date = new Date(),
    timeZone = 'UTC',
  ): Promise<{ allowed: boolean; quota: Quota }> {
    const limit = quotaLimits(entitlements)[code];
    const kind = PERIOD_KIND[code];
    const key = periodKey(kind, now, timeZone);

    const row = await this.db.queryOne<{ used: number }>(
      `INSERT INTO quotas (user_id, code, period_key, used, reset_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (user_id, code, period_key) DO UPDATE
         SET used = quotas.used + 1
       WHERE $5::int < 0 OR quotas.used < $5::int
       RETURNING used`,
      [userId, code, key, periodResetAt(kind, now, timeZone), limit],
    );

    const used = row?.used ?? -1;

    return {
      allowed: limit < 0 || used >= 0,
      quota: {
        code,
        used: used < 0 ? limit : used,
        limit,
        reset_at: periodResetAt(kind, now, timeZone).toISOString(),
      },
    };
  }

  /**
   * Вернуть списанную единицу: модель упала — вопрос не состоялся, и
   * отнимать у человека лимит за ошибку провайдера нельзя.
   */
  async release(
    userId: string,
    code: QuotaCode,
    now: Date = new Date(),
    timeZone = 'UTC',
  ): Promise<void> {
    const kind = PERIOD_KIND[code];
    await this.db.query(
      `UPDATE quotas SET used = greatest(used - 1, 0)
        WHERE user_id = $1 AND code = $2 AND period_key = $3 AND used > 0`,
      [userId, code, periodKey(kind, now, timeZone)],
    );
  }
}
