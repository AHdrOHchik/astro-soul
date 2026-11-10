// @vitest-environment node
/*
 * Guards for rules a reviewer should not have to check by eye:
 *  - raw colours, sizes and timings live in theme.css only (one place to restyle from);
 *  - no CSS that the oldest supported engines silently ignore (see BROWSER_TARGET in vite.config.ts);
 *  - no inline styles and no interface text outside src/i18n (AGENTS.md, Definition of Done, item 7).
 * The UI kit is checked here too: it is styled by this app's tokens.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '../../..');
const WEB_SRC = join(REPO, 'apps/web/src');
const UI_SRC = join(REPO, 'packages/ui/src');
const THEME = join(WEB_SRC, 'theme.css');

interface Source {
  /** Repository-relative, with forward slashes. */
  path: string;
  text: string;
}

function read(file: string): Source {
  return { path: relative(REPO, file).split(sep).join('/'), text: readFileSync(file, 'utf8') };
}

function sources(root: string, extension: RegExp): Source[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => extension.test(name))
    .sort()
    .map((name) => read(join(root, name)));
}

/** Blanks out comments but keeps every line break, so reported line numbers stay true. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

interface Declaration {
  property: string;
  value: string;
  line: number;
}

interface Rule {
  selector: string;
  line: number;
  declarations: Declaration[];
}

/** Innermost `{…}` blocks: style rules and keyframe steps, also inside @media / @supports. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, prelude = '', body = ''] = block;
    const bodyStart = block.index + prelude.length + 1;
    const declarations: Declaration[] = [];
    for (const declaration of body.matchAll(/([-\w]+)\s*:([^;]+)/g)) {
      const [, property = '', value = ''] = declaration;
      declarations.push({ property, value: value.trim(), line: lineAt(css, bodyStart + declaration.index) });
    }
    rules.push({ selector: prelude.trim().replace(/\s+/g, ' '), line: lineAt(css, block.index + prelude.search(/\S/)), declarations });
  }
  return rules;
}

const css = [...sources(WEB_SRC, /\.css$/), ...sources(UI_SRC, /\.css$/)].map((file) => ({
  ...file,
  text: withoutComments(file.text),
}));
const theme = css.find((file) => file.path === relative(REPO, THEME).split(sep).join('/'));
const componentCss = css.filter((file) => file !== theme);

const isTest = (path: string) => /\.test\.tsx?$/.test(path) || path.includes('/src/test/');
const code = [...sources(WEB_SRC, /\.tsx?$/), ...sources(UI_SRC, /\.tsx?$/)].filter(
  (file) => !isTest(file.path) && !file.path.endsWith('.gen.d.ts'),
);

/** A token name may contain digits and colour words (`--space-4`, `--color-gold`): judge the rest of the value. */
const withoutTokenNames = (value: string) => value.replace(/--[-\w]+/g, '--token');

const COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(|\b(?:black|white|red|green|blue|yellow|orange|purple|pink|violet|gr[ae]y|silver|gold|brown|cyan|magenta|navy|teal|lime|olive|maroon|aqua|fuchsia)\b/i;
/** Lengths and times. `0`, percentages, unitless numbers, `fr` and `deg` are not design decisions. */
const DIMENSION_LITERAL = /(?<![-\w.#])\d*\.?\d+(?:px|r?em|d?v[hw]|[sl]v[hw]|vmin|vmax|ch|ex|pt|pc|cm|mm|in|m?s)\b/i;

describe('design tokens', () => {
  it('finds the stylesheets it is meant to check', () => {
    expect(theme).toBeDefined();
    expect(componentCss.length).toBeGreaterThan(10);
    expect(code.length).toBeGreaterThan(20);
  });

  it('keeps raw colours, sizes and timings in theme.css', () => {
    const found: string[] = [];
    for (const file of componentCss) {
      for (const rule of rulesOf(file.text)) {
        for (const { property, value, line } of rule.declarations) {
          const bare = withoutTokenNames(value);
          if (COLOR_LITERAL.test(bare)) found.push(`${file.path}:${line} colour literal in "${property}: ${value}"`);
          if (DIMENSION_LITERAL.test(bare)) found.push(`${file.path}:${line} size or time literal in "${property}: ${value}"`);
        }
      }
      for (const atRule of file.text.matchAll(/@(?:media|supports)[^{]*/g)) {
        if (DIMENSION_LITERAL.test(atRule[0])) {
          found.push(`${file.path}:${lineAt(file.text, atRule.index)} size literal in "${atRule[0].trim()}"`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('references only tokens that exist', () => {
    const defined = (text: string) => new Set(Array.from(text.matchAll(/(--[-\w]+)\s*:/g), (match) => match[1]));
    const tokens = defined(theme?.text ?? '');
    const found: string[] = [];
    for (const file of css) {
      const local = defined(file.text);
      for (const use of file.text.matchAll(/var\(\s*(--[-\w]+)/g)) {
        const name = use[1] ?? '';
        // --tg-* are set at runtime by the Telegram SDK (viewport.bindCssVars) and always used with a fallback.
        if (name.startsWith('--tg-') || tokens.has(name) || local.has(name)) continue;
        found.push(`${file.path}:${lineAt(file.text, use.index)} unknown token ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('has no dead tokens', () => {
    const everything = [...css.map((file) => file.text), ...code.map((file) => file.text)].join('\n');
    const names = Array.from((theme?.text ?? '').matchAll(/(--[-\w]+)\s*:/g), (match) => match[1] ?? '');
    const unused = [...new Set(names)].filter((name) => !new RegExp(`var\\(\\s*${name}\\b|['"\`]${name}['"\`]`).test(everything));
    expect(unused).toEqual([]);
  });
});

describe('engine floor (Chromium 80, Safari 15)', () => {
  it('uses `gap` only on grids: flex gap needs Chromium 84 / Safari 14.1', () => {
    const found: string[] = [];
    for (const file of css) {
      for (const rule of rulesOf(file.text)) {
        const gap = rule.declarations.find(({ property }) => /^(?:row-|column-)?gap$/.test(property));
        const isGrid = rule.declarations.some(({ property, value }) => property === 'display' && /^(?:inline-)?grid$/.test(value));
        if (gap && !isGrid) found.push(`${file.path}:${gap.line} "${rule.selector}" sets gap without display: grid`);
      }
    }
    expect(found).toEqual([]);
  });

  it('avoids CSS the build cannot lower for those engines', () => {
    const banned: [name: string, pattern: RegExp][] = [
      ['aspect-ratio (Chromium 88)', /(?<![-\w])aspect-ratio\s*:/],
      ['inset (Chromium 87)', /(?<![-\w])inset(?:-inline|-block)?(?:-start|-end)?\s*:/],
      [':has() (Chromium 105, Safari 15.4)', /:has\(/],
      [':is() / :where() (Chromium 88)', /:(?:is|where)\(/],
      ['@layer (Chromium 99, Safari 15.4)', /@layer\b/],
      ['@container (Chromium 105, Safari 16)', /@container\b/],
      ['CSS nesting (Chromium 112, Safari 16.5)', /&\s*[.:[>+~]/],
    ];
    const found: string[] = [];
    for (const file of css) {
      for (const [name, pattern] of banned) {
        const match = pattern.exec(file.text);
        if (match) found.push(`${file.path}:${lineAt(file.text, match.index)} ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('never lets :focus-visible take a whole selector list down with it', () => {
    // An engine that does not know a pseudo-class drops the entire rule, including the selectors it does know.
    const found: string[] = [];
    for (const file of css) {
      for (const rule of rulesOf(file.text)) {
        const selectors = rule.selector.split(',');
        const modern = selectors.filter((selector) => selector.includes(':focus-visible'));
        if (modern.length > 0 && modern.length < selectors.length) found.push(`${file.path}:${rule.line} "${rule.selector}"`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('components', () => {
  it('have no inline styles', () => {
    const found = code.filter((file) => /\sstyle=/.test(file.text)).map((file) => file.path);
    expect(found).toEqual([]);
  });

  it('keep interface text in src/i18n', () => {
    const found: string[] = [];
    for (const file of code) {
      if (file.path.startsWith('apps/web/src/i18n/')) continue;
      file.text.split('\n').forEach((line, index) => {
        if (/[\u0400-\u04FF]/.test(line)) found.push(`${file.path}:${index + 1} ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
