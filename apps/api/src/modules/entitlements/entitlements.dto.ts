import type { Entitlements, GrantEntitlements, Me } from '@astro-soul/shared';

/**
 * `Entitlements` (camelCase, внутренняя форма) → `Me.entitlements` (контракт,
 * snake_case) — в одном месте, потому что эта форма нужна и `GET /me`, и
 * `POST /me/activate-code`, и `POST /me/founder-claim`. Две копии разошлись бы
 * ровно на том поле, которое добавили позже.
 *
 * Поля грантов (1.6.14) **необязательные**: старый клиент их не читает, новый
 * без них не падает (он вообще обязан пережить отсутствие всего блока).
 */
export function toEntitlementsDto(
  entitlements: Entitlements,
  grants: GrantEntitlements,
): NonNullable<Me['entitlements']> {
  return {
    is_active: entitlements.isActive,
    plan: entitlements.plan,
    full_forecast: entitlements.fullForecast,
    ask_per_day: entitlements.askPerDay as 0 | 1 | 5 | -1,
    full_report: entitlements.fullReport,
    full_report_chart_id: entitlements.fullReportChartId,
    compat_per_month: entitlements.compatPerMonth,
    solar_included: entitlements.solarIncluded,
    all_access_until: grants.allAccessUntil,
    source: grants.source,
    single_reports: grants.singleReports,
    single_compat: grants.singleCompat,
    is_founder: grants.isFounder,
    founder_place: grants.founderPlace,
  };
}
