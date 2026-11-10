import type { QuotaCode } from './contracts';
import type { Entitlements } from './entitlements';

export type { QuotaCode };

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
