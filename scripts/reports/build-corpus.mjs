#!/usr/bin/env node
/**
 * Сборка корпуса примеров для промптов (P0-6).
 *
 * `docs/qa/reports/examples.md` нельзя вставлять в промпт целиком:
 * антипримеры (§3.1–3.5) намеренно содержат «карма», «в прошлой жизни»,
 * «Вселенная ведёт», «миссия» — иначе они не были бы антипримерами, — и
 * регулярки из `llm-prompts.md` §5.4 забракуют любой текст, собранный из
 * файла целиком.
 *
 * Правила (backend-requests.md P0-6):
 *   • в корпус идут только блоки после маркера «**Как надо:**»;
 *   • полные главы (§1, §2) не идут вообще: как few-shot они задают карту,
 *     и все разборы начнут быть про Тельца с Луной в Льве;
 *   • судья получает текст рубрики, без антипримеров.
 *
 * Запуск: node scripts/reports/build-corpus.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = 'docs/qa/reports/examples.md';
const TARGET = 'apps/api/src/modules/reports/corpus.generated.json';

/** Подстроки, которых в корпусе быть не может (тест P0-6). */
export const FORBIDDEN_IN_CORPUS = ['карм', 'мисси', 'в прошлой жизни', 'Вселенная ведёт', 'предсказан'];

const MARKER = '**Как надо:**';

function buildCorpus(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let section = 'unknown';
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Идентификатор раздела — ближайший заголовок «### 3.2 Лесть».
    const heading = /^###\s+(\S+)/.exec(line);
    if (heading !== null) {
      section = heading[1] ?? 'unknown';
    }

    if (line.trim() === MARKER) {
      index += 1;
      const collected = [];

      // Между маркером и цитатой в файле стоит пустая строка — пропускаем её.
      while (index < lines.length && (lines[index] ?? '').trim() === '') {
        index += 1;
      }

      // Блок цитаты: строки «> …» до пустой строки.
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        collected.push((lines[index] ?? '').replace(/^>\s?/, '').trim());
        index += 1;
      }

      const text = collected.join('\n').trim();
      if (text !== '') {
        blocks.push({ section, text });
      }
      continue;
    }

    index += 1;
  }

  return blocks;
}

function main() {
  const markdown = readFileSync(resolve(ROOT, SOURCE), 'utf8');
  const blocks = buildCorpus(markdown);

  if (blocks.length === 0) {
    console.error(`в ${SOURCE} не найдено ни одного блока после «${MARKER}»`);
    process.exit(1);
  }

  const dirty = [];
  for (const block of blocks) {
    for (const forbidden of FORBIDDEN_IN_CORPUS) {
      if (block.text.toLowerCase().includes(forbidden.toLowerCase())) {
        dirty.push(`${block.section}: ${forbidden}`);
      }
    }
  }

  if (dirty.length > 0) {
    console.error(`в корпус попали запрещённые подстроки: ${dirty.join(', ')}`);
    process.exit(1);
  }

  const payload = {
    // Версия корпуса = версия примеров; меняется вместе с examples.md.
    version: 'examples_v1',
    source: SOURCE,
    built_by: 'scripts/reports/build-corpus.mjs',
    blocks,
  };

  writeFileSync(resolve(ROOT, TARGET), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`корпус собран: ${blocks.length} блоков → ${TARGET}`);
}

main();
