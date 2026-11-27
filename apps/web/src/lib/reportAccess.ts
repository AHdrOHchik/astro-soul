/*
 * The right to a full report — read, never computed.
 *
 * The server decides whether a person may order or open a report (contract 1.6.19, `Me.report_access`),
 * and this module is the only place the interface asks. Anything built on top of `entitlements` here
 * — «есть грант, значит открыто», «нет отчёта, значит купить» — is a second opinion, and the app
 * already paid for one: it asked for money for a report the server had given (round46).
 */
import { useEffect } from 'react';
import type { Me, ReportAccess } from '../api';

/** Why the report is open, in the contract's words: `purchased` → `all_access` → `single_report`. */
export type ReportAccessSource = NonNullable<ReportAccess['source']>;

/**
 * What the interface knows about the right to a report.
 *
 * `unknown` is a state of its own, not «no access»: the field came with contract 1.6.19, and a build
 * that guesses what an older server meant is exactly how the app came to offer a purchase to a person
 * who already owned the report.
 */
export type ReportAccessState =
  | { status: 'unknown' }
  | { status: 'none' }
  | { status: 'open'; source: ReportAccessSource | null; expiresAt: string | null; chartId: string | null };

/** The server's answer as the screens read it. Nothing is derived: the field is taken or it is absent. */
export function reportAccessOf(me: Me): ReportAccessState {
  const access = me.report_access;
  if (access === undefined) return { status: 'unknown' };
  if (!access.available) return { status: 'none' };
  return {
    status: 'open',
    source: access.source ?? null,
    expiresAt: access.expires_at ?? null,
    chartId: access.chart_id ?? null,
  };
}

/**
 * Whether this state opens a report about this very chart.
 *
 * `purchased` names the chart it was bought for, and the app only compares two ids: the server's
 * word against the chart on screen. `all_access` and `single_report` are rights for any chart. An
 * unknown state opens nothing — the screens say they cannot tell instead of deciding for the server.
 */
export function reportOpenFor(access: ReportAccessState, chartId: string | null): boolean {
  if (access.status !== 'open' || chartId === null || chartId === '') return false;
  if (access.source === 'purchased') return access.chartId === chartId;
  return true;
}

/**
 * The single question the interface asks about report access: `useReportAccess(me)`.
 *
 * A missing field is said out loud, once per session and once per shape of `Me`: a silent falling
 * back to a guess is the defect this hook exists to end.
 */
export function useReportAccess(me: Me): ReportAccessState {
  const access = reportAccessOf(me);
  const unknown = access.status === 'unknown';
  useEffect(() => {
    if (!unknown) return;
    console.warn(
      '[report_access] Me.report_access is missing: the app cannot tell whether the report is open, and does not guess.',
    );
  }, [unknown]);
  return access;
}
