import { Inject, Injectable } from '@nestjs/common';
import { QUOTA_CODES, quotaLimits, type Entitlements, type Quota, type QuotaCode } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

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

function periodKey(kind: PeriodKind, now: Date): string {
  const year = now.getUTCFullYear();
  const month = pad(now.getUTCMonth() + 1);
  if (kind === 'month') {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${pad(now.getUTCDate())}`;
}

function periodResetAt(kind: PeriodKind, now: Date): Date {
  if (kind === 'month') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
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
  ): Promise<Quota[]> {
    const limits = quotaLimits(entitlements);

    const keys = new Map<QuotaCode, string>(
      QUOTA_CODES.map((code) => [code, periodKey(PERIOD_KIND[code], now)]),
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
      reset_at: periodResetAt(PERIOD_KIND[code], now).toISOString(),
    }));
  }
}
