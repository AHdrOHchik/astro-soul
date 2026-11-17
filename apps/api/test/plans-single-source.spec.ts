import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Цены не живут в коде — и это проверяется репозиторием, а не обещанием.
 *
 * Дефект `compat_249` был ровно в этом: витрина читала `packages/shared/src/plans.ts`,
 * счёт — тоже, а окно Telegram показывало сумму, которую посчитал другой
 * читатель. Чтобы «третьего читателя» нельзя было завести заново, тест ищет
 * числа `149 | 249 | 399 | 590 | 2990` во всём рантайм-коде и падает, если
 * встретит их вне разрешённых мест:
 *   • `apps/api/src/db/plans-seed.ts` — сид каталога: единственный файл с
 *     ценами, он наполняет таблицу `plans` (и не переписывает её потом);
 *   • миграции (`migrations/`, `apps/api/src/db/migrations/` — если появятся);
 *   • `*.spec.ts` — тесты вправе называть числа: они-то и проверяют цены.
 *
 * Специально вне проверки остаются данные-справочники (`packages/shared/src/geo`)
 * — там координаты и население, совпадающие с ценой случайно. Комментарии
 * вырезаются: объяснение «80 ₽ при цене 149 ⭐» читателю не цена.
 */

/** Коды планов — это `one_149`, а не 149; такие совпадения ценой не считаем. */
const PRICE_PATTERN = /(?<![\w.$])(149|249|399|590|2990)(?![\w.])/g;

/**
 * Корень `apps/api`: vitest запускается из пакета, но `pnpm test` из корня
 * тоже возможен — тогда ищем пакет на уровень ниже, а не угадываем.
 */
function apiRoot(): string {
  const candidates = [process.cwd(), path.join(process.cwd(), 'apps', 'api')];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'src', 'db', 'plans-seed.ts'))) {
      return candidate;
    }
  }

  throw new Error(`не нашёл apps/api из ${process.cwd()}: тест должен видеть src/db/plans-seed.ts`);
}

const API_SRC = path.join(apiRoot(), 'src');
const SHARED_SRC = path.join(apiRoot(), '..', '..', 'packages', 'shared', 'src');

/** Файлы, которым цены разрешены, — с причиной, чтобы список не «рос молча». */
const ALLOWED = [
  path.join('db', 'plans-seed.ts'), // наполняет `plans`; правка цены — в БД, не тут
];

/**
 * Вырезает `//` и `/* *\/`-комментарии, уважая строки и шаблоны.
 *
 * Наивный `source.replace(/\/\/.*$/gm, '')` режет `https://…` и вместе с ним
 * половину строки — тогда настоящую цену в коде тест бы пропустил.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1];

    if (mode === 'code') {
      if (char === '/' && next === '/') {
        mode = 'line';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        mode = 'block';
        index += 2;
        continue;
      }
      if (char === "'") {
        mode = 'single';
      } else if (char === '"') {
        mode = 'double';
      } else if (char === '`') {
        mode = 'template';
      }
      out += char;
      index += 1;
      continue;
    }

    if (mode === 'line') {
      if (char === '\n') {
        mode = 'code';
        out += char;
      }
      index += 1;
      continue;
    }

    if (mode === 'block') {
      if (char === '*' && next === '/') {
        mode = 'code';
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    // Строка/шаблон: экранирование и закрывающая кавычка.
    if (char === '\\') {
      out += char + (next ?? '');
      index += 2;
      continue;
    }
    if (
      (mode === 'single' && char === "'") ||
      (mode === 'double' && char === '"') ||
      (mode === 'template' && char === '`')
    ) {
      mode = 'code';
    }
    out += char;
    index += 1;
  }

  return out;
}

/** Совпадения цены в одном файле: путь, строка, фрагмент — для читаемого падения. */
function findPriceLiterals(file: string, source: string): string[] {
  const hits: string[] = [];

  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      PRICE_PATTERN.lastIndex = 0;
      if (PRICE_PATTERN.test(line)) {
        hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
      }
    });

  return hits;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }

  return files;
}

function isExempt(file: string): boolean {
  if (file.endsWith('.spec.ts')) {
    return true;
  }
  if (file.split(path.sep).includes('migrations')) {
    return true;
  }
  // Данные-справочники: координаты и население городов, совпадения случайны.
  if (file.split(path.sep).includes('geo')) {
    return true;
  }

  return ALLOWED.some((suffix) => file.endsWith(suffix));
}

describe('единственный источник цены — таблица plans', () => {
  it('в apps/api/src и packages/shared/src нет цен вне сида, миграций и тестов', () => {
    const files = [...listFiles(API_SRC), ...listFiles(SHARED_SRC)].filter((file) => !isExempt(file));

    // Проверка не должна быть пустой: если файлы не нашлись, она бы «проходила»
    // всегда. 100+ файлов — реальный объём рантайм-кода в этих двух пакетах.
    expect(files.length).toBeGreaterThan(50);

    const hits = files.flatMap((file) => findPriceLiterals(path.relative(process.cwd(), file), fs.readFileSync(file, 'utf8')));

    // Цена в коде = второй читатель цены = снова три разных ответа на один
    // вопрос «сколько стоит». Убирай число в `plans` (сид/миграция).
    expect(hits, `цена в коде:\n${hits.join('\n')}`).toEqual([]);
  });

  it('сид каталога цены содержит — иначе проверка выше ничего не значит', () => {
    const seed = fs.readFileSync(path.join(API_SRC, 'db', 'plans-seed.ts'), 'utf8');
    const hits = findPriceLiterals(path.join('apps/api/src/db', 'plans-seed.ts'), seed);

    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits.join('\n')).toContain('stars: 249');
  });

  it('ловит цену в коде и не ловит код плана, комментарий и координату', () => {
    expect(findPriceLiterals('x.ts', 'const stars = 249;')).toHaveLength(1);
    expect(findPriceLiterals('x.ts', 'stars: 399,')).toHaveLength(1);
    // Код плана — не цена: `one_149`, `compat_249`, `year_2990`.
    expect(findPriceLiterals('x.ts', "code: 'one_149'")).toEqual([]);
    expect(findPriceLiterals('x.ts', "const code = 'compat_249';")).toEqual([]);
    // Комментарий — объяснение, а не источник.
    expect(findPriceLiterals('x.ts', '// 80 ₽ на товар за 249 ⭐ — убыток')).toEqual([]);
    expect(findPriceLiterals('x.ts', '/* цена 149 */')).toEqual([]);
    // Строка с URL не должна «съедать» остаток строки.
    expect(findPriceLiterals('x.ts', "const u = 'https://t.me/x'; const s = 590;")).toHaveLength(1);
    // Координаты и население городов.
    expect(findPriceLiterals('ct.ts', '{ lat: 31.2497, population: 2823249 }')).toEqual([]);
  });
});
