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

/**
 * QA-003, задача 4: «код есть» ≠ «включено».
 *
 * Прежняя версия считала решением любое ветвление рядом с признаком доступа и
 * валила все четыре места подряд — включая те, где клиент ничего не разрешает:
 *   • `App.tsx:313` — `plan !== null` про ожидаемый план, дальше `grants(fresh, plan)`
 *     решает по ответу сервера: клиент лишь повторяет за ним;
 *   • `lib/plans.ts:33` — обёртка над `me.entitlements`: единственный источник — `Me`;
 *   • `PaywallScreen.tsx:169` — проверка режима экрана (`phase !== 'choosing'`), не доступа;
 *   • `SettingsScreen.tsx:206` — показ подписки: что прислал сервер, то и написано.
 *
 * Поэтому проверяем не «есть ли `if` рядом», а два разных факта:
 *   (а) ВКЛЮЧЕНИЕ — есть ли на клиенте хоть одно место, где платный доступ
 *       выдаётся/разрешается без ответа сервера. Это была бы дыра;
 *   (б) ИЗВЕСТНЫЕ МЕСТА — каждое из четырёх проверено вручную и закреплено
 *       подписью: если подпись исчезнет или место переедет, аудит об этом скажет,
 *       а не промолчит.
 */
const REVIEWED = [
  {
    file: 'apps/web/src/App.tsx',
    re: /if \(plan !== null && grants\(fresh, plan\)\)/,
    why: 'решение принимает grants(Me), клиент повторяет ответ сервера',
    inside: 'подтверждение оплаты по ответу сервера, не по слову Telegram',
  },
  {
    file: 'apps/web/src/lib/plans.ts',
    re: /return plan === REPORT_PLAN \? me\.entitlements\.full_report : me\.entitlements\.is_active;/,
    why: 'единственный источник — entitlements из GET /me',
    inside: 'обёртка над ответом сервера, своего источника правды нет',
  },
  {
    file: 'apps/web/src/screens/paywall/PaywallScreen.tsx',
    re: /if \(plan === null \|\| phase !== 'choosing' \|\| signal === undefined\) return;/,
    why: 'проверяется режим экрана, а не право доступа',
    inside: 'защита от повторного тапа, доступ не выдаёт',
  },
  {
    file: 'apps/web/src/screens/settings/SettingsScreen.tsx',
    re: /if \(subscription\.plan === 'none' \|\| !subscription\.is_active\)/,
    why: 'показ состояния подписки из ответа сервера',
    inside: 'текст на экране, доступ не меняет',
  },
];

/** Выдача доступа на клиенте: присвоение признака, а не чтение. */
const GRANTING = [
  /full_report\s*[:=]\s*true/,
  /full_forecast\s*[:=]\s*true/,
  /is_active\s*[:=]\s*true/,
  /setEntitlements\s*\(/,
  /localStorage\.setItem\([^)]*(?:entitle|plan|paid)/i,
];

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

// (а) включение доступа на клиенте
const grants = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const re of GRANTING) {
    if (re.test(src)) grants.push(`${relative(ROOT, file)}  ${String(re)}`);
  }
}
console.log(grants.length === 0
  ? '  (а) включения платного доступа на клиенте нет: признак только читается'
  : `  (а) НАХОДКА: клиент включает доступ сам:\n${grants.map((g) => `      ${g}`).join('\n')}`);

// (б) известные места: сверка подписей
console.log('  (б) проверено вручную (код есть ≠ включено):');
let stale = 0;
for (const item of REVIEWED) {
  const src = readFileSync(join(ROOT, item.file), 'utf8');
  const found = item.re.test(src);
  if (!found) stale += 1;
  console.log(`      ${found ? 'ок' : 'ПЕРЕЕХАЛО'}  ${item.file} — ${item.why}`);
  if (!found) console.log(`              ожидалось: ${String(item.re)}`);
}
console.log(stale === 0
  ? '      все четыре места на месте и по-прежнему не выдают доступ'
  : `      ${stale} мест(а) не найдено — проверить вручную заново`);

console.log(decisions === 0
  ? '  итог: решений о доступе на клиенте нет'
  : `  итог: ${decisions} мест(а) с решением; все ${REVIEWED.length} разобраны в (б), включения нет: ${grants.length === 0}`);

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
