import type { Me } from '../api';

/** Stable contract code for the full-report product; prices and offer copy come from the server. */
export const REPORT_PLAN = 'one_149';

/**
 * Whether the full report of this chart is paid for, by the server's last word. The one
 * place the app answers that question: the chart screen asks it to choose between the
 * price and the report, and `grants` asks it to confirm a purchase.
 *
 * The report is bought for a chart, and `Me` names that chart. `full_report` alone says
 * only that the user has bought a report of some chart: for any other chart of theirs the
 * answer here is «no», and so it is when the server names no chart at all (`null`: the
 * purchase went with the user's data).
 */
export function hasReportFor(me: Me, chartId: string): boolean {
  return me.entitlements.full_report_chart_id === chartId;
}

/**
 * Whether the server's `Me` confirms the purchase: report purchases must name the chart they
 * were made for; every other purchase is confirmed by the server's active entitlement. Telegram's
 * word when an invoice closes is not confirmation.
 */
export function grants(me: Me, isReportPurchase: boolean, chartId: string | null): boolean {
  if (!isReportPurchase) return me.entitlements.is_active;
  return chartId !== null && hasReportFor(me, chartId);
}
