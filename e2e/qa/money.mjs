#!/usr/bin/env node
/**
 * QA-стенд: платежи на живом API + реальном Postgres + стабе Bot API.
 *
 * Ничего не проверяет сам — печатает факты (ответы, состояние БД, журнал
 * вызовов Bot API), чтобы в отчёте были артефакты, а не пересказ.
 *
 * Использование: node e2e/qa/money.mjs m3|m4|m6|m7|m10|all
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const API = process.env.QA_API ?? 'http://127.0.0.1:8080/api/v1';
const STUB = process.env.QA_STUB ?? 'http://127.0.0.1:8091';
const DSN = process.env.QA_DSN ?? 'postgres://postgres@127.0.0.1:5432/astro_soul';
const TOKEN = process.env.QA_BOT_TOKEN ?? '123456789:QA-TEST-TOKEN-not-real';
const PEPPER = process.env.QA_PEPPER ?? 'qa-pepper-0123456789-0123456789-0123456789';
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? 'qa-webhook-secret-0123456789';
const PSQL = process.env.QA_PSQL;
const USER_ID = 777_000_111;

function sql(query) {
  const out = execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'astro_soul', '-tAF|', '-c', query], {
    encoding: 'utf8',
  });
  return out.trim();
}

function signInitData({ userId = USER_ID, authDate = Math.floor(Date.now() / 1000), firstName = 'Тест' } = {}) {
  const fields = {
    query_id: `AAQ${userId}${authDate}`,
    user: JSON.stringify({ id: userId, first_name: firstName, last_name: 'Тестов', username: 'qa_fictional', language_code: 'ru' }),
    auth_date: String(authDate),
  };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const INIT = signInitData();

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'x-telegram-init-data': INIT, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function stubCalls() {
  const res = await fetch(`${STUB}/__calls`);
  return res.json();
}

async function stubReset() {
  await fetch(`${STUB}/__calls/reset`, { method: 'POST' });
}

async function stubFail(fail) {
  await fetch(`${STUB}/__config`, { method: 'POST', body: JSON.stringify({ fail }) });
}

async function webhook(update) {
  const res = await fetch(`${API}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
  return { status: res.status, body: await res.text() };
}

const charge = (suffix) => `qa-charge-${suffix}-${randomUUID()}`;

function successfulPayment({ payload, chargeId, amount, expiration }) {
  const payment = {
    currency: 'XTR',
    total_amount: amount,
    invoice_payload: payload,
    telegram_payment_charge_id: chargeId,
    provider_payment_charge_id: `prov-${chargeId}`,
  };
  if (expiration !== undefined) payment.subscription_expiration_date = expiration;
  return { update_id: Math.floor(Math.random() * 1e9), message: { chat: { id: USER_ID }, from: { id: USER_ID }, successful_payment: payment } };
}

function userId() {
  // Детерминированный UUID = HMAC(pepper, "telegram:<id>") с версией 5 —
  // один в один с apps/api/src/modules/users/pseudonym.ts.
  const digest = Buffer.from(createHmac('sha256', PEPPER).update(`telegram:${USER_ID}`).digest().subarray(0, 16));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

function dump(label) {
  const uid = userId();
  const payments = sql(`SELECT plan_code, total_amount, status, processed, coalesce(refunded_at::text,'-'), telegram_id FROM payments WHERE user_id = '${uid}' ORDER BY created_at`);
  const subs = sql(`SELECT plan, status, expires_at FROM subscriptions WHERE user_id = '${uid}'`);
  const ents = sql(`SELECT kind, status, coalesce(chart_id::text,'-') FROM entitlements WHERE user_id = '${uid}' ORDER BY kind`);
  console.log(`\n--- ${label}`);
  console.log('payments   :', payments === '' ? '(пусто)' : '');
  if (payments !== '') console.log(payments);
  console.log('subscriptions:', subs === '' ? '(пусто)' : subs);
  console.log('entitlements :', ents === '' ? '(пусто)' : ents);
  return { payments, subs, ents };
}

async function me() {
  const r = await api('/me');
  return { status: r.status, subscription: r.body.subscription, entitlements: r.body.entitlements };
}

/** Создаёт инвойс и возвращает payload, который сервер отправил в Bot API. */
async function invoice(planCode) {
  const r = await api('/billing/invoice', { method: 'POST', body: JSON.stringify({ plan_code: planCode }) });
  if (r.status !== 201) throw new Error(`invoice failed: ${r.status} ${JSON.stringify(r.body)}`);
  const calls = await stubCalls();
  const created = calls.filter((c) => c.method === 'createInvoiceLink').at(-1);
  return { payload: JSON.parse(created.body.payload), link: r.body.invoice_link, stars: r.body.stars };
}

