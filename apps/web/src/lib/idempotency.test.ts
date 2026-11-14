import { describe, expect, it } from 'vitest';
import { createIdempotencyKeys, REPORT_KEY_PREFIX } from './idempotency';

const CHART = '00000000-0000-4000-8000-00000000c0de';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOUR = 60 * 60 * 1000;

/** A storage of its own per test, and a clock the test moves. */
function setup(storage: Storage | null = memoryStorage()) {
  const clock = { now: Date.UTC(2026, 10, 10, 12) };
  const options = {
    getStorage: () => {
      if (storage === null) throw new DOMException('Storage is blocked', 'SecurityError');
      return storage;
    },
    now: () => clock.now,
  };
  // `restart()` is the page loaded again: nothing in memory, the same storage.
  return { keys: createIdempotencyKeys(options), restart: () => createIdempotencyKeys(options), clock, storage };
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (name) => items.get(name) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (name) => {
      items.delete(name);
    },
    setItem: (name, value) => {
      items.set(name, value);
    },
  };
}

describe('idempotency keys of report orders', () => {
  it('makes a UUID v4 and gives the same one for the same chart until told otherwise, also after a reload', () => {
    const { keys, restart, storage } = setup();

    const key = keys.current(CHART, 'full');

    expect(key).toMatch(UUID_V4);
    expect(keys.current(CHART, 'full')).toBe(key);
    expect(restart().current(CHART, 'full')).toBe(key);
    // What is kept is a random id under the id of a chart: nothing about the user.
    expect(storage?.getItem(`${REPORT_KEY_PREFIX}full.${CHART}`)).toContain(key);
    expect(storage?.length).toBe(1);
  });

  it('keeps a key per chart and per kind of report', () => {
    const { keys } = setup();
    const key = keys.current(CHART, 'full');
    expect(keys.current(CHART, 'solar')).not.toBe(key);
    expect(keys.current('00000000-0000-4000-8000-00000000beef', 'full')).not.toBe(key);
  });

  it('makes a new one only on purpose, and that one is the key from then on', () => {
    const { keys, restart } = setup();
    const first = keys.current(CHART, 'full');

    const second = keys.renew(CHART, 'full');

    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
    expect(keys.current(CHART, 'full')).toBe(second);
    expect(restart().current(CHART, 'full')).toBe(second);
  });

  it('does not send a key the server has forgotten: after 24 hours the order is a new one', () => {
    const { keys, clock } = setup();
    const key = keys.current(CHART, 'full');

    clock.now += 24 * HOUR - 1;
    expect(keys.current(CHART, 'full')).toBe(key);
    clock.now += 1;
    expect(keys.current(CHART, 'full')).not.toBe(key);
  });

  it('works without a storage: the same key for a double tap, as long as the page lives', () => {
    const { keys } = setup(null);
    const key = keys.current(CHART, 'full');
    expect(keys.current(CHART, 'full')).toBe(key);
    expect(keys.renew(CHART, 'full')).not.toBe(key);
  });

  it('takes nothing else found in the storage for a key', () => {
    const { keys, storage } = setup();
    storage?.setItem(`${REPORT_KEY_PREFIX}full.${CHART}`, '<script>alert(1)</script>');
    expect(keys.current(CHART, 'full')).toMatch(UUID_V4);
  });
});
