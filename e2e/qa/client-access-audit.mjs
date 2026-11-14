#!/usr/bin/env node
/**
 * QA-002, задача 3.1: статическая проверка «клиент не решает о платном доступе»
 * и «обещания в текстах имеют код».
 *
 * Без браузера: ищем в `apps/web/src` (кроме тестов) места, где клиент читает
 * признаки платного доступа и делает по ним вывод, и сверяем обещания из
 * `i18n/ru.ts` с наличием соответствующего экрана/джоба в коде.
 *
 * Ожидание приёмки: решений о доступе на клиенте нет — только показ того, что
 * дал сервер; каждое обещание в тексте подтверждено кодом.
 *
 * Запуск: node e2e/qa/client-access-audit.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = join(ROOT, 'apps/web/src');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const isTest = (p) => /\.test\.(ts|tsx)$/.test(p) || p.includes('/test/');
const files = walk(WEB).filter((f) => !isTest(f));

/** Признаки платного доступа: чтение их не запрещено, запрещено РЕШАТЬ по ним. */
const ACCESS_MARKERS = ['entitlements', 'full_report', 'full_forecast', 'is_active', 'solar_included', 'expires_at', 'plan ===', 'plan !=='];
/** Решение — сравнение/ветвление по признаку доступа. */
const DECISION = /\b(if|return|&&|\|\||\?|===|!==)\b/;

console.log('=== 3.1 Клиент и платный доступ ===');
console.log(`файлов вне тестов: ${files.length}`);
let decisions = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    const marker = ACCESS_MARKERS.find((m) => trimmed.includes(m));
    if (marker === undefined) return;
    const decides = DECISION.test(trimmed);
    console.log(`  ${relative(ROOT, file)}:${i + 1}  ${marker}  ${decides ? '← РЕШЕНИЕ' : '(только чтение/тип)'}`);
    if (decides) decisions += 1;
  });
}
console.log(decisions === 0 ? '  итог: решений о доступе на клиенте нет' : `  итог: ${decisions} мест(а) с решением — проверить вручную`);

console.log('\n=== 3.1 Обещания в текстах и их код ===');
const ru = readFileSync(join(WEB, 'i18n/ru.ts'), 'utf8');
const API = join(ROOT, 'apps/api/src');
const apiFiles = walk(API);
const apiText = apiFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const webText = files.map((f) => readFileSync(f, 'utf8')).join('\n');

const PROMISES = [
  {
    text: /Настройки → «Удалить мои данные»/,
    what: 'экран Settings с кнопкой удаления',
    present: /Settings|Удалить мои данные/.test(webText.replace(/i18n\/ru\.ts[\s\S]*/, ru)) && files.some((f) => /Settings\.tsx|SettingsScreen/.test(f)),
    note: 'DELETE /me есть, экрана в приложении нет',
  },
  {
    text: /не заходишь 24 месяца, данные удаляются автоматически/,
    what: 'джоб автоудаления по неактивности 24 мес',
    present: /24 month|inactiv|retention|purge/i.test(apiText),
    note: 'джобы: subscriptions_downgrade, refund_undelivered',
  },
  {
    text: /Написать в поддержку|поддержк/i,
    what: 'контакт поддержки в UI',
    present: /t\.me\/[a-z_]*support|support.*username/i.test(webText),
    note: 'строка поддержки — заглушка (ru.ts:224)',
  },
];

for (const p of PROMISES) {
  const promised = p.text.test(ru);
  if (!promised) {
    console.log(`  «${p.what}»: в текстах не обещается`);
    continue;
  }
  console.log(`  «${p.what}»: обещано в ru.ts → код ${p.present ? 'ЕСТЬ' : 'ОТСУТСТВУЕТ'} (${p.note})`);
}
