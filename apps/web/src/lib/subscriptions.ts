/** What `VITE_SUBSCRIPTIONS` may be set to. */
export const SUBSCRIPTION_MODES = ['enabled', 'off'] as const;
export type SubscriptionsMode = (typeof SUBSCRIPTION_MODES)[number];

/**
 * Whether this build sells subscriptions, from what the owner set at build time. They are
 * sold only when the variable says `enabled`: left unset or empty it is `off`, the same as
 * `off` itself. A subscription sold by mistake is money taken and owed back; one not sold
 * by mistake is a sale lost until the next build. So forgetting the variable must not sell.
 *
 * Null for anything else: a value nobody can read must not quietly become either answer,
 * so the build stops on it (scripts/buildSettings.ts).
 */
export function subscriptionsModeOf(raw: string | undefined): SubscriptionsMode | null {
  const value = (raw ?? '').trim();
  if (value === '') return 'off';
  return (SUBSCRIPTION_MODES as readonly string[]).includes(value) ? (value as SubscriptionsMode) : null;
}
