import { describe, expect, it } from 'vitest';
import type { Me } from '../api';
import { chart, me, mePaid, meSubscribed, meWithChart } from '../test/fixtures';
import { grants, hasReportFor, REPORT_PLAN, SUBSCRIPTION_PLANS } from './plans';

const CHART_A = chart.chart_id;
const CHART_B = '00000000-0000-4000-8000-0000000000b0';

/** `Me` whose entitlements say this about the full report; the rest is a user with a chart. */
const withReport = (report: Partial<Me['entitlements']>): Me => ({ ...meWithChart, entitlements: { ...meWithChart.entitlements, ...report } });

describe('hasReportFor: whether the full report of a chart is paid for', () => {
  it('yes for the chart `Me` names', () => {
    expect(hasReportFor(withReport({ full_report: true, full_report_chart_id: CHART_A }), CHART_A)).toBe(true);
  });

  it('no for any other chart, though `full_report` is true: that flag is about the user, the purchase is about a chart', () => {
    expect(hasReportFor(withReport({ full_report: true, full_report_chart_id: CHART_A }), CHART_B)).toBe(false);
  });

  it('no when the server names no chart, though `full_report` is true: the purchase went with the data', () => {
    expect(hasReportFor(withReport({ full_report: true, full_report_chart_id: null }), CHART_A)).toBe(false);
  });

  it('no when the field is not in the answer at all: nothing is opened by an answer that says nothing', () => {
    const { full_report_chart_id: _left, ...rest } = withReport({ full_report: true }).entitlements;
    expect(hasReportFor({ ...meWithChart, entitlements: rest }, CHART_A)).toBe(false);
  });

  it('no for a user who has bought nothing, and for a new one', () => {
    expect(hasReportFor(meWithChart, CHART_A)).toBe(false);
    expect(hasReportFor(me, CHART_A)).toBe(false);
  });

  it('a subscription is not the report', () => {
    expect(hasReportFor(meSubscribed, CHART_A)).toBe(false);
  });
});

describe('grants: whether the server confirms a purchase', () => {
  it('the report is confirmed for the chart it was bought for, and for no other', () => {
    expect(grants(mePaid, REPORT_PLAN, CHART_A)).toBe(true);
    // The user has a report of chart A. A payment for chart B is not confirmed by it.
    expect(grants(mePaid, REPORT_PLAN, CHART_B)).toBe(false);
  });

  it('a report bought for no chart is confirmed by nothing', () => {
    expect(grants(mePaid, REPORT_PLAN, null)).toBe(false);
  });

  it('a subscription is confirmed by `is_active`, whatever chart is on screen; the report is not a subscription', () => {
    for (const plan of SUBSCRIPTION_PLANS) {
      expect(grants(meSubscribed, plan, null)).toBe(true);
      expect(grants(meSubscribed, plan, CHART_A)).toBe(true);
      expect(grants(mePaid, plan, CHART_A)).toBe(false);
    }
    expect(grants(meSubscribed, REPORT_PLAN, CHART_A)).toBe(false);
  });
});
