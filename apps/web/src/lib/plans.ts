import { priceOf } from '@astro-soul/shared';
import type { Me, PlanCode } from '../api';

/*
 * What the paywall sells. The codes are the contract's (`PlanCode`): one that is renamed or
 * removed there breaks the build here. The prices are not written in the app at all: the
 * expected one comes from the table every part of the project shares (packages/shared,
 * payments.md §1), the charged one from the invoice the server makes.
 */

/** The full report: bought once, for one chart. No subscription includes it. */
export const REPORT_PLAN = 'one_149' satisfies PlanCode;

/** The subscriptions, in the order the paywall lists them. */
export const SUBSCRIPTION_PLANS = ['week_149', 'month_399', 'year_2990'] as const satisfies readonly PlanCode[];

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];
export type PaywallPlan = typeof REPORT_PLAN | SubscriptionPlan;

/**
 * The price the app shows before there is an invoice. Once there is one, its `stars` is
 * the price: the server's number wins over this one wherever they differ.
 */
export function expectedStars(plan: PaywallPlan): number {
  return priceOf(plan);
}

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
 * Whether the server's `Me` grants what was bought: the plan, and for the full report the
 * chart it was bought for (null for a subscription, which is about no chart). The only
 * confirmation of a purchase there is: what Telegram says when an invoice closes is not one.
 */
export function grants(me: Me, plan: PaywallPlan, chartId: string | null): boolean {
  if (plan !== REPORT_PLAN) return me.entitlements.is_active;
  return chartId !== null && hasReportFor(me, chartId);
}
