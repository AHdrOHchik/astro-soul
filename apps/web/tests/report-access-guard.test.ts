// @vitest-environment node
/*
 * The guard of round46: the interface asks the server about access in one place.
 *
 * Reading `Me.report_access` anywhere else, or deciding access from `entitlements` flags, is how the
 * app came to offer a purchase for a report the server had already given. Tests are not counted:
 * they are allowed to build any answer, they are not allowed to decide one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the interface reads access in one place', () => {
  const SRC = join(import.meta.dirname, '../src');

  /**
   * The code of the app, with comments taken out: a comment that names the field is documentation,
   * not a second reader of it. `i18n` (the wording) and `test` (fixtures of any answer) are not code.
   */
  const withoutComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const sources = (): { path: string; text: string }[] => {
    const found: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry === 'i18n' || entry === 'test') continue;
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry) || entry === 'schema.gen.d.ts') continue;
        found.push({ path, text: withoutComments(readFileSync(path, 'utf8')) });
      }
    };
    walk(SRC);
    return found;
  };

  const readers = (needle: string, allowed: readonly string[]): string[] =>
    sources()
      .filter(({ path, text }) => text.includes(needle) && !allowed.some((prefix) => path.startsWith(join(SRC, prefix))))
      .map(({ path }) => path.slice(SRC.length + 1));

  it('`Me.report_access` is read only by the access module, and normalized only by the API layer', () => {
    expect(readers('report_access', ['lib/reportAccess.ts', 'api/'])).toEqual([]);
  });

  it('the chart a report was bought for is not read as an access decision', () => {
    expect(readers('full_report_chart_id', ['lib/plans.ts', 'api/'])).toEqual([]);
  });

  it('grants are read for their wording only, never to decide access', () => {
    expect(readers('all_access_until', ['lib/accessCode.ts', 'api/'])).toEqual([]);
    expect(readers('single_reports', ['lib/accessCode.ts', 'api/'])).toEqual([]);
  });

  it('the API layer itself is one of the two readers of the field', () => {
    expect(readers('report_access', ['api/'])).toContain('lib/reportAccess.ts');
  });
});
