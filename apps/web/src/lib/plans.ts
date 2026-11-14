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
 * Whether the server's `Me` grants what the plan sells. The only confirmation of a
 * purchase there is: what Telegram says when an invoice closes is not one.
 */
export function grants(me: Me, plan: PaywallPlan): boolean {
  return plan === REPORT_PLAN ? me.entitlements.full_report : me.entitlements.is_active;
}
