import { describe, expect, it } from 'vitest';
import { isDeviceMidnight, localDayIn } from './localDay';

describe('localDayIn', () => {
  it('names the calendar day of a moment where the zone is, whatever the day on the device', () => {
    // 22:30 UTC on 10 November: already the 11th east of Moscow, still the 10th west of it.
    const evening = new Date('2026-11-10T22:30:00Z');
    expect(localDayIn('Europe/Moscow', evening)).toBe('2026-11-11');
    expect(localDayIn('Asia/Vladivostok', evening)).toBe('2026-11-11');
    expect(localDayIn('Europe/Amsterdam', evening)).toBe('2026-11-10');
    expect(localDayIn('America/Los_Angeles', evening)).toBe('2026-11-10');
    expect(localDayIn('UTC', evening)).toBe('2026-11-10');
  });

  it('writes the day the way the server writes `Forecast.date`: four digits, two, two', () => {
    // Half past midnight in Moscow on New Year's Day.
    expect(localDayIn('Europe/Moscow', new Date('2026-12-31T21:30:00Z'))).toBe('2027-01-01');
    expect(localDayIn('Europe/Moscow', new Date('2026-03-04T09:00:00Z'))).toBe('2026-03-04');
  });

  it.each([null, undefined, '', 'Mars/Olympus', 'не пояс'])('is null for the zone %j: nobody guesses which day it is there', (zone) => {
    expect(localDayIn(zone, new Date('2026-11-10T12:00:00Z'))).toBeNull();
  });
});

describe('isDeviceMidnight', () => {
  it('is true for 00:00 by the clock of the device and for no other time', () => {
    // Built from local parts, so the answer is the same in any zone the tests run in.
    expect(isDeviceMidnight(new Date(2026, 10, 11, 0, 0))).toBe(true);
    expect(isDeviceMidnight(new Date(2026, 10, 11, 0, 0, 59))).toBe(true);
    expect(isDeviceMidnight(new Date(2026, 10, 11, 0, 1))).toBe(false);
    expect(isDeviceMidnight(new Date(2026, 10, 10, 22, 0))).toBe(false);
    expect(isDeviceMidnight(new Date(2026, 10, 10, 12, 0))).toBe(false);
  });
});
