import { describe, expect, it } from 'vitest';
import { createTermsReload, REFUSED_VERSION_KEY } from './termsReload';

/** A storage of its own for every test, with the interface of `sessionStorage`. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(initial));
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const blocked = (): Storage => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

describe('createTermsReload', () => {
  it('reports the version refused before the restart, and only to the start right after it', () => {
    const storage = memoryStorage({ [REFUSED_VERSION_KEY]: '2026-01-01', other: 'kept' });

    expect(createTermsReload({ getStorage: () => storage }).refusedVersion).toBe('2026-01-01');
    expect(storage.getItem(REFUSED_VERSION_KEY)).toBeNull();
    expect(storage.getItem('other')).toBe('kept');
    expect(createTermsReload({ getStorage: () => storage }).refusedVersion).toBeNull();
  });

  it('keeps the refused version, and nothing else, for the next start', () => {
    const storage = memoryStorage();
    const terms = createTermsReload({ getStorage: () => storage });

    expect(terms.remember('2026-11-10')).toBe(true);

    expect(storage.length).toBe(1);
    expect(storage.getItem(REFUSED_VERSION_KEY)).toBe('2026-11-10');
    expect(createTermsReload({ getStorage: () => storage }).refusedVersion).toBe('2026-11-10');
  });

  it('works without a storage: an ordinary start, and nothing can be kept', () => {
    const terms = createTermsReload({ getStorage: blocked });
    expect(terms.refusedVersion).toBeNull();
    expect(terms.remember('2026-11-10')).toBe(false);
  });
});
