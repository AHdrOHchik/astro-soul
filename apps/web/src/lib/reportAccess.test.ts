import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Me } from '../api';
import { chart, me, meAllAccess, meFreeReport, mePaid, meWithChart, noReportAccess } from '../test/fixtures';
import { reportAccessOf, reportOpenFor, useReportAccess } from './reportAccess';

const CHART_A = chart.chart_id;
const CHART_B = '00000000-0000-4000-8000-0000000000b0';

/** `Me` without the optional field, as a server older than contract 1.6.19 answers. */
const withoutField = (source: Me): Me => {
  const { report_access: _gone, ...rest } = source;
  return rest;
};

describe('reportAccessOf: the server`s answer, read and never computed', () => {
  it('no field in `Me`: unknown, not «no access»', () => {
    expect(reportAccessOf(withoutField(meWithChart))).toEqual({ status: 'unknown' });
    expect(reportAccessOf({ ...meWithChart, report_access: undefined })).toEqual({ status: 'unknown' });
  });

  it('`available: false` is «no access», whatever else the server sends', () => {
    expect(reportAccessOf({ ...meWithChart, report_access: { ...noReportAccess, source: null } })).toEqual({ status: 'none' });
  });

  it('a purchase names the chart, and the source is carried as the server sent it', () => {
    expect(reportAccessOf(mePaid)).toEqual({
      status: 'open',
      source: 'purchased',
      expiresAt: null,
      chartId: CHART_A,
    });
  });

  it('a right with a term carries the term, a free report carries none', () => {
    expect(reportAccessOf(meAllAccess)).toEqual({
      status: 'open',
      source: 'all_access',
      expiresAt: '2026-12-12T12:00:00Z',
      chartId: null,
    });
    expect(reportAccessOf(meFreeReport)).toEqual({
      status: 'open',
      source: 'single_report',
      expiresAt: null,
      chartId: null,
    });
  });
});

describe('reportOpenFor: whether the answer opens a report about this very chart', () => {
  it('a purchase opens the chart it names and no other', () => {
    const bought = reportAccessOf(mePaid);
    expect(reportOpenFor(bought, CHART_A)).toBe(true);
    expect(reportOpenFor(bought, CHART_B)).toBe(false);
  });

  it('«всё включено» and a free report open any chart: the server ties them to no chart', () => {
    for (const state of [reportAccessOf(meAllAccess), reportAccessOf(meFreeReport)]) {
      expect(reportOpenFor(state, CHART_A)).toBe(true);
      expect(reportOpenFor(state, CHART_B)).toBe(true);
    }
  });

  it('nothing opens a chart without an id', () => {
    expect(reportOpenFor(reportAccessOf(meAllAccess), null)).toBe(false);
    expect(reportOpenFor(reportAccessOf(meAllAccess), '')).toBe(false);
  });

  it('no access and an unknown answer open nothing: the screens say so instead of guessing', () => {
    expect(reportOpenFor(reportAccessOf(meWithChart), CHART_A)).toBe(false);
    expect(reportOpenFor(reportAccessOf(withoutField(meAllAccess)), CHART_A)).toBe(false);
  });

  it('a subscription is not the report', () => {
    expect(reportOpenFor(reportAccessOf({ ...meWithChart, entitlements: { ...meWithChart.entitlements, is_active: true } }), CHART_A)).toBe(false);
  });
});

describe('useReportAccess: a missing field is said out loud, once', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('warns when the server sent no field, and says it cannot tell', () => {
    const { result } = renderHook(() => useReportAccess(withoutField(meWithChart)));
    expect(result.current).toEqual({ status: 'unknown' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('report_access');
  });

  it('says nothing when the server answered', () => {
    const { result } = renderHook(() => useReportAccess(meAllAccess));
    expect(result.current.status).toBe('open');
    expect(warn).not.toHaveBeenCalled();
  });

  it('the ordinary fixture answer is «no access» and no warning', () => {
    const { result } = renderHook(() => useReportAccess(me));
    expect(result.current).toEqual({ status: 'none' });
    expect(warn).not.toHaveBeenCalled();
  });
});
