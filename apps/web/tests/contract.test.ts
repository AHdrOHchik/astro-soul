// @vitest-environment node
/*
 * What the contract says outside its schemas, where the generated types do not reach:
 * the `x-` lists at the end of api.openapi.yaml.
 *
 * Product events are a closed list there (`x-analytics-events`). The server refuses a
 * whole batch for one name it does not know, and silently drops an event whose props
 * carry a key it takes for personal data (`x-events-forbidden-prop-keys`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, PROP_KEYS } from '../src/analytics/events.ts';

const CONTRACT = readFileSync(join(import.meta.dirname, '../../../api.openapi.yaml'), 'utf8').split('\n');

/** Index of the first line equal to `line` at or after `from`; the contract is expected to have it. */
function lineIndex(line: string, from = 0): number {
  const index = CONTRACT.indexOf(line, from);
  if (index === -1) throw new Error(`api.openapi.yaml has no line «${line}»`);
  return index;
}

/** The items of a list at the top level of the file: the `  - item` lines right under `key:`. */
function topLevelList(key: string): string[] {
  const items: string[] = [];
  for (const line of CONTRACT.slice(lineIndex(`${key}:`) + 1)) {
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (!item) break;
    items.push(item[1] ?? '');
  }
  return items;
}


function eventNamesMatch(clientNames: readonly string[], contractNames: readonly string[]): boolean {
  const clientSet = new Set(clientNames);
  const contractSet = new Set(contractNames);
  return clientSet.size === clientNames.length &&
    contractSet.size === contractNames.length &&
    clientSet.size === contractSet.size &&
    [...clientSet].every((name) => contractSet.has(name));
}

describe('product events against the contract', () => {
  it('have the same names in the app and in the contract: none missing, none extra, none duplicated', () => {
    const contract = topLevelList('x-analytics-events');
    const client = Object.keys(EVENT_NAMES);
    // The list was really read: an empty one would agree with nothing, a wrong one would lack these.
    expect(contract).toEqual(expect.arrayContaining(['app_open', 'consent_accepted', 'chart_created']));
    expect(eventNamesMatch(client, contract)).toBe(true);
    expect(EVENT_NAMES).toHaveProperty('share_sent', true);
  });

  it('rejects an extra name, a missing name, and a duplicate in either list', () => {
    const contract = topLevelList('x-analytics-events');
    const client = Object.keys(EVENT_NAMES);
    expect(eventNamesMatch([...client, 'fixture_extra_event'], contract)).toBe(false);
    expect(eventNamesMatch(client.slice(1), contract)).toBe(false);
    expect(eventNamesMatch([...client, client[0] ?? ''], contract)).toBe(false);
    expect(eventNamesMatch(client, [...contract, contract[0] ?? ''])).toBe(false);
  });

  it('use none of the prop keys the contract forbids as personal data', () => {
    const forbidden = topLevelList('x-events-forbidden-prop-keys');
    expect(forbidden).toEqual(expect.arrayContaining(['birth_date', 'birth_time', 'birth_place', 'query', 'tz']));
    expect(PROP_KEYS.filter((key) => forbidden.includes(key))).toEqual([]);
  });
});
