import { describe, expect, it } from 'vitest';
import { entitlements, apiError } from '../test/fixtures';
import {
  hasUnknownCharacters,
  isPartnerStart,
  isValidAccessCode,
  normalizeAccessCode,
  openedGrant,
  partnerGrant,
  refusalOf,
  retryAfterMinutesOf,
} from './accessCode';

describe('normalizeAccessCode', () => {
  it('uppercases a code typed in small letters', () => {
    expect(normalizeAccessCode('k7m2p9x4')).toBe('K7M2P9X4');
  });

  it('cuts spaces and hyphens at the edges and ignores the ones inside', () => {
    expect(normalizeAccessCode('  k7m2-p9x4 - ')).toBe('K7M2P9X4');
    expect(normalizeAccessCode('ab c d 2 3 4 5')).toBe('ABCD2345');
  });

  it('keeps no more than the eight characters a code has', () => {
    expect(normalizeAccessCode('K7M2P9X4ABCD')).toBe('K7M2P9X4');
  });

  it('does not guess the look-alikes the alphabet leaves out', () => {
    // `0`, `O`, `1`, `I` and `l` are not in the alphabet: a code with one is not a code,
    // and turning it into something else would be a guess about which character was meant.
    expect(normalizeAccessCode('k7m2p9xo')).toBe('K7M2P9XO');
    expect(isValidAccessCode(normalizeAccessCode('k7m2p9xo'))).toBe(false);
  });
});

describe('isValidAccessCode', () => {
  it('accepts exactly eight characters of the alphabet', () => {
    expect(isValidAccessCode('K7M2P9X4')).toBe(true);
    expect(isValidAccessCode('ABCDEFGH')).toBe(true);
    expect(isValidAccessCode('23456789')).toBe(true);
  });

  it('refuses a code that is shorter, longer or made of another characters', () => {
    expect(isValidAccessCode('K7M2P9X')).toBe(false);
    expect(isValidAccessCode('K7M2P9X4A')).toBe(false);
    // `L` is in the alphabet, so a small `l` is a letter and not a guess at `1`: it becomes `L`.
    expect(isValidAccessCode(normalizeAccessCode('K7M2P9Xl'))).toBe(true);
    for (const lookAlike of ['0', 'O', '1', 'I', 'Я', ' ']) {
      expect(isValidAccessCode(`K7M2P9X${lookAlike}`)).toBe(false);
    }
  });
});

describe('hasUnknownCharacters', () => {
  it('names the look-alikes the alphabet leaves out', () => {
    expect(hasUnknownCharacters('K7M2P9X0')).toBe(true);
    expect(hasUnknownCharacters('K7M2P9XO')).toBe(true);
    expect(hasUnknownCharacters('K7M2P9X1')).toBe(true);
    expect(hasUnknownCharacters('K7M2P9XI')).toBe(true);
    expect(hasUnknownCharacters('K7M2P9X4')).toBe(false);
  });

  it('says nothing about an empty field', () => {
    expect(hasUnknownCharacters('')).toBe(false);
  });
});

describe('openedGrant', () => {
  it('reads a full access that runs until a date', () => {
    expect(openedGrant(entitlements, { ...entitlements, all_access_until: '2026-12-12T12:00:00Z' })).toEqual({
      kind: 'all_access',
      until: '2026-12-12T12:00:00Z',
    });
  });

  it('reads an extended full access: the same right, a later term', () => {
    expect(
      openedGrant(
        { ...entitlements, all_access_until: '2026-12-12T12:00:00Z' },
        { ...entitlements, all_access_until: '2027-01-11T12:00:00Z' },
      ),
    ).toEqual({ kind: 'all_access', until: '2027-01-11T12:00:00Z' });
  });

  it('reads one more unused report as a report, not as a term', () => {
    expect(openedGrant(entitlements, { ...entitlements, single_reports: 1 })).toEqual({ kind: 'single_report' });
  });

  it('reads one more unused compatibility as a compatibility', () => {
    expect(openedGrant(entitlements, { ...entitlements, single_compat: 1 })).toEqual({ kind: 'single_compat' });
  });

  it('reads an answer that changed nothing visible as a full access waiting for the chart', () => {
    expect(openedGrant(entitlements, { ...entitlements, source: 'partner' })).toEqual({ kind: 'pending' });
  });

  it('does not mistake an already open report for the one just activated', () => {
    const before = { ...entitlements, single_reports: 2 };
    expect(openedGrant(before, { ...before, single_reports: 3 })).toEqual({ kind: 'single_report' });
    expect(openedGrant(before, { ...before, all_access_until: '2026-12-12T12:00:00Z' })).toEqual({
      kind: 'all_access',
      until: '2026-12-12T12:00:00Z',
    });
  });
});

