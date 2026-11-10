/* Locale-aware formatting of contract values. No user-facing words live here: see ru.ts. */

const LOCALE = 'ru-RU';
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `1994-05-17` → «17 мая 1994 г.». Returns the input when it is not an ISO date. */
export function formatDate(iso: string): string {
  const match = ISO_DATE.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  // Built and printed in UTC: a calendar date must not shift with the device time zone.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** «Телец, 26°07′» from the localized sign and the degrees inside it. */
export function formatPosition(sign: string, degree?: number, minute?: number): string {
  if (degree === undefined) return sign;
  const minutes = minute === undefined ? '' : `${String(minute).padStart(2, '0')}′`;
  return `${sign}, ${String(degree)}°${minutes}`;
}

/** Country name for an ISO 3166 code («RU» → «Россия»); the raw value when it cannot be resolved. */
export function countryName(code: string): string {
  try {
    // Intl.DisplayNames is missing in the oldest supported WebViews (Chromium 80).
    const names = new Intl.DisplayNames([LOCALE], { type: 'region' });
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** «Татарстан, Россия» for a place from the geo search. */
export function formatRegion(place: { region?: string | null; country: string }): string {
  const country = countryName(place.country);
  return place.region ? `${place.region}, ${country}` : country;
}

/** «2 990»: digit groups the way the locale writes them. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

export type PluralForm = 'one' | 'few' | 'many' | 'other';

/** The form a counted Russian noun takes: 1 → one, 2 → few, 5 → many; fractions → other. */
export function pluralForm(count: number): PluralForm {
  const rule = new Intl.PluralRules(LOCALE).select(count);
  return rule === 'one' || rule === 'few' || rule === 'many' ? rule : 'other';
}
