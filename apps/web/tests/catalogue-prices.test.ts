// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = join(import.meta.dirname, '../src');
const PRICE_VALUES = /\b(?:149|249|399|590|2990)\b/g;

/** Runtime UI may format a server's `stars`; it must not contain tariff amounts of its own. */
function runtimeSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : runtimeSources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    // The generated OpenAPI declarations contain plan-code identifiers and a schema example, not UI prices.
    if (entry.name === 'schema.gen.d.ts') return [];
    return [path];
  });
}

describe('server-owned prices', () => {
  it('contains no hard-coded regular tariff amount in runtime web source', () => {
    const matches = runtimeSources(SOURCE).flatMap((path) => {
      const content = readFileSync(path, 'utf8');
      return [...content.matchAll(PRICE_VALUES)].map((match) => `${relative(SOURCE, path)}:${content.slice(0, match.index).split('\n').length}: ${match[0]}`);
    });
    expect(matches).toEqual([]);
  });
});
