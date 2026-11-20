// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const FORBIDDEN = new RegExp('tg:' + '/' + '/', 'i');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

describe('subscription protocol guard', () => {
  it('contains no unsupported Telegram deep links in web or shared UI source', () => {
    const roots = ['apps/web/src', 'packages/ui/src'];
    const offenders = roots.flatMap((root) => sourceFiles(join(ROOT, root))).filter((path) => FORBIDDEN.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
