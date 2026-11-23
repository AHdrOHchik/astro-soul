import { describe, expect, it } from 'vitest';
import { resolveShareTimeZone } from './shareTimeZone';

describe('share card timezone', () => {
  it('uses the valid device timezone', () => {
    expect(resolveShareTimeZone('nl-NL', 'Europe/Amsterdam')).toEqual({ value: 'Europe/Amsterdam', reliable: true });
  });

  it('falls back to Moscow for a Russian locale when the device timezone is missing or unknown', () => {
    expect(resolveShareTimeZone('ru-RU', '')).toEqual({ value: 'Europe/Moscow', reliable: false });
    expect(resolveShareTimeZone('ru', 'Mars/Olympus')).toEqual({ value: 'Europe/Moscow', reliable: false });
  });

  it('uses UTC for non-Russian cards but marks an unknown zone as unreliable for dated moon cards', () => {
    expect(resolveShareTimeZone('en-US', 'Unknown/Zone')).toEqual({ value: 'UTC', reliable: false });
  });
});
