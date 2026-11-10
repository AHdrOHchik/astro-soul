import type { ChartCreateRequest, GeoPlace, TimePrecision } from '../api';

/** Field values exactly as typed; they become numbers only at validation. */
export type DateParts = Readonly<{ day: string; month: string; year: string }>;
export type TimeParts = Readonly<{ hours: string; minutes: string }>;

/**
 * Onboarding answers. Lives in React state only: birth data is personal data,
 * so it is never written to localStorage, the URL or analytics.
 */
export interface BirthDraft {
  /**
   * Version of the consent text under which the user ticked the box; null until
   * they do. There is no default: only the user's own tap sets it.
   */
  consentVersion: string | null;
  date: DateParts;
  /** The option chosen on the BirthTime screen, in the contract's own values. */
  timePrecision: TimePrecision | null;
  time: TimeParts;
  placeQuery: string;
  place: GeoPlace | null;
}

export const EMPTY_DRAFT: BirthDraft = {
  consentVersion: null,
  date: { day: '', month: '', year: '' },
  timePrecision: null,
  time: { hours: '', minutes: '' },
  placeQuery: '',
  place: null,
};

/** The service is 18+ (SPEC). The API enforces it; the check here only saves a round trip. */
export const MIN_AGE = 18;
/** Typo guard ("0994", "1894"), not a product rule: nobody alive was born earlier. */
export const MIN_BIRTH_YEAR = 1900;

export type DateIssue = 'incomplete' | 'invalid' | 'too_old' | 'future' | 'underage';
export type DateCheck = { ok: true; iso: string } | { ok: false; issue: DateIssue };

const DIGITS = /^\d+$/;
const pad = (value: number, length = 2) => String(value).padStart(length, '0');

function toNumber(value: string, minLength: number): number | null {
  return value.length >= minLength && DIGITS.test(value) ? Number(value) : null;
}

/** `today` is read in the device's local time zone: the user's own calendar day. */
export function checkBirthDate({ day, month, year }: DateParts, today: Date): DateCheck {
  const d = toNumber(day, 1);
  const m = toNumber(month, 1);
  const y = toNumber(year, 4);
  if (d === null || m === null || y === null) return { ok: false, issue: 'incomplete' };

  // Date.UTC rolls impossible dates over (31.02 -> 03.03), so a round trip exposes them.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { ok: false, issue: 'invalid' };
  }
  if (y < MIN_BIRTH_YEAR) return { ok: false, issue: 'too_old' };

  const nowY = today.getFullYear();
  const nowM = today.getMonth() + 1;
  const nowD = today.getDate();
  const hadBirthdayThisYear = nowM > m || (nowM === m && nowD >= d);
  const age = nowY - y - (hadBirthdayThisYear ? 0 : 1);
  if (age < 0) return { ok: false, issue: 'future' };
  if (age < MIN_AGE) return { ok: false, issue: 'underage' };

  return { ok: true, iso: `${pad(y, 4)}-${pad(m)}-${pad(d)}` };
}

/**
 * True when every field holds all its digits ("03", not "3"). Validation accepts
 * a lone digit, but the screens must not act on it mid-typing: "3" may be the
 * start of "30".
 */
export function isDateTyped({ day, month, year }: DateParts): boolean {
  return day.length === 2 && month.length === 2 && year.length === 4;
}

export function isTimeTyped({ hours, minutes }: TimeParts): boolean {
  return hours.length === 2 && minutes.length === 2;
}

export type TimeIssue = 'incomplete' | 'invalid';
export type TimeCheck = { ok: true; value: string } | { ok: false; issue: TimeIssue };

/** 24-hour clock, formatted as the contract's `HH:MM`. */
export function checkBirthTime({ hours, minutes }: TimeParts): TimeCheck {
  const h = toNumber(hours, 1);
  const m = toNumber(minutes, 1);
  if (h === null || m === null) return { ok: false, issue: 'incomplete' };
  if (h > 23 || m > 59) return { ok: false, issue: 'invalid' };
  return { ok: true, value: `${pad(h)}:${pad(m)}` };
}

/** True when the BirthTime step has a usable answer. */
export function isTimeStepDone(draft: Pick<BirthDraft, 'timePrecision' | 'time'>): boolean {
  if (draft.timePrecision === null) return false;
  return draft.timePrecision === 'unknown' || checkBirthTime(draft.time).ok;
}

export type BirthStep = 'birthDate' | 'birthTime' | 'birthPlace';

/** The earliest step that still needs an answer; null when the chart can be requested. */
export function firstOpenStep(draft: BirthDraft, today: Date): BirthStep | null {
  if (!checkBirthDate(draft.date, today).ok) return 'birthDate';
  if (!isTimeStepDone(draft)) return 'birthTime';
  if (draft.place === null) return 'birthPlace';
  return null;
}

/**
 * Body of `POST /charts`, or null while the answers are incomplete or the
 * consent box is not ticked: `consent.accepted` is never sent on the user's behalf.
 *
 * The time goes with its precision; without a known time it is null.
 * The place goes back exactly as `POST /geo/resolve` returned it.
 */
export function toChartRequest(draft: BirthDraft, today: Date): ChartCreateRequest | null {
  const date = checkBirthDate(draft.date, today);
  if (!date.ok || draft.place === null || draft.timePrecision === null || draft.consentVersion === null) return null;

  let time: string | null = null;
  if (draft.timePrecision !== 'unknown') {
    const check = checkBirthTime(draft.time);
    if (!check.ok) return null;
    time = check.value;
  }
  return {
    birth_date: date.iso,
    birth_time: time,
    time_precision: draft.timePrecision,
    birth_place: draft.place,
    consent: { accepted: true, version: draft.consentVersion },
  };
}
