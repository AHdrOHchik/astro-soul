/*
 * Access codes (contract 1.6.14, partner programme): what the user may type, what the
 * server's answer means for them, and why a code was refused. The code itself never
 * leaves this module's functions: it is not kept, not logged and not put in an event.
 */
import { isApiError, type ApiErrorCode, type Entitlements } from '../api';

/**
 * The alphabet of a code, exactly as the server writes it: no `0`, `O`, `1`, `I` or `l`,
 * because they are read for one another on a picture. A character outside it is not
 * guessed at: `O` could be meant for a letter the alphabet does not have, so a code with
 * one in it is simply not complete.
 */
export const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Codes are eight characters: the server refuses anything else before it looks at the database. */
export const ACCESS_CODE_LENGTH = 8;

/** Spaces and hyphens are how a code is written on a card, not a part of it. */
const SEPARATORS = /[\s-]+/g;

/**
 * What goes to the server: upper case, without spaces or hyphens anywhere (a code typed as
 * `ab c d 2 3 4 5` is the code `ABCD2345`), and never longer than a code is.
 */
export function normalizeAccessCode(raw: string): string {
  return raw.replace(SEPARATORS, '').toUpperCase().slice(0, ACCESS_CODE_LENGTH);
}

/** True only for a complete code of the alphabet: what the button waits for. */
export function isValidAccessCode(code: string): boolean {
  if (code.length !== ACCESS_CODE_LENGTH) return false;
  for (const character of code) {
    if (!ACCESS_CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * True when a complete value has a character the alphabet does not know. The field then
 * says what is wrong instead of only keeping the button disabled: `0`, `O`, `1`, `I` and
 * `l` are the ones actually met, being the look-alikes the alphabet leaves out.
 */
export function hasUnknownCharacters(code: string): boolean {
  for (const character of code) {
    if (!ACCESS_CODE_ALPHABET.includes(character)) return true;
  }
  return false;
}

/** What a code opened, in the words of the contract's kinds. */
export type AccessGrant =
  | { kind: 'all_access'; until: string }
  | { kind: 'single_report' }
  | { kind: 'single_compat' }
  /** An `all_access` right that waits for the chart: its term has not started yet. */
  | { kind: 'pending' };

/** `all_access_until` as a moment, or null when there is no such right (or no value at all). */
function untilOf(entitlements: Entitlements): string | null {
  const value = entitlements.all_access_until;
  return typeof value === 'string' && value !== '' ? value : null;
}

const countOf = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * What changed between the rights before the request and the answer to it.
 *
 * The answer carries the whole `Me.entitlements` and no kind of its own, so the kind is
 * read from the change: a later `all_access_until`, more unused reports or compatibilities.
 * An answer that changed nothing visible is an `all_access` right waiting for the chart —
 * that is the one grant the server stores without a term (`all_access_until: null`).
 */
export function openedGrant(before: Entitlements, after: Entitlements): AccessGrant {
  const until = untilOf(after);
  if (until !== null && until !== untilOf(before)) return { kind: 'all_access', until };
  if (countOf(after.single_reports) > countOf(before.single_reports)) return { kind: 'single_report' };
  if (countOf(after.single_compat) > countOf(before.single_compat)) return { kind: 'single_compat' };
  // The right was there before and the term is the same one: the code extended nothing new.
  if (until !== null) return { kind: 'all_access', until };
  return { kind: 'pending' };
}

/**
 * The partner right a start with `pt_` left behind, as `Me.entitlements` shows it. Null
 * when there is nothing a partner code could have given: the start then has nothing to
 * announce (an expired code, for one).
 */
export function partnerGrant(entitlements: Entitlements): AccessGrant | null {
  const until = untilOf(entitlements);
  if (until !== null) return { kind: 'all_access', until };
  if (entitlements.source !== 'partner') return null;
  if (countOf(entitlements.single_reports) > 0) return { kind: 'single_report' };
  if (countOf(entitlements.single_compat) > 0) return { kind: 'single_compat' };
  return { kind: 'pending' };
}

/**
 * Why the server refused the code, in the words the screen can act on: `null` when the
 * answer said something this build has no words of its own for, and the generic text of
 * its code is shown instead.
 */
export type AccessCodeRefusal =
  | 'not_found'
  | 'exhausted'
  | 'already_activated'
  | 'expired'
  | 'invalid'
  | null;

/** `details.reason` of a `Problem`: the machine reason when one `code` covers several. */
function reasonOf(error: unknown): string | null {
  const reason = isApiError(error) ? error.details?.reason : undefined;
  return typeof reason === 'string' && reason !== '' ? reason : null;
}

/**
 * The `Problem.code` of the answer, for a text this build has no words of its own for.
 * `INTERNAL` when there was no answer at all: the client's own failures never carry a
 * reason of the server.
 */
export function refusalCodeOf(error: unknown): ApiErrorCode {
  return isApiError(error) ? error.code : 'INTERNAL';
}

/**
 * A `404`/`409`/`410` of this endpoint is one code of `Problem` for several things the
 * user did: `details.reason` tells «no such code» from «already taken», and a `409` must
 * not say "no such code" to someone whose code was simply used up. A `401` is not
 * here: the session handler says that one.
 */
export function refusalOf(error: unknown): AccessCodeRefusal {
  const code = refusalCodeOf(error);
  if (code === 'VALIDATION_FAILED') return 'invalid';
  if (code === 'GONE') return 'expired';
  const reason = reasonOf(error);
  if (reason === 'not_found' || reason === 'code_not_found') return 'not_found';
  if (reason === 'exhausted' || reason === 'code_exhausted') return 'exhausted';
  if (reason === 'already_activated') return 'already_activated';
  if (reason === 'expired' || reason === 'code_expired') return 'expired';
  return null;
}

/**
 * `details.retry_after` — seconds until the limit lifts (contract 1.6.16 for the admin
 * login, and what a throttled request carries here as well). Whole minutes for the text,
 * at least one; null when the server named no time.
 */
export function retryAfterMinutesOf(error: unknown): number | null {
  const value = isApiError(error) ? error.details?.retry_after : undefined;
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * Whether this start came from a `pt_<code>` link. The payload is read for its prefix and
 * nothing else: the code is neither kept nor sent — the server has already activated it,
 * and the answer to «what is open now» is `Me.entitlements`.
 */
export function isPartnerStart(startParam: string | null | undefined): boolean {
  if (typeof startParam !== 'string') return false;
  const payload = startParam.trim().toLowerCase();
  return payload.startsWith('pt_') && payload.length > 'pt_'.length;
}
