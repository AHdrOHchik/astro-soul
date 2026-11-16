import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Предохранитель формата сборки пакета.
 *
 * 18.11.2026 фронт упал на первом экране:
 *   `does not provide an export named 'MIN_QUERY_LENGTH'`.
 * Сборка была CJS (`exports.MIN_QUERY_LENGTH = 2`), а Vite в dev отдаёт файлы
 * workspace-пакета через `/@fs/…` как есть, без CJS→ESM конвертации. Сборка
 * `apps/web` этого не видит: там Rollup приводит CJS к ESM сам, поэтому баг
 * дожил до ручного запуска dev-сервера.
 *
 * Проверка запускает **настоящий Node** на **собранных файлах**, а не
 * транспилирует их на лету: vitest иначе «прощает» ровно то, что ломает
 * браузер. Обе сборки — ESM для фронта и CJS для API — обязаны читать
 * именованные экспорты.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const esmEntry = join(packageRoot, 'dist/esm/index.js');
const cjsEntry = join(packageRoot, 'dist/cjs/index.js');
const esmLimits = join(packageRoot, 'dist/esm/geo/limits.js');
const esmSearch = join(packageRoot, 'dist/esm/geo/search.js');

/** Имена, которые обязаны читаться и которые реально нужны потребителям. */
const SEARCH_EXPORTS = ['searchCities', 'normalizeCityQuery', 'CITY_COUNT'] as const;
const ROOT_EXPORTS = [...SEARCH_EXPORTS, 'CITIES', 'findNearestCity', 'haversineKm'] as const;

function runNode(args: readonly string[]): string {
  return execFileSync(process.execPath, args, { encoding: 'utf8' });
}

describe('формат сборки пакета', () => {
  it('собран: ESM и CJS лежат там, куда смотрит exports', () => {
    expect(existsSync(esmEntry), `нет ${esmEntry}: собери пакет (pnpm --filter @astro-soul/shared build)`).toBe(true);
    expect(existsSync(cjsEntry), `нет ${cjsEntry}: собери пакет (pnpm --filter @astro-soul/shared build)`).toBe(true);
    expect(existsSync(esmLimits)).toBe(true);
  });

  it('ESM-сборка отдаёт именованные экспорты настоящему Node (то, чем живёт Vite в dev)', () => {
    // Именно эта строка падала в браузере: `import { MIN_QUERY_LENGTH } from '…/dist/geo/limits.js'`.
    const script =
      // `limits.js` экспортирует только типы: файл обязан остаться валидным ESM
      // (импорт не должен падать), а именованные значения — в `search.js` и корне.
      `await import(${JSON.stringify(esmLimits)});` +
      `const search = await import(${JSON.stringify(esmSearch)});` +
      `const root = await import(${JSON.stringify(esmEntry)});` +
      'console.log(JSON.stringify({' +
      ` search: ${JSON.stringify([...SEARCH_EXPORTS])}.map((name) => [name, typeof search[name]]),` +
      ` root: ${JSON.stringify([...ROOT_EXPORTS])}.map((name) => [name, typeof root[name]]),` +
      '}));';

    const output = runNode(['--input-type=module', '-e', script]);
    const parsed = JSON.parse(output) as {
      search: [string, string][];
      root: [string, string][];
    };

    for (const [name, kind] of [...parsed.search, ...parsed.root]) {
      expect(kind, `именованный экспорт ${name} не читается из ESM-сборки`).not.toBe('undefined');
    }
  });

  it('CJS-сборка читается через require — этим живёт API (Nest собирается в CommonJS)', () => {
    const script =
      'const m = require(' + JSON.stringify(cjsEntry) + ');' +
      'console.log(JSON.stringify(' + JSON.stringify([...ROOT_EXPORTS]) +
      '.map((name) => [name, typeof m[name]])));';

    const parsed = JSON.parse(runNode(['-e', script])) as [string, string][];
    for (const [name, kind] of parsed) {
      expect(kind, `именованный экспорт ${name} не читается из CJS-сборки`).not.toBe('undefined');
    }
  });

  it('в ESM-сборке нет CJS-обёртки: `export`, а не `exports.`', () => {
    const source = execFileSync(process.execPath, ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(esmSearch)}, 'utf8'))`], {
      encoding: 'utf8',
    });
    expect(source).toMatch(/^export const /m);
    expect(source).not.toMatch(/^exports\./m);
  });
});
