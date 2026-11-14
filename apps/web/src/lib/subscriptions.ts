/** What `VITE_SUBSCRIPTIONS` may be set to. */
export const SUBSCRIPTION_MODES = ['enabled', 'off'] as const;
export type SubscriptionsMode = (typeof SUBSCRIPTION_MODES)[number];

/**
 * Whether this build sells subscriptions, from what the owner set at build time:
 * `enabled`, the same as nothing, or `off`. Null for anything else: a value nobody can
 * read must not quietly become either answer, so the build stops on it (vite.config.ts).
 */
export function subscriptionsModeOf(raw: string | undefined): SubscriptionsMode | null {
  const value = (raw ?? '').trim();
  if (value === '') return 'enabled';
  return (SUBSCRIPTION_MODES as readonly string[]).includes(value) ? (value as SubscriptionsMode) : null;
}