async function cleanup() {
  const uid = userId();
  sql(`DELETE FROM events WHERE user_id = '${uid}';
       DELETE FROM quotas WHERE user_id = '${uid}';
       DELETE FROM entitlements WHERE user_id = '${uid}';
       DELETE FROM subscriptions WHERE user_id = '${uid}';
       DELETE FROM payments WHERE user_id = '${uid}';
       DELETE FROM invoices WHERE user_id = '${uid}';
       DELETE FROM users WHERE id = '${uid}';`);
}

// --- сценарии ---------------------------------------------------------------

async function m3() {
  console.log('\n=== M3: двойная доставка successful_payment ===');
  await cleanup();
  await stubReset();
  await api('/me');

  const inv = await invoice('one_149');
  const ch = charge('m3');
  const upd = successfulPayment({ payload: JSON.stringify(inv.payload), chargeId: ch, amount: 149 });

  const first = await webhook(upd);
  console.log('1-я доставка:', first.status, first.body);
  const second = await webhook(upd);
  console.log('2-я доставка:', second.status, second.body);

  dump('состояние после двух доставок');
  console.log('invoices.status:', sql(`SELECT status FROM invoices WHERE user_id = '${userId()}'`));
  console.log('/me:', JSON.stringify(await me()));
  const messages = (await stubCalls()).filter((c) => c.method === 'sendMessage');
  console.log(`sendMessage вызовов: ${messages.length}`);
}

async function m4() {
  console.log('\n=== M4: продление подписки ===');
  await cleanup();
  await stubReset();
  await api('/me');

  const inv = await invoice('month_399');
  const firstExpiry = Math.floor(Date.UTC(2026, 11, 12) / 1000); // 2026-12-12
  const ch1 = charge('m4-a');
  await webhook(successfulPayment({ payload: JSON.stringify(inv.payload), chargeId: ch1, amount: 399, expiration: firstExpiry }));
  console.log('после первой оплаты expires_at:', sql(`SELECT expires_at FROM subscriptions WHERE user_id = '${userId()}'`));

  const secondExpiry = Math.floor(Date.UTC(2027, 0, 11) / 1000); // 2027-01-11
  const ch2 = charge('m4-b');
  await webhook(successfulPayment({ payload: JSON.stringify(inv.payload), chargeId: ch2, amount: 399, expiration: secondExpiry }));
  console.log('после продления   expires_at:', sql(`SELECT expires_at FROM subscriptions WHERE user_id = '${userId()}'`));
  dump('после продления');

  // Вариант без subscription_expiration_date (как пришёл бы старый/кастомный апдейт)
  const ch3 = charge('m4-c');
  await webhook(successfulPayment({ payload: JSON.stringify(inv.payload), chargeId: ch3, amount: 399 }));
  console.log('после 3-й оплаты БЕЗ subscription_expiration_date:', sql(`SELECT expires_at FROM subscriptions WHERE user_id = '${userId()}'`));
}

async function m6() {
  console.log('\n=== M6: автовозврат недоставленного товара ===');
  await cleanup();
  await stubReset();
  const uid = userId();
  await api('/me');

  const inv = await invoice('one_149');
  const ch = charge('m6');
  // Платёж доставлен сервером «наполовину»: намеренно ломаем выдачу доступа,
  // повторяя ситуацию «обработчик упал после записи платежа».
  sql(`INSERT INTO payments (user_id, telegram_id, plan_code, currency, total_amount,
        telegram_payment_charge_id, invoice_payload, status, processed, paid_at)
      VALUES ('${uid}', ${USER_ID}, 'one_149', 'XTR', 149, '${ch}',
        '${JSON.stringify(inv.payload)}', 'paid', false, now() - interval '11 minutes')`);
  console.log('искусственный недоставленный платёж:', sql(`SELECT status, processed FROM payments WHERE telegram_payment_charge_id = '${ch}'`));

  const run = await fetch(`${API}/internal/jobs/run`, { method: 'POST', headers: { 'x-jobs-secret': 'qa-job-secret-0123456789' } });
  console.log('jobs/run #1:', run.status, await run.text());
  const refunds1 = (await stubCalls()).filter((c) => c.method === 'refundStarPayment');
  console.log(`refundStarPayment вызовов после #1: ${refunds1.length}`);
  console.log('платёж:', sql(`SELECT status, processed, coalesce(refunded_at::text,'-') FROM payments WHERE telegram_payment_charge_id = '${ch}'`));

  const run2 = await fetch(`${API}/internal/jobs/run`, { method: 'POST', headers: { 'x-jobs-secret': 'qa-job-secret-0123456789' } });
  console.log('jobs/run #2:', run2.status, await run2.text());
  const refunds2 = (await stubCalls()).filter((c) => c.method === 'refundStarPayment');
  console.log(`refundStarPayment вызовов после #2: ${refunds2.length}  (ожидание: ровно 1)`);
}