describe('partnerGrant', () => {
  it('shows a full access with its term', () => {
    expect(partnerGrant({ ...entitlements, all_access_until: '2026-12-12T12:00:00Z' })).toEqual({
      kind: 'all_access',
      until: '2026-12-12T12:00:00Z',
    });
  });

  it('shows a partner right whose term waits for the chart', () => {
    expect(partnerGrant({ ...entitlements, source: 'partner' })).toEqual({ kind: 'pending' });
  });

  it('shows a partner report and a partner compatibility', () => {
    expect(partnerGrant({ ...entitlements, source: 'partner', single_reports: 1 })).toEqual({ kind: 'single_report' });
    expect(partnerGrant({ ...entitlements, source: 'partner', single_compat: 1 })).toEqual({ kind: 'single_compat' });
  });

  it('announces nothing when no partner code left anything behind', () => {
    expect(partnerGrant(entitlements)).toBeNull();
    expect(partnerGrant({ ...entitlements, source: 'admin' })).toBeNull();
  });
});

describe('refusalOf', () => {
  it('tells the three codes of the 409 one from another', () => {
    expect(refusalOf(apiError('NOT_FOUND', { status: 404, details: { reason: 'code_not_found' } }))).toBe('not_found');
    expect(refusalOf(apiError('CONFLICT', { status: 409, details: { reason: 'code_exhausted' } }))).toBe('exhausted');
    expect(refusalOf(apiError('CONFLICT', { status: 409, details: { reason: 'already_activated' } }))).toBe('already_activated');
  });

  it('reads an expired code as expired, not as a missing one', () => {
    expect(refusalOf(apiError('GONE', { status: 410 }))).toBe('expired');
    expect(refusalOf(apiError('GONE', { status: 410, details: { reason: 'code_expired' } }))).toBe('expired');
  });

  it('reads a 422 as a code of the wrong format', () => {
    expect(refusalOf(apiError('VALIDATION_FAILED', { status: 422 }))).toBe('invalid');
  });

  it('has no words of its own for a limit, a session or anything else', () => {
    expect(refusalOf(apiError('RATE_LIMITED', { status: 429 }))).toBeNull();
    expect(refusalOf(apiError('UNAUTHORIZED', { status: 401 }))).toBeNull();
    expect(refusalOf(apiError('BONUS_BUDGET_EXHAUSTED', { status: 503 }))).toBeNull();
    expect(refusalOf(new Error('offline'))).toBeNull();
  });
});

describe('retryAfterMinutesOf', () => {
  it('counts whole minutes, at least one', () => {
    expect(retryAfterMinutesOf(apiError('RATE_LIMITED', { status: 429, details: { retry_after: 120 } }))).toBe(2);
    expect(retryAfterMinutesOf(apiError('RATE_LIMITED', { status: 429, details: { retry_after: 61 } }))).toBe(2);
    expect(retryAfterMinutesOf(apiError('RATE_LIMITED', { status: 429, details: { retry_after: 5 } }))).toBe(1);
  });

  it('says nothing when the server named no time', () => {
    expect(retryAfterMinutesOf(apiError('RATE_LIMITED', { status: 429 }))).toBeNull();
    expect(retryAfterMinutesOf(apiError('RATE_LIMITED', { status: 429, details: { retry_after: 'soon' } }))).toBeNull();
    expect(retryAfterMinutesOf(new Error('offline'))).toBeNull();
  });
});

describe('isPartnerStart', () => {
  it('recognises a start from a partner code by its prefix only', () => {
    expect(isPartnerStart('pt_K7M2P9X4')).toBe(true);
    expect(isPartnerStart('PT_k7m2p9x4')).toBe(true);
    expect(isPartnerStart(' pt_K7M2P9X4 ')).toBe(true);
  });

  it('is not a partner start otherwise', () => {
    expect(isPartnerStart('pt_')).toBe(false);
    expect(isPartnerStart('sh_k7m2p9x4')).toBe(false);
    expect(isPartnerStart('')).toBe(false);
    expect(isPartnerStart(null)).toBe(false);
    expect(isPartnerStart(undefined)).toBe(false);
  });
});
