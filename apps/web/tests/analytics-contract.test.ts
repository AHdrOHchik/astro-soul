// @vitest-environment node
/*
 * Product events are a closed list in the contract: `x-analytics-events` in
 * api.openapi.yaml. The server refuses a whole batch for one name it does not know,
 * and silently drops an event whose props carry a key it takes for personal data.
 * This file holds the app's side of both to the contract as it is written, not as
 * somebody remembers it.
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

/** The keys the contract forbids in `props`: the names in backticks in the description of `ClientEvent.props`. */
function forbiddenPropKeys(): string[] {
  const props = lineIndex('        props:', lineIndex('    ClientEvent:'));
  const text: string[] = [];
  for (const line of CONTRACT.slice(lineIndex('          description: |', props) + 1)) {
    // The block of a `|` scalar: the lines indented deeper than its key.
    if (!line.startsWith('            ')) break;
    text.push(line);
  }
  return [...text.join(' ').matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? '');
}

describe('product events against the contract', () => {
  it('have the same names in the app and in the contract: none missing, none of the app\'s own', () => {
    const contract = topLevelList('x-analytics-events');
    // The list was really read: an empty one would agree with nothing, a wrong one would lack these.
    expect(contract).toEqual(expect.arrayContaining(['app_open', 'consent_accepted', 'chart_created']));
    expect(Object.keys(EVENT_NAMES).sort()).toEqual([...contract].sort());
  });

  it('use none of the prop keys the contract forbids as personal data', () => {
    const forbidden = forbiddenPropKeys();
    expect(forbidden).toEqual(expect.arrayContaining(['birth_date', 'birth_time', 'birth_place', 'query', 'tz']));
    expect(PROP_KEYS.filter((key) => forbidden.includes(key))).toEqual([]);
  });
});
