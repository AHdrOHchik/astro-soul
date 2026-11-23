export interface ShareTimeZone {
  /** A zone accepted by the server; never empty, even when the device reports a bad one. */
  value: string;
  /** Whether the value came from a valid device setting (rather than a safe fallback). */
  reliable: boolean;
}

/**
 * The card endpoint must always receive a timezone. When the device does not give
 * a valid one, Russian users get the product's default zone; other cards can use
 * UTC, but a dated moon card is hidden because its date could be misleading.
 */
export function resolveShareTimeZone(locale?: string, timeZone?: string): ShareTimeZone {
  let resolvedLocale = locale ?? '';
  let resolvedZone = timeZone ?? '';
  try {
    if (locale === undefined && timeZone === undefined) {
      const options = new Intl.DateTimeFormat().resolvedOptions();
      resolvedLocale = options.locale;
      resolvedZone = options.timeZone;
    }
  } catch {
    // Use the locale fallback below; a broken Intl implementation cannot block all sharing.
  }

  try {
    if (resolvedZone !== '') {
      const valid = new Intl.DateTimeFormat('en', { timeZone: resolvedZone }).resolvedOptions().timeZone;
      if (valid !== '') return { value: valid, reliable: true };
    }
  } catch {
    // Invalid or unsupported device timezone: use a safe, explicit fallback.
  }

  if (resolvedLocale.toLowerCase().startsWith('ru')) return { value: 'Europe/Moscow', reliable: false };
  return { value: 'UTC', reliable: false };
}
