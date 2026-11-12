// @vitest-environment node
/*
 * Four screens show legal texts: the welcome screen (the short disclaimer and the line
 * under the button), the consent screen and the two documents. Agents do not write or
 * change those. They come from `legal-texts-<version>.md` in the repository root, a
 * file a human owns: every block between code fences there is a text for a screen.
 * This file holds the app to that:
 *  - every legal string of the app is the text of that file, in the same order, and
 *    nothing of the file is left out, except the one line named below;
 *  - the version sent to the server as `consent.version` changes whenever the texts do.
 * A new wording comes as a new file, `legal-texts-<new date>.md`. With that date in
 * CONSENT_VERSION the first groups fail until src/i18n/ru.ts repeats the new wording;
 * then the last one fails until the new texts are recorded under the new version.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSENT_VERSION, ru } from '../src/i18n/ru.ts';

const FILE = `legal-texts-${CONSENT_VERSION}.md`;
const SOURCE = readFileSync(join(import.meta.dirname, '../../..', FILE), 'utf8');

interface Section {
  title: string;
  /** The fenced blocks of the section; in each, its lines without the blank ones. */
  blocks: string[][];
}

/** The `## ` sections of the file with the texts they hold. Prose outside the fences is not for the screen. */
function parse(source: string): Section[] {
  const sections: Section[] = [];
  let block: string[] | null = null;
  for (const line of source.split('\n')) {
    if (line.trim() === '```') {
      if (block === null) {
        block = [];
        continue;
      }
      const section = sections.at(-1);
      if (!section) throw new Error(`${FILE}: a text block stands before the first section`);
      section.blocks.push(block);
      block = null;
    } else if (block !== null) {
      if (line.trim() !== '') block.push(line.trim());
    } else if (line.startsWith('## ')) {
      sections.push({ title: line.slice(3).trim(), blocks: [] });
    }
  }
  if (block !== null) throw new Error(`${FILE}: a code fence is not closed`);
  return sections;
}

const SECTIONS = parse(SOURCE);

/** The texts of the section whose title starts with `title`. */
function blocksOf(title: string): string[][] {
  const found = SECTIONS.filter((section) => section.title.startsWith(title));
  if (found.length !== 1) throw new Error(`${FILE}: expected one section «${title}», found ${String(found.length)}`);
  return found[0]?.blocks ?? [];
}

/** A line that still waits for a value from the owner, like `<контакт>`. */
const hasPlaceholder = (line: string) => /<[^<>]+>/.test(line);

/** A button of the file: its label, then, after a gap, a note in brackets on how it behaves. */
function button(line: string): { label: string; note: string } {
  const match = /^(.+?)\s{2,}\((.+)\)$/.exec(line);
  if (!match) throw new Error(`${FILE}: «${line}» is not a button with a note`);
  return { label: match[1] ?? '', note: match[2] ?? '' };
}

