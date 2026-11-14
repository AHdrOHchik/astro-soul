/*
 * The key that makes a repeated order of a report the same order (`Idempotency-Key` of
 * `POST /reports`): the server answers a key it knows with the report it already has, so a
 * double tap or a repeat after a lost answer never orders, or charges, twice.
 *
 * A key is made when the user asks for the report and kept under the chart and the kind of
 * report until the user decides to order anew, after a report that failed. It is kept in
 * sessionStorage, so it outlives a reload of the page, and holds nothing about the user: a
 * random id under the id of a chart.
 */

/** Exported for the tests and for looking at the storage by hand. */
export const REPORT_KEY_PREFIX = 'astro-soul.report-key.';

/** The server remembers a key for 24 hours. An older one would be a new order anyway: better made on purpose. */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface IdempotencyKeys {
  /** The key of the order in progress for this chart: the one kept, or a new one, kept from now on. */
  current(chartId: string, type: string): string;
  /** A new key in place of the kept one: the next order is a new order. */
  renew(chartId: string, type: string): string;
}

export interface IdempotencyKeysOptions {
  /** Where the keys are kept; `sessionStorage` by default. May throw: storage can be blocked. */
  getStorage?: () => Storage;
  now?: () => number;
  uuid?: () => string;
}

/** A random UUID (version 4). `crypto.randomUUID` is newer than the oldest supported WebViews, `getRandomValues` is not. */
function uuid4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createIdempotencyKeys(options: IdempotencyKeysOptions = {}): IdempotencyKeys {
  const getStorage = options.getStorage ?? (() => window.sessionStorage);
  const now = options.now ?? (() => Date.now());
  const uuid = options.uuid ?? uuid4;
  // What the storage could not keep is kept here: a double tap must find the same key even in a browser without storage.
  const memory = new Map<string, string>();

  const read = (name: string): string | null => {
    // This page's own record first: it is the latest even when the storage refused the last write.
    let stored = memory.get(name) ?? null;
    if (stored === null) {
      try {
        stored = getStorage().getItem(name);
      } catch {
        return null;
      }
    }
    if (stored === null) return null;
    const [createdAt = '', key = ''] = stored.split(' ');
    const age = now() - Number(createdAt);
    // Anything else under this name is not a key of ours to send.
    return UUID.test(key) && age >= 0 && age < KEY_TTL_MS ? key : null;
  };

  const create = (name: string): string => {
    const key = uuid();
    const value = `${String(now())} ${key}`;
    memory.set(name, value);
    try {
      getStorage().setItem(name, value);
    } catch {
      // No storage: the key lives as long as the page does.
    }
    return key;
  };

  const nameOf = (chartId: string, type: string) => `${REPORT_KEY_PREFIX}${type}.${chartId}`;

  return {
    current(chartId, type) {
      const name = nameOf(chartId, type);
      return read(name) ?? create(name);
    },
    renew(chartId, type) {
      return create(nameOf(chartId, type));
    },
  };
}
