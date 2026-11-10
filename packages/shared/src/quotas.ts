import type { Entitlements } from './entitlements';

/** Коды квот из контракта (`Quota.code`). */
export const QUOTA_CODES = ['forecast_daily', 'ask_daily', 'report_month', 'compat_month'] as const;

export type QuotaCode = (typeof QUOTA_CODES)[number];

/** `limit = -1` в контракте означает «безлимит». */
export const UNLIMITED = -1;

/**
 * Лимиты квот выводятся только из `Entitlements` — чтобы не было второй
 * точки правды о доступах. `report_month` не ограничивает покупку разбора
 * (его гейтит `fullReport`/`entitlements`), но фронт ждёт все четыре квоты.
 */
export function quotaLimits(entitlements: Entitlements): Record<QuotaCode, number> {
  return {
    forecast_daily: entitlements.fullForecast ? UNLIMITED : 1,
    ask_daily: entitlements.askPerDay,
    report_month: entitlements.fullReport ? UNLIMITED : 0,
    compat_month: entitlements.compatPerMonth,
  };
}
