// Fails the build when the shipped bundle exceeds the budget from SPEC.md
// ("Бандл фронта ≤ 350 КБ gzip") or carries dev-only settings.
// Counts every file a browser may download.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadEnv } from 'vite';

const BUDGET_BYTES = 350 * 1000;
const dist = join(import.meta.dirname, '..', 'dist');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(dist).filter((file) => !file.endsWith('.map'));
const rows = files
  .map((file) => ({ file: relative(dist, file), gzip: gzipSync(readFileSync(file), { level: 9 }).length }))
  .sort((a, b) => b.gzip - a.gzip);

const total = rows.reduce((sum, row) => sum + row.gzip, 0);
const kb = (/** @type {number} */ bytes) => `${(bytes / 1000).toFixed(1)} kB`;

for (const row of rows) console.log(`${kb(row.gzip).padStart(10)}  ${row.file}`);
console.log(`${kb(total).padStart(10)}  total gzip (budget ${kb(BUDGET_BYTES)})`);

if (total > BUDGET_BYTES) {
  console.error(`Bundle is over budget by ${kb(total - BUDGET_BYTES)}`);
  process.exit(1);
}

// Dev-only settings must not reach users (a developer's .env may hold the init data of an account).
// Two ways they can get in: `import.meta.env` inlined as a whole object, which leaves the variable
// name in the output, or a read outside an `import.meta.env.DEV` branch, which leaves the value.
const DEV_ONLY = ['VITE_DEV_INIT_DATA'];
const MIN_VALUE_LENGTH = 8; // shorter values would match unrelated code
const env = loadEnv(process.argv[2] ?? 'production', join(import.meta.dirname, '..'), 'VITE_');
const needles = DEV_ONLY.flatMap((name) => {
  const value = env[name] ?? '';
  return value.length >= MIN_VALUE_LENGTH ? [name, value] : [name];
});
const leaks = files.filter((file) => {
  const text = readFileSync(file, 'utf8');
  return needles.some((needle) => text.includes(needle));
});
if (leaks.length > 0) {
  console.error(`Dev-only settings (${DEV_ONLY.join(', ')}) are in the bundle: ${leaks.map((file) => relative(dist, file)).join(', ')}`);
  process.exit(1);
}
