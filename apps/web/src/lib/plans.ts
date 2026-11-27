import type { Me } from '../api';

/** Stable contract code for the full-report product; prices and offer copy come from the server. */
export const REPORT_PLAN = 'one_149';

/**
 * Whether the server's `Me` confirms the purchase the app is waiting for. Telegram's word when an
 * invoice closes is not confirmation; only the server's active entitlement is.
 *
 * A report is bought for one chart, so its confirmation names that chart
 * (`entitlements.full_report_chart_id`). This is **not** an access decision: whether the report may
 * be opened is the server's `Me.report_access`, read in `lib/reportAccess.ts` and nowhere else. The
 * two questions are different, and round46 was the app answering the second with the first: a person
 * whose report came from a code saw «купить» and a `422 report_already_owned` behind the button.
 */
export function grants(me: Me, isReportPurchase: boolean, chartId: string | null): boolean {
  if (!isReportPurchase) return me.entitlements.is_active;
  return chartId !== null && me.entitlements.full_report_chart_id === chartId;
}
