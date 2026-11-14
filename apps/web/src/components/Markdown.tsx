import { useMemo, type ReactNode } from 'react';
import styles from './Markdown.module.css';

/*
 * The text of a report chapter is markdown written by a language model (`body_md`). It is
 * turned into React elements here, and into nothing else: no HTML string is ever built or
 * injected, so whatever the text contains can only end up on screen as text.
 *
 * What is understood is what the chapters are asked to use (docs/qa/reports/llm-prompts.md):
 * paragraphs, sub-headings, lists (also with the «—» marker), bold and italics. Raw HTML,
 * links and pictures are not part of the format: tags are dropped, a link leaves its words,
 * a picture leaves nothing.
 */

type ListBlock = { kind: 'bullets' | 'numbers'; items: string[] };
type Block = { kind: 'paragraph' | 'heading'; text: string } | ListBlock;

/** Anything shaped like a tag or an HTML comment. `a < b` is not: a tag starts with a letter. */
const HTML = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g;
/** The address of a link or a picture, brackets included; it may hold one more pair of brackets inside. */
const ADDRESS = '\\((?:[^()]|\\([^()]*\\))*\\)';
const IMAGE = new RegExp(`!\\[[^\\]]*\\]${ADDRESS}`, 'g');
const LINK = new RegExp(`\\[([^\\]]*)\\]${ADDRESS}`, 'g');
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^#{1,6}\s+(.+)$/;
const BULLET = /^[-*•–—]\s+(.+)$/;
const NUMBER = /^\d{1,3}[.)]\s+(.+)$/;

function blocksOf(source: string): Block[] {
  const blocks: Block[] = [];
  // What is being collected: the lines of a paragraph, the items of a list.
  const open: { paragraph: string[]; list: ListBlock | null } = { paragraph: [], list: null };
  const closeParagraph = () => {
    if (open.paragraph.length > 0) blocks.push({ kind: 'paragraph', text: open.paragraph.join(' ') });
    open.paragraph = [];
  };
  const closeList = () => {
    if (open.list) blocks.push(open.list);
    open.list = null;
  };

  const text = source.replace(/\r\n?/g, '\n').replace(HTML, '').replace(IMAGE, '').replace(LINK, '$1').replace(/`/g, '');
  for (const raw of text.split('\n')) {
    // A quote is read as ordinary text: its marker goes, its words stay.
    const line = raw.trim().replace(/^>\s?/, '');
    if (line === '' || RULE.test(line)) {
      closeParagraph();
      closeList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      blocks.push({ kind: 'heading', text: heading[1] ?? '' });
      continue;
    }
    const bullet = BULLET.exec(line);
    const item = bullet ?? NUMBER.exec(line);
    if (item) {
      const kind = bullet ? 'bullets' : 'numbers';
      closeParagraph();
      if (open.list?.kind !== kind) closeList();
      open.list ??= { kind, items: [] };
      open.list.items.push(item[1] ?? '');
      continue;
    }
    closeList();
    open.paragraph.push(line);
  }
  closeParagraph();
  closeList();
  return blocks;
}

/** `**bold**` and `*italics*`. A lone asterisk stays as it was typed. */
const EMPHASIS = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [whole, strong, emphasis] = match;
    nodes.push(strong === undefined ? <em key={match.index}>{emphasis}</em> : <strong key={match.index}>{strong}</strong>);
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => blocksOf(text), [text]);
  return (
    <div className={styles.markdown}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return <h3 key={index}>{inline(block.text)}</h3>;
          case 'bullets':
          case 'numbers': {
            const List = block.kind === 'bullets' ? 'ul' : 'ol';
            return (
              <List key={index} className={styles[block.kind]}>
                {block.items.map((item, position) => (
                  <li key={position}>{inline(item)}</li>
                ))}
              </List>
            );
          }
          default:
            return <p key={index}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