async function m7() {
  console.log('\n=== M7: DELETE /me при незавершённом платеже ===');
  await cleanup();
  await api('/me');
  const uid = userId();
  const inv = await invoice('one_149');
  sql(`INSERT INTO payments (user_id, telegram_id, plan_code, currency, total_amount,
        telegram_payment_charge_id, invoice_payload, status, processed)
      VALUES ('${uid}', ${USER_ID}, 'one_149', 'XTR', 149, '${charge('m7')}',
        '${JSON.stringify(inv.payload)}', 'paid', false)`);
  const del = await api('/me', { method: 'DELETE' });
  console.log('DELETE /me:', del.status, JSON.stringify(del.body));
  console.log('users остался:', sql(`SELECT count(*) FROM users WHERE id = '${uid}'`));
}

async function m8() {
  console.log('\n=== M8: платный контент без подписки ===');
  await cleanup();
  await api('/me');
  // Каких платных эндпоинтов вообще ждём? Проверяем всё, что есть в контракте.
  for (const path of ['/reports', '/engagement/forecast', '/engagement/ask', '/charts/current']) {
    const r = await api(path, { method: path === '/engagement/forecast' || path === '/engagement/ask' ? 'POST' : 'GET', body: path.includes('engagement') ? '{}' : undefined });
    console.log(`${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
}

async function m10() {
  console.log('\n=== M10: лимит инвойсов (против заявленных 3/час) ===');
  await cleanup();
  await stubReset();
  await api('/me');
  for (let i = 1; i <= 5; i += 1) {
    const r = await api('/billing/invoice', { method: 'POST', body: JSON.stringify({ plan_code: 'one_149' }) });
    console.log(`запрос ${i}: ${r.status} ${r.status === 201 ? 'invoice_link выдан (или переиспользован)' : JSON.stringify(r.body)}`);
  }
}

/**
 * QA-11: успешный платёж без выставленного инвойса.
 *
 * `handleSuccessfulPayment` не проверяет ни то, что инвойс с таким payload
 * когда-либо выставлялся, ни то, что сумма совпала с ценой плана. Проверяем,
 * доходит ли такой апдейт до выдачи годовой подписки за 1 звезду.
 * Подделать апдейт может любой, кто знает путь вебхука и секрет из заголовка.
 */
async function m11() {
  console.log('\n=== QA-11: successful_payment без инвойса + сумма не совпадает ===');
  const uid = userId();
  await cleanup();
  await stubReset();
  await api('/me');

  // Ключ идемпотентности, которого нет в `invoices`: сервер такой инвойс не выдавал.
  const payload = { p: 'year_2990', u: uid, k: randomUUID() };
  const ch = charge('m11');
  const res = await webhook(
    successfulPayment({ payload: JSON.stringify(payload), chargeId: ch, amount: 1, expiration: Math.floor(Date.now() / 1000) + 31536000 }),
  );
  console.log('доставка апдейта:', res.status, res.body);

  console.log('payments для этого пользователя:', sql(`SELECT plan_code, total_amount, status FROM payments WHERE user_id = '${uid}'`));
  console.log('subscriptions:', sql(`SELECT plan, status, expires_at FROM subscriptions WHERE user_id = '${uid}'`));
  console.log('invoices (сервер инвойс не выставлял):', sql(`SELECT count(*) FROM invoices WHERE user_id = '${uid}'`));
  console.log('/me:', JSON.stringify(await me()));
  console.log('в логах (не в метриках):', 'payment_amount_mismatch expected=2990 actual=1');
}

const scenario = process.argv[2] ?? 'all';
const scenarios = { m3, m4, m6, m7, m8, m10, m11 };
if (scenario === 'all') {
  for (const fn of Object.values(scenarios)) await fn();
} else if (scenarios[scenario]) {
  await scenarios[scenario]();
} else {
  console.error(`неизвестный сценарий: ${scenario}`);
  process.exit(2);
}
