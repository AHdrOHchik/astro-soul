/**
 * Сборка пакета — две папки, и у каждой свой формат модулей.
 *
 * Корневой `package.json` пакета объявлен как `"type": "module"` (иначе фронт
 * в dev-режиме получает CJS-файл, который Vite отдаёт как есть, и падает на
 * `does not provide an export named`). Значит CJS-сборке нужен собственный
 * `package.json` с `"type": "commonjs"` — иначе Node считает `dist/cjs/*.js`
 * ESM и `require('@astro-soul/shared')` из API ломается.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['dist/esm', { type: 'module' }],
  ['dist/cjs', { type: 'commonjs' }],
];

for (const [dir, manifest] of targets) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write('dist/esm и dist/cjs помечены своим форматом модулей\n');
