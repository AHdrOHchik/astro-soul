// @vitest-environment node
/*
 * What the contract says outside its schemas, where the generated types do not reach:
 * the `x-` lists at the end of api.openapi.yaml.
 *
 * Product events are a closed list there (`x-analytics-events`). The server refuses a
 * whole batch for one name it does not know, and silently drops an event whose props
 * carry a key it takes for personal data (`x-events-forbidden-prop-keys`). The link
 * that goes out with a shared chart has a template there (`x-bot`). This file holds the
 * app's side of all three to the contract as it is written, not as somebody remembers it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, PROP_KEYS } from '../src/analytics/events.ts';
import { botShareLink, botUsernameOf } from '../src/lib/share.ts';

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

/** The value of `  key: value` right under a top-level `section:`. */
function topLevelValue(section: string, key: string): string {
  for (const line of CONTRACT.slice(lineIndex(`${section}:`) + 1)) {
    if (!line.startsWith(' ')) break;
    const [name, ...value] = line.trim().split(': ');
    if (name === key) return value.join(': ');
  }
  throw new Error(`api.openapi.yaml has no «${key}» under «${section}»`);
}

describe('product events against the contract', () => {
  it('have the same names in the app and in the contract: none missing, none of the app\'s own', () => {
    const contract = topLevelList('x-analytics-events');
    // The list was really read: an empty one would agree with nothing, a wrong one would lack these.
    expect(contract).toEqual(expect.arrayContaining(['app_open', 'consent_accepted', 'chart_created']));
    expect(Object.keys(EVENT_NAMES).sort()).toEqual([...contract].sort());
  });

  it('use none of the prop keys the contract forbids as personal data', () => {
    const forbidden = topLevelList('x-events-forbidden-prop-keys');
    expect(forbidden).toEqual(expect.arrayContaining(['birth_date', 'birth_time', 'birth_place', 'query', 'tz']));
    expect(PROP_KEYS.filter((key) => forbidden.includes(key))).toEqual([]);
  });
});

describe('the link of a shared chart against the contract', () => {
  it('is built by the contract\'s template, and only for a bot that is named by a username', () => {
    const template = topLevelValue('x-bot', 'share_link_template');
    const chartId = '0f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';

    expect(botShareLink(botUsernameOf('@astro_soul_bot'), chartId)).toBe(
      template.replace('{username}', 'astro_soul_bot').replace('{chart_id}', chartId),
    );
    // Not usernames: nothing, a link to the bot, a name too short, a name with a space.
    for (const value of [undefined, '', 'https://t.me/astro_soul_bot', 'bot', 'astro soul bot']) {
      expect(botShareLink(botUsernameOf(value), chartId)).toBeNull();
    }
  });
});
