import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_MODES, subscriptionsModeOf } from './subscriptions';

describe('subscriptionsModeOf', () => {
  it.each(['enabled', ' enabled '])('sells subscriptions for %j, and for nothing else', (raw) => {
    expect(subscriptionsModeOf(raw)).toBe('enabled');
  });

  // The owner's decision: a build sells subscriptions only when told to. A variable that was forgotten must not sell.
  it.each([undefined, '', '   '])('sells none for %j: unset is the same as `off`', (raw) => {
    expect(subscriptionsModeOf(raw)).toBe('off');
  });

  it.each(['off', ' off '])('sells none for %j', (raw) => {
    expect(subscriptionsModeOf(raw)).toBe('off');
  });

  // What is sold must not hang on a typo: none of these is quietly read as either answer.
  it.each(['of', 'OFF', 'Off', 'on', '0', '1', 'yes', 'false', 'true', 'disabled', 'no', 'Enabled', 'ENABLED', 'enabled,off'])(
    'refuses %j: a value nobody can read is neither «sell» nor «do not sell»',
    (raw) => {
      expect(subscriptionsModeOf(raw)).toBeNull();
    },
  );

  it('knows two modes and no third', () => {
    expect([...SUBSCRIPTION_MODES]).toEqual(['enabled', 'off']);
  });
});
