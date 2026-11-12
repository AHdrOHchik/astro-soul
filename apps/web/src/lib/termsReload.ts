/*
 * The legal texts are part of the bundle. When the server refuses the consent version
 * this build sends, its texts are no longer the current ones, and newer texts can only
 * come with a newer build: the app loads itself again.
 *
 * One thing crosses that restart: the version the server refused, kept in
 * sessionStorage until the next start reads it. It tells that start why it happened.
 * Birth data never goes there; after the restart it is typed again.
 */

/** Exported for the tests and for trying the screens by hand (see README). */
export const REFUSED_VERSION_KEY = 'astro-soul.consent-refused';

/** A consent version is the date of the texts. Anything else in the storage is not ours to act on. */
const VERSION = /^\d{4}-\d{2}-\d{2}$/;

export interface TermsReload {
  /** The consent version the server refused right before this start; null on an ordinary start. */
  readonly refusedVersion: string | null;
  /** Keeps the refused version for the next start of this page. False when it could not be kept. */
  remember(version: string): boolean;
  /** Loads the page again, with whatever build is current by now. */
  reload(): void;
}

export interface TermsReloadOptions {
  /** Where the note is kept; `sessionStorage` by default. May throw: storage can be blocked. */
  getStorage?: () => Storage;
  reload?: () => void;
}

/** Reads the note of the previous start, once: the start after this one is an ordinary start again. */
export function createTermsReload(options: TermsReloadOptions = {}): TermsReload {
  const getStorage = options.getStorage ?? (() => window.sessionStorage);
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });

  let refusedVersion: string | null = null;
  try {
    const storage = getStorage();
    const stored = storage.getItem(REFUSED_VERSION_KEY);
    storage.removeItem(REFUSED_VERSION_KEY);
    if (stored !== null && VERSION.test(stored)) refusedVersion = stored;
  } catch {
    // No storage: an ordinary start.
  }

  return {
    refusedVersion,
    remember(version) {
      try {
        const storage = getStorage();
        storage.setItem(REFUSED_VERSION_KEY, version);
        // Read back: a storage with a zero quota takes the call and keeps nothing.
        return storage.getItem(REFUSED_VERSION_KEY) === version;
      } catch {
        return false;
      }
    },
    reload,
  };
}
