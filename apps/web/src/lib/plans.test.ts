import { describe, expect, it } from 'vitest';
import { chart, mePaid, meSubscribed } from '../test/fixtures';
import { grants } from './plans';

const SUBSCRIPTION_CODES = ['week_149', 'month_399', 'year_2990'];

const CHART_A = chart.chart_id;
const CHART_B = '00000000-0000-4000-8000-0000000000b0';

describe('grants: whether the server confirms a purchase', () => {
  it('the report is confirmed for the chart it was bought for, and for no other', () => {
    expect(grants(mePaid, true, CHART_A)).toBe(true);
    // The user has a report of chart A. A payment for chart B is not confirmed by it.
    expect(grants(mePaid, true, CHART_B)).toBe(false);
  });

  it('a report bought for no chart is confirmed by nothing', () => {
    expect(grants(mePaid, true, null)).toBe(false);
  });

  it('a subscription is confirmed by `is_active`, whatever chart is on screen; the report is not a subscription', () => {
    expect(SUBSCRIPTION_CODES).toHaveLength(3);
    expect(grants(meSubscribed, false, null)).toBe(true);
    expect(grants(meSubscribed, false, CHART_A)).toBe(true);
    expect(grants(mePaid, false, CHART_A)).toBe(false);
    expect(grants(meSubscribed, true, CHART_A)).toBe(false);
  });
});
