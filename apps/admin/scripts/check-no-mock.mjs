#!/usr/bin/env node
/*
 * Страж: в собранной панели не должно быть ни мокерных данных, ни самого
 * мокерa. Проверка идёт по **артефакту сборки**, а не по «мы точно не включали»:
 * `vite build` с `API_MOCK=1` падает сам (vite.config.ts), но этот шаг ловит и
 * случай, когда кто-нибудь затащит fixture-файл в `src/` — тогда мокер
 * приедет в прод уже как код приложения, а не как dev-зависимость.
 *
 * Запускается последним шагом `pnpm --filter @astro-soul/admin run build`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = fileURLToPathSafe('../dist');
/** Строки, которые живут только в мокере. В продукте их быть не может. */
const FORBIDDEN = ['ADMIN_MOCK_FIXTURE_v1', 'mock/fixtures', 'admin_session=mock', 'DEMO_CSRF'];

function fileURLToPathSafe(related) {
  const url = new URL(related, import.meta.url);
  return decodeURIComponent(url.pathname);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(DIST).filter((file) => !file.endsWith('.map'));
} catch (error) {
  process.stderr.write(`check-no-mock: нет каталога ${DIST} — собери панель перед проверкой (${error.message})\n`);
  process.exit(1);
}

const hits = [];
let bytes = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  bytes += text.length;
  for (const marker of FORBIDDEN) {
    if (text.includes(marker)) hits.push(`${relative(DIST, file).split(sep).join('/')} → ${marker}`);
  }
}

if (hits.length > 0) {
  process.stderr.write(
    `check-no-mock: в сборке найдены мокерные строки (${hits.length} совпадений):\n` +
      hits.map((hit) => `  • ${hit}`).join('\n') +
      '\nСборка с фиктивными данными запрещена: экран с выдуманными цифрами опаснее отсутствующего экрана.\n',
  );
  process.exit(1);
}

process.stdout.write(`check-no-mock: ok — ${files.length} файлов сборки, ${(bytes / 1024).toFixed(1)} кБ, мокер-строк нет\n`);
