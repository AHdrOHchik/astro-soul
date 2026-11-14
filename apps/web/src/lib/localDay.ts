/**
 * The calendar day (`YYYY-MM-DD`) the moment `at` falls on in `timeZone`, an IANA name.
 * Null without a zone and for one the engine does not know: then nothing here can say
 * which day it is there, and the caller must not guess.
 */
export function localDayIn(timeZone: string | null | undefined, at: Date): string | null {
  if (!timeZone) return null;
  try {
    // Assembled from parts: how a locale orders and separates them is not something to rely on.
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    // RangeError: not a time zone, or one this engine has no data for.
    return null;
  }
}

/** Whether the moment is midnight by the clock of the device. */
export function isDeviceMidnight(at: Date): boolean {
  return at.getHours() === 0 && at.getMinutes() === 0;
}