describe('legal texts of the app against the texts file', () => {
  it('reads the file of the version the app sends, with texts for the screens known here and for no other', () => {
    expect(SOURCE.split('\n')[0]).toBe(`# Тексты для приложения, версия ${CONSENT_VERSION}`);
    // A new block in the file is a text the app does not show yet.
    expect(SECTIONS.filter((section) => section.blocks.length > 0).map((section) => [section.title, section.blocks.length])).toEqual([
      ['Welcome — короткий дисклеймер (виден без прокрутки вместе с кнопкой)', 2],
      ['Экран согласия — заголовок', 1],
      ['Экран согласия — тело', 1],
      ['Экран согласия — ссылки', 1],
      ['Экран согласия — подпись галочки', 1],
      ['Экран согласия — кнопки', 1],
      ['Экран «Пользовательское соглашение» (полный дисклеймер + оферта, кратко)', 1],
      ['Экран «Политика обработки персональных данных» (кратко)', 1],
    ]);
  });

  it('welcome screen: the short disclaimer and the line under the button', () => {
    const [disclaimer, small] = blocksOf('Welcome');
    const copy = ru.welcome;
    expect([copy.disclaimer]).toEqual(disclaimer);
    // The words that are drawn as a link are a part of that very line.
    expect([`${copy.terms.before}${copy.terms.link}${copy.terms.after}`]).toEqual(small);
    expect(copy.terms.link).not.toBe('');
  });

  it('consent screen: the title, the body line by line, the two documents, the box and the two buttons', () => {
    const copy = ru.consent;
    expect([[copy.title]]).toEqual(blocksOf('Экран согласия — заголовок'));
    expect([[copy.lead, ...copy.points, copy.analytics]]).toEqual(blocksOf('Экран согласия — тело'));
    expect([[copy.documents.privacy, copy.documents.terms]]).toEqual(blocksOf('Экран согласия — ссылки'));
    expect([[copy.checkbox]]).toEqual(blocksOf('Экран согласия — подпись галочки'));

    const buttons = (blocksOf('Экран согласия — кнопки')[0] ?? []).map(button);
    expect(buttons.map(({ label }) => label)).toEqual([copy.submit, copy.decline]);
    // The notes are not shown: they say how the buttons behave. That behaviour is tested where it
    // lives (ConsentScreen.test.tsx, App.test.tsx); a note that changes means those tests need a look.
    expect(buttons.map(({ note }) => note)).toEqual([
      'неактивна, пока галочка не стоит',
      'возврат на Welcome; данные не собираются',
    ]);
  });

  it('document screens: every paragraph of the file, except the one line that still waits for a value', () => {
    const terms = blocksOf('Экран «Пользовательское соглашение»')[0] ?? [];
    const privacy = blocksOf('Экран «Политика обработки персональных данных»')[0] ?? [];

    // The support contact is the only such line. The day the owner writes the contact in, this
    // fails: the line then belongs on the screen like any other.
    expect([...terms, ...privacy].filter(hasPlaceholder)).toEqual(['Поддержка: <контакт>.']);
    expect(ru.documents.terms.paragraphs).toEqual(terms.filter((line) => !hasPlaceholder(line)));
    // The last line of the policy is the version line, built from the version the app sends.
    expect([...ru.documents.privacy.paragraphs, ru.documents.version(CONSENT_VERSION)]).toEqual(privacy);
    expect(legalTexts().filter(hasPlaceholder)).toEqual([]);
  });
});

/**
 * SHA-256 of the legal texts under every version the app has sent. A stored
 * `consent_version` has to keep meaning the text the user saw, so a new wording is a
 * new line here, with a new CONSENT_VERSION, and a line is never edited.
 *
 * The line of 2026-11-10 is the one exception, by the owner's decision written in the texts
 * file itself («Ответы на вопросы агентов по текстам», п. 2): the re-issue of that date (the
 * tone, the disclaimer, the paragraphs about usage statistics) keeps the version, and after
 * it any change of meaning is a new version. The re-issue reached the repository in two
 * parts, so this line was replaced twice. The app was not released in between (the same
 * file: «до этого продукт не публикуем»).
 */
const TEXTS_BY_VERSION: Readonly<Record<string, string>> = {
  '2026-11-10': 'ef14b5920bc66208d02a950204773dfb84bef558e09c1c5a68c15ff00b239770',
};

/** Every legal string of the app, in the order of the screens. */
function legalTexts(): string[] {
  const { welcome, consent, documents } = ru;
  return [
    welcome.disclaimer,
    welcome.terms.before,
    welcome.terms.link,
    welcome.terms.after,
    consent.title,
    consent.lead,
    ...consent.points,
    consent.analytics,
    consent.documents.privacy,
    consent.documents.terms,
    consent.checkbox,
    consent.submit,
    consent.decline,
    ...documents.privacy.paragraphs,
    ...documents.terms.paragraphs,
    documents.version(CONSENT_VERSION),
  ];
}

describe('consent version', () => {
  it('changes together with the texts: the texts under the current version are the ones recorded for it', () => {
    // A date: the app tells a refused version from anything else in the storage by this shape (src/lib/termsReload.ts).
    expect(CONSENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const digest = createHash('sha256').update(legalTexts().join('\n')).digest('hex');
    expect({ [CONSENT_VERSION]: digest }).toEqual({ [CONSENT_VERSION]: TEXTS_BY_VERSION[CONSENT_VERSION] });
  });
});
