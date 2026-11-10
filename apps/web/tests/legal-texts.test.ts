// @vitest-environment node
/*
 * The consent screen and the two document screens show legal texts. Agents do not
 * write or change those: they come from legal.md, which a human owns. This file
 * holds the app to that:
 *  - every legal string of the app is the text of legal.md, and nothing of the
 *    consent draft is left out;
 *  - the version sent to the server as `consent.version` changes whenever the texts do.
 * When legal.md changes, the first group fails until src/i18n/ru.ts repeats the new
 * wording; then the second fails until CONSENT_VERSION is a new date.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSENT_VERSION, ru } from '../src/i18n/ru.ts';

const LEGAL = readFileSync(join(import.meta.dirname, '../../../legal.md'), 'utf8');

/** A numbered `## N.` section of legal.md, without its heading line. */
function section(number: number): { title: string; lines: string[] } {
  const lines = LEGAL.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${String(number)}. `));
  if (start === -1) throw new Error(`legal.md has no section ${String(number)}`);
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  return {
    title: (lines[start] ?? '').replace(/^## \d+\. /, '').trim(),
    lines: lines.slice(start + 1, length === -1 ? undefined : start + 1 + length),
  };
}

/** The quoted block of a section: the text meant for the screen, one entry per paragraph. */
function quoted(lines: readonly string[]): string[] {
  return lines
    .filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^>\s?/, '').trim())
    .filter((line) => line !== '');
}

/** Markdown code marks are not part of the wording. */
const plain = (text: string) => text.replace(/`/g, '').trim();

function tableRows(lines: readonly string[]): string[][] {
  return lines
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split('|').map(plain));
}

describe('consent screen: legal.md, section 2', () => {
  const draft = quoted(section(2).lines);
  const copy = ru.consent;

  it('is the draft of the consent, paragraph by paragraph, in the same order', () => {
    expect([
      `**${copy.title}**`,
      copy.lead,
      ...copy.points.map((point) => `— ${point}`),
      `[${copy.documents.privacy}] [${copy.documents.terms}]`,
      `☑ ${copy.checkbox}`,
    ]).toEqual(draft.slice(0, -1));
  });

  it('names its button the way the draft does', () => {
    // The last paragraph of the draft is not shown: it tells how the button behaves.
    expect(draft[draft.length - 1]).toBe(`Кнопка «${copy.submit}» неактивна, пока галочка не поставлена.`);
  });
});

describe('document screens: legal.md, sections 1 and 3', () => {
  const collected = section(1);

  it('show the table of section 1 cell for cell', () => {
    const [columns, ...rows] = tableRows(collected.lines);
    expect(ru.documents.privacy.caption).toBe(collected.title);
    expect(ru.documents.privacy.columns).toEqual(columns);
    expect(ru.documents.privacy.rows).toEqual(rows);
  });

  it('show the line about what is not collected', () => {
    const afterTable = collected.lines.filter((line) => line.trim() !== '' && !line.startsWith('|')).map(plain);
    expect(afterTable).toEqual([ru.documents.privacy.notCollected]);
  });

  it('show the disclaimer of section 3', () => {
    expect(quoted(section(3).lines)).toEqual([ru.documents.terms.disclaimer]);
  });
});

/**
 * SHA-256 of the legal texts under every version the app has ever sent. Never edit a
 * line: a stored `consent_version` has to keep meaning the text the user saw. A new
 * wording is a new line, with a new CONSENT_VERSION.
 */
const TEXTS_BY_VERSION: Readonly<Record<string, string>> = {
  '2026-11-10': 'a85f638c28a3451dfe80543f250fabd1aebf8e4361ca580bd1102f83ce3d900b',
};

/** Every legal string of the app, in the order of the screens. */
function legalTexts(): string[] {
  const { consent, documents } = ru;
  return [
    consent.title,
    consent.lead,
    ...consent.points,
    consent.documents.privacy,
    consent.documents.terms,
    consent.checkbox,
    consent.submit,
    documents.privacy.caption,
    ...documents.privacy.columns,
    ...documents.privacy.rows.flat(),
    documents.privacy.notCollected,
    documents.terms.disclaimer,
  ];
}

describe('consent version', () => {
  it('is a calendar date, as legal.md asks, and fits the contract (1 to 32 characters)', () => {
    expect(CONSENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${CONSENT_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(CONSENT_VERSION);
  });

  it('changes together with the texts: the texts under the current version are the ones recorded for it', () => {
    const digest = createHash('sha256').update(legalTexts().join('\n')).digest('hex');
    expect({ [CONSENT_VERSION]: digest }).toEqual({ [CONSENT_VERSION]: TEXTS_BY_VERSION[CONSENT_VERSION] });
  });
});
