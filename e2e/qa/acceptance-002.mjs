#!/usr/bin/env node
/**
 * QA-002: регресс блокеров 001 + обход выдачи прав + платёж после удаления данных.
 *
 * Стенд: живой API + реальный Postgres + стаб Bot API (e2e/qa/bot-stub.mjs).
 * Ничего не «оценивает»: печатает факты (ответы, строки БД, вызовы Bot API),
 * чтобы в отчёте были артефакты.
 *
 * Запуск: node e2e/qa/acceptance-002.mjs <сценарий|all>
 *   сценарии: m11 m11b m11c dp1 dp2 vectors delete-then-pay contract
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.QA_API ?? 'http://127.0.0.1:8080/api/v1';
const STUB = process.env.QA_STUB ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.QA_BOT_TOKEN ?? '123456789:QA-TEST-TOKEN-not-real';
// Ключ псевдонимизации в репозитории не хранится: без него `user_id` не совпадёт
// с серверным, и проверки `DELETE /me` дадут ложный результат (см. qa-002-howto.md §1).
const PEPPER = process.env.QA_PEPPER ?? '';
if (PEPPER === '') {
  console.error('нужен QA_PEPPER — PSEUDONYM_PEPPER стенда (см. docs/qa/reports/qa-002-howto.md)');
  process.exit(2);
}
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? 'qa2-webhook-secret-0123456789';
const JOBS_SECRET = process.env.QA_JOBS_SECRET ?? 'qa2-job-secret-0123456789';
const PSQL = process.env.QA_PSQL;
const DB = process.env.QA_DB ?? 'astro_soul';
/** Актуальная редакция согласия стенда: устаревшая даёт 422 на `POST /charts`. */
const CONSENT_VERSION = process.env.QA_CONSENT_VERSION ?? '2026-11-10';
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Приёмка идёт по конкретному дереву: если код проверяется из отдельного worktree
// (например, из PR), `QA_REPO` указывает на него — иначе `support-refund.ts`
// поднимет контекст старого дерева против новой БД.
const REPO = process.env.QA_REPO ?? ROOT;

function sql(query) {
  return execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB, '-tAF|', '-c', query], {
    encoding: 'utf8',
  }).trim();
}

/** Детерминированный UUID пользователя — как apps/api/src/modules/users/pseudonym.ts. */
function userIdOf(telegramId) {
  const d = Buffer.from(createHmac('sha256', PEPPER).update(`telegram:${telegramId}`).digest().subarray(0, 16));
  d[6] = ((d[6] ?? 0) & 0x0f) | 0x50;
  d[8] = ((d[8] ?? 0) & 0x3f) | 0x80;
  const h = d.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

function signInitData({ telegramId, authDate = Math.floor(Date.now() / 1000) }) {
  const fields = {
    query_id: `AAQ${telegramId}${authDate}`,
    user: JSON.stringify({
      id: telegramId,
      first_name: 'Тест',
      last_name: 'Тестов',
      username: 'qa_fictional',
      language_code: 'ru',
    }),
    auth_date: String(authDate),
  };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const USER = 6050935513; // ADMIN_TG_ID владельца — вымышленный тестовый
const USER_B = 6050935514;
const INIT = signInitData({ telegramId: USER });
const INIT_B = signInitData({ telegramId: USER_B });

async function api(path, options = {}, init = INIT) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'x-telegram-init-data': init, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

const stubCalls = async () => (await fetch(`${STUB}/__calls`)).json();
const stubReset = () => fetch(`${STUB}/__calls/reset`, { method: 'POST' });

async function webhook(update) {
  const res = await fetch(`${API}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
  return { status: res.status, body: await res.text() };
}

const charge = (tag) => `qa2-${tag}-${randomUUID()}`;

function paid({ payload, chargeId, amount, expiration, chatId = USER, field = 'message' }) {
  const payment = {
    currency: 'XTR',
    total_amount: amount,
    invoice_payload: payload,
    telegram_payment_charge_id: chargeId,
    provider_payment_charge_id: `prov-${chargeId}`,
  };
  if (expiration !== undefined) payment.subscription_expiration_date = expiration;
  const message = { chat: { id: chatId }, from: { id: chatId }, successful_payment: payment };
  return field === 'edited_message'
    ? { update_id: 1, edited_message: message }
    : { update_id: 1, message };
}

const payloadOf = (plan, uid) => JSON.stringify({ p: plan, u: uid, k: randomUUID() });

function wipe(telegramId = USER) {
  const uid = userIdOf(telegramId);
  sql(`DELETE FROM events WHERE user_id='${uid}';
       DELETE FROM quotas WHERE user_id='${uid}';
       DELETE FROM entitlements WHERE user_id='${uid}';
       DELETE FROM subscriptions WHERE user_id='${uid}';
       DELETE FROM payments WHERE user_id='${uid}';
       DELETE FROM invoices WHERE user_id='${uid}';
       DELETE FROM users WHERE id='${uid}';`);
}

/**
 * Карта пользователя для инвойса. С 1.5.2 `one_149` без `chart_id` не продаётся
 * (422 `field_errors[{field:"chart_id"}]`), поэтому разовому товару карта нужна.
 */
async function chartFor(init = INIT) {
  const current = await api('/charts/current', {}, init);
  if (typeof current.body?.chart?.chart_id === 'string') return current.body.chart.chart_id;
  const created = await api('/charts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      birth_date: '1994-05-17',
      birth_time: '14:20',
      time_precision: 'exact',
      birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
      consent: { version: CONSENT_VERSION, accepted: true },
    }),
  }, init);
  return created.body?.chart?.chart_id ?? null;
}

async function invoiceFor(planCode, init = INIT, telegramId = USER) {
  // Разовым товарам нужна карта: без неё сервер отказывает по контракту 1.5.2.
  const chartId = planCode.startsWith('one_') || planCode.startsWith('compat_') || planCode.startsWith('solar_')
    ? await chartFor(init)
    : null;
  const body = chartId === null ? { plan_code: planCode } : { plan_code: planCode, chart_id: chartId };
  const r = await api('/billing/invoice', { method: 'POST', body: JSON.stringify(body) }, init);
  // payload берём из того, что сервер отправил в Bot API
  const created = (await stubCalls()).filter((c) => c.method === 'createInvoiceLink').at(-1);
  let payload = null;
  if (created?.body?.payload) {
    try {
      payload = JSON.parse(created.body.payload);
    } catch {
      payload = null;
    }
  }
  return { status: r.status, body: r.body, payload, uid: userIdOf(telegramId) };
}

/** Переменные стенда из `QA_ENV_FILE` (по умолчанию `/tmp/qa2.env`): нужны, чтобы поднять контекст Nest. */
function envFile() {
  const path = process.env.QA_ENV_FILE ?? '/tmp/qa2.env';
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

/**
 * Возврат «через поддержку»: эндпоинта нет, поддержка вызывает сервис из кода
 * (`e2e/qa/support-refund.ts`). Запускаем отдельным процессом в контексте Nest.
 */
async function supportRefund(chargeId) {
  try {
    const out = execFileSync('pnpm', ['exec', 'tsx', '../../e2e/qa/support-refund.ts', chargeId], {
      cwd: `${REPO}/apps/api`,
      encoding: 'utf8',
      // Сервису нужны те же переменные, что у API: харнесс берёт их из файла стенда.
      env: { ...process.env, ...envFile() },
    });
    return out.trim().split('\n').join(' | ');
  } catch (error) {
    return `ошибка запуска: ${String(error.stdout ?? error.message).slice(0, 300)}`;
  }
}

const show = (obj) => JSON.stringify(obj);

// --- Задача 1: регресс -------------------------------------------------------

async function m11() {
  console.log('\n=== M11: платёж без инвойса, сумма 1 вместо 2990 ===');
  wipe();
  await stubReset();
  await api('/me');

  const uid = userIdOf(USER);
  const payload = { p: 'year_2990', u: uid, k: randomUUID() };
  const ch = charge('m11');
  const r = await webhook(paid({ payload: JSON.stringify(payload), chargeId: ch, amount: 1, expiration: Math.floor(Date.now() / 1000) + 31_536_000 }));
  console.log('вебхук:', show(r));
  console.log('payments   :', sql(`SELECT plan_code,total_amount,status,processed FROM payments WHERE user_id='${uid}'`) || '(пусто)');
  console.log('invoices   :', sql(`SELECT count(*) FROM invoices WHERE user_id='${uid}'`));
  console.log('subscriptions:', sql(`SELECT plan,status,expires_at FROM subscriptions WHERE user_id='${uid}'`) || '(пусто)');
  const m = await api('/me');
  console.log('/me        : plan=', m.body.subscription?.plan, 'is_active=', m.body.subscription?.is_active,
              'full_forecast=', m.body.entitlements?.full_forecast, 'solar=', m.body.entitlements?.solar_included);
  console.log('событие payment_rejected:', sql(`SELECT count(*) FROM events WHERE name='payment_rejected'`) );
  const metrics = await api('/admin/metrics');
  console.log('metrics.payments_rejected_30d:', metrics.body.payments_rejected_30d ?? '(поля нет)');
  console.log('metrics keys:', Object.keys(metrics.body).join(','));
}

async function m11b() {
  console.log('\n=== M11b: платёж по чужому инвойсу (инвойс A, payload.u = B) ===');
  wipe();
  wipe(USER_B);
  await stubReset();
  await api('/me');
  await api('/me', {}, INIT_B);

  const inv = await invoiceFor('one_149', INIT, USER); // инвойс выписан пользователю A
  if (inv.payload === null) {
    // С 1.5.2 `one_149` требует `chart_id` — без карты инвойса нет, вектор вырождается.
    console.log('инвойс не создан (', inv.status, show(inv.body), ') — проверить требование chart_id');
    return;
  }
  const uidB = userIdOf(USER_B);
  // payload подменён на пользователя B с ключом от инвойса A
  const forged = JSON.stringify({ p: 'one_149', u: uidB, k: inv.payload.k });
  const r = await webhook(paid({ payload: forged, chargeId: charge('m11b'), amount: 149, chatId: USER_B }));
  console.log('инвойс A: u=', inv.payload.u, 'k=', inv.payload.k);
  console.log('подставлено: u=', uidB, '(B)');
  console.log('вебхук:', show(r));
  console.log('A: invoices=', sql(`SELECT count(*) FROM invoices WHERE user_id='${inv.uid}'`),
              'payments=', sql(`SELECT count(*) FROM payments WHERE user_id='${inv.uid}'`));
  console.log('B: payments=', sql(`SELECT plan_code,total_amount,status FROM payments WHERE user_id='${uidB}'`) || '(пусто)',
              '| entitlements=', sql(`SELECT kind,status FROM entitlements WHERE user_id='${uidB}'`) || '(пусто)');
  const mB = await api('/me', {}, INIT_B);
  console.log('B /me: full_report=', mB.body.entitlements?.full_report);
}

async function m11c() {
  console.log('\n=== M11c: total_amount БОЛЬШЕ цены плана ===');
  wipe();
  await stubReset();
  await api('/me');
  const uid = userIdOf(USER);
  const payload = { p: 'one_149', u: uid, k: randomUUID() };
  const r = await webhook(paid({ payload: JSON.stringify(payload), chargeId: charge('m11c'), amount: 4999 }));
  console.log('вебхук:', show(r));
  console.log('payments:', sql(`SELECT plan_code,total_amount,status FROM payments WHERE user_id='${uid}'`) || '(пусто)');
  const m = await api('/me');
  console.log('/me full_report=', m.body.entitlements?.full_report);
}

async function dp1() {
  console.log('\n=== DP1: DELETE /me при зависшем платеже (processed=false) ===');
  wipe();
  await api('/me');
  const uid = userIdOf(USER);
  const ch = charge('dp1');
  sql(`INSERT INTO payments (user_id,telegram_id,plan_code,currency,total_amount,telegram_payment_charge_id,invoice_payload,status,processed,paid_at)
       VALUES ('${uid}',${USER},'one_149','XTR',149,'${ch}','{}','paid',false, now() - interval '3 days')`);
  console.log('зависший платёж 3 дня:', sql(`SELECT status,processed FROM payments WHERE telegram_payment_charge_id='${ch}'`));
  // Счётчик вызовов считаем с нуля: иначе в него попадут возвраты прошлых сценариев.
  await stubReset();
  const del = await api('/me', { method: 'DELETE' });
  console.log('DELETE /me:', del.status, show(del.body));
  console.log('users остался:', sql(`SELECT count(*) FROM users WHERE id='${uid}'`));
  const calls = await stubCalls();
  console.log('refundStarPayment вызван:', calls.filter((c) => c.method === 'refundStarPayment').length);
}

async function dp2() {
  console.log('\n=== DP2: после pending_payments_resolve DELETE /me → ждём 204 ===');
  const jobs = await fetch(`${API}/internal/jobs/run`, { method: 'POST', headers: { 'x-jobs-secret': JOBS_SECRET } });
  const body = await jobs.text();
  console.log('POST /internal/jobs/run:', jobs.status, body);
  console.log('поля джоба:', Object.keys(JSON.parse(body || '{}')).join(','));
  console.log('есть ли pending_payments_resolve в коде:', sql(`select 1`) && 'см. apps/api/src/modules/ops/jobs.service.ts');
  const uid = userIdOf(USER);
  console.log('платежи пользователя:', sql(`SELECT status,processed FROM payments WHERE user_id='${uid}'`) || '(пусто)');
  const del = await api('/me', { method: 'DELETE' });
  console.log('DELETE /me:', del.status, show(del.body));
}

// --- Задача 2.1: обход выдачи прав ------------------------------------------

async function vectors() {
  console.log('\n=== 2.1 Обход выдачи прав: семь векторов ===');
  const uid = userIdOf(USER);

  // 1. повторная доставка N раз
  wipe();
  await stubReset();
  await api('/me');
  const inv1 = await invoiceFor('one_149');
  const upd1 = paid({ payload: JSON.stringify(inv1.payload), chargeId: charge('v1'), amount: 149 });
  for (let i = 0; i < 5; i += 1) await webhook(upd1);
  console.log('V1 повтор ×5: payments=', sql(`SELECT count(*) FROM payments WHERE user_id='${uid}'`),
              'entitlements=', sql(`SELECT count(*) FROM entitlements WHERE user_id='${uid}'`),
              'sendMessage=', (await stubCalls()).filter((c) => c.method === 'sendMessage').length);

  // 2. edited_message
  wipe();
  await stubReset();
  await api('/me');
  const inv2 = await invoiceFor('one_149');
  const r2 = await webhook(paid({ payload: JSON.stringify(inv2.payload), chargeId: charge('v2'), amount: 149, field: 'edited_message' }));
  console.log('V2 edited_message: вебхук=', r2.status,
              'payments=', sql(`SELECT count(*) FROM payments WHERE user_id='${uid}'`),
              'entitlements=', sql(`SELECT count(*) FROM entitlements WHERE user_id='${uid}'`));

  // 3. expiration в прошлом
  wipe();
  await stubReset();
  await api('/me');
  const inv3 = await invoiceFor('month_399');
  await webhook(paid({ payload: JSON.stringify(inv3.payload), chargeId: charge('v3'), amount: 399,
                       expiration: Math.floor(Date.UTC(2020, 0, 1) / 1000) }));
  console.log('V3 expiration в 2020: subscriptions=', sql(`SELECT plan,status,expires_at FROM subscriptions WHERE user_id='${uid}'`) || '(пусто)');
  const m3v = await api('/me');
  console.log('   /me: is_active=', m3v.body.subscription?.is_active, 'full_forecast=', m3v.body.entitlements?.full_forecast);

  // 4. продление без инвойса
  wipe();
  await stubReset();
  await api('/me');
  await webhook(paid({ payload: payloadOf('month_399', uid), chargeId: charge('v4a'), amount: 399 }));
  const before = sql(`SELECT expires_at FROM subscriptions WHERE user_id='${uid}'`);
  await webhook(paid({ payload: payloadOf('month_399', uid), chargeId: charge('v4b'), amount: 399 }));
  console.log('V4 два платежа без инвойсов: было', before, '→ стало', sql(`SELECT expires_at FROM subscriptions WHERE user_id='${uid}'`));

  // 5. возврат по уже учтённому платежу
  wipe();
  await stubReset();
  await api('/me');
  const inv5 = await invoiceFor('one_149');
  const ch5 = charge('v5');
  await webhook(paid({ payload: JSON.stringify(inv5.payload), chargeId: ch5, amount: 149 }));
  const beforeAccess = (await api('/me')).body.entitlements?.full_report;
  // Telegram не присылает вебхук о возврате: звезда возвращается либо инициативой
  // сервера (PaymentsService.refund), либо руками поддержки. Проверяем оба пути.
  const empty = await webhook({ update_id: 9, message: { chat: { id: USER }, from: { id: USER } } });
  console.log('V5 доступ до возврата:', beforeAccess, '| вебхук апдейта без платежа:', empty.status);
  console.log('   доступ после «пустого» апдейта:', (await api('/me')).body.entitlements?.full_report);

  // Путь поддержки: тот же сервисный вызов, что делает скрипт возврата.
  console.log('   refund() через support-refund.ts:', await supportRefund(ch5));
  console.log('   платежи после возврата:', sql(`SELECT status FROM payments WHERE telegram_payment_charge_id='${ch5}'`) || '(нет)');
  console.log('   доступ после возврата:', (await api('/me')).body.entitlements?.full_report,
              '(ждём: отзыв доступа, т.к. refundStarPayment вернул деньги)');
  const callsAfter = await stubCalls();
  console.log('   refundStarPayment вызван:', callsAfter.filter((c) => c.method === 'refundStarPayment').length,
              '| событие refund_issued в БД:',
              sql(`SELECT count(*) FROM events WHERE name='refund_issued' AND user_id='${userIdOf(USER)}'`));

  // 6. pre_checkout_query с ценой из клиента
  wipe();
  await stubReset();
  await api('/me');
  const inv6 = await invoiceFor('year_2990');
  const pcq = await webhook({ update_id: 10, pre_checkout_query: { id: 'qa2-pcq', from: { id: USER }, currency: 'XTR',
    total_amount: 1, invoice_payload: JSON.stringify(inv6.payload) } });
  const answer = (await stubCalls()).filter((c) => c.method === 'answerPreCheckoutQuery').at(-1);
  console.log('V6 pre_checkout с total_amount=1 при инвойсе 2990: ответ бота=', show(answer?.body));

  // 7. два пользователя, один idem_key
  wipe();
  wipe(USER_B);
  await stubReset();
  await api('/me');
  await api('/me', {}, INIT_B);
  const invA = await invoiceFor('one_149', INIT, USER);
  if (invA.payload === null) {
    console.log('V7: инвойс не создан (', invA.status, ') — без карты `one_149` не продаётся, вектор вырождается');
    return;
  }
  const uidB = userIdOf(USER_B);
  const r7 = await webhook(paid({ payload: JSON.stringify({ p: 'one_149', u: uidB, k: invA.payload.k }), chargeId: charge('v7'), amount: 149, chatId: USER_B }));
  console.log('V7 один idem_key, два пользователя: вебхук=', r7.status,
              '| A payments=', sql(`SELECT count(*) FROM payments WHERE user_id='${uidA()}'`),
              '| B payments=', sql(`SELECT count(*) FROM payments WHERE user_id='${uidB}'`),
              '| B entitlements=', sql(`SELECT kind,status FROM entitlements WHERE user_id='${uidB}'`) || '(пусто)');
}

const uidA = () => userIdOf(USER);

// --- Задача 2.2: платёж после удаления данных -------------------------------

async function deleteThenPay() {
  console.log('\n=== 2.2 Платёж после DELETE /me ===');

  // Порядок A: удаление ДО pre_checkout_query
  console.log('\n-- порядок A: инвойс → DELETE /me → pre_checkout_query → successful_payment');
  wipe();
  await stubReset();
  await api('/me');
  const uid = userIdOf(USER);
  const inv = await invoiceFor('one_149');
  console.log('инвойс выставлен:', inv.status, 'payload.u=', inv.payload?.u);
  const del = await api('/me', { method: 'DELETE' });
  console.log('DELETE /me:', del.status);
  console.log('после удаления invoices:', sql(`SELECT count(*), string_agg(status::text,',') FROM invoices WHERE user_id='${uid}'`));
  const pcq = await webhook({ update_id: 11, pre_checkout_query: { id: 'qa2-a', from: { id: USER }, currency: 'XTR',
    total_amount: 149, invoice_payload: JSON.stringify(inv.payload) } });
  const answer = (await stubCalls()).filter((c) => c.method === 'answerPreCheckoutQuery').at(-1);
  console.log('pre_checkout_query после удаления: вебхук=', pcq.status, '| ответ бота=', show(answer?.body));
  const paidA = await webhook(paid({ payload: JSON.stringify(inv.payload), chargeId: charge('del-a'), amount: 149 }));
  console.log('successful_payment после удаления: вебхук=', paidA.status);
  console.log('payments :', sql(`SELECT plan_code,status,processed FROM payments WHERE user_id='${uid}'`) || '(пусто)');
  console.log('entitlements:', sql(`SELECT kind,status FROM entitlements WHERE user_id='${uid}'`) || '(пусто)');
  console.log('invoices :', sql(`SELECT status FROM invoices WHERE user_id='${uid}'`));
  console.log('refundStarPayment вызовов:', (await stubCalls()).filter((c) => c.method === 'refundStarPayment').length);
  console.log('события:', sql(`SELECT name FROM events WHERE user_id='${uid}' ORDER BY created_at`) || '(пусто)');
  // Важно: пользователя до этого запроса нет — его создаёт сам `GET /me`,
  // а не платёж. Поэтому `is_new=true` здесь ожидаем, а `full_report` нет.
  console.log('users до /me:', sql(`SELECT count(*) FROM users WHERE id='${uid}'`));
  const m = await api('/me');
  console.log('/me full_report=', m.body.entitlements?.full_report, 'is_new=', m.body.is_new);

  // Порядок B: удаление МЕЖДУ pre_checkout_query и successful_payment
  console.log('\n-- порядок B: инвойс → pre_checkout_query → DELETE /me → successful_payment');
  wipe();
  await stubReset();
  await api('/me');
  const inv2 = await invoiceFor('one_149');
  await webhook({ update_id: 12, pre_checkout_query: { id: 'qa2-b', from: { id: USER }, currency: 'XTR',
    total_amount: 149, invoice_payload: JSON.stringify(inv2.payload) } });
  const del2 = await api('/me', { method: 'DELETE' });
  console.log('DELETE /me между событиями:', del2.status);
  const paidB = await webhook(paid({ payload: JSON.stringify(inv2.payload), chargeId: charge('del-b'), amount: 149 }));
  console.log('successful_payment: вебхук=', paidB.status);
  console.log('payments :', sql(`SELECT plan_code,status,processed FROM payments WHERE user_id='${uid}'`) || '(пусто)');
  console.log('entitlements:', sql(`SELECT kind,status FROM entitlements WHERE user_id='${uid}'`) || '(пусто)');
  console.log('refundStarPayment вызовов:', (await stubCalls()).filter((c) => c.method === 'refundStarPayment').length);
  const ev = sql(`SELECT name FROM events WHERE user_id='${uid}' ORDER BY created_at`);
  console.log('события:', ev || '(пусто)');
}

// --- контрактные проверки ---------------------------------------------------

async function contract() {
  console.log('\n=== Контракт 1.5.1: occurred_at, серверные события, Me.required ===');
  const now = new Date().toISOString();
  const old = await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ name: 'app_open', at: now }] }) });
  console.log('старое поле `at`       :', old.status, show(old.body).slice(0, 160));
  const neu = await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ name: 'app_open', occurred_at: now }] }) });
  console.log('новое поле `occurred_at`:', neu.status, show(neu.body).slice(0, 160));

  for (const name of ['payment_rejected', 'refund_issued', 'subscription_expired']) {
    const r = await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ name, occurred_at: now }] }) });
    console.log(`серверное событие «${name}» от клиента:`, r.status, show(r.body).slice(0, 120));
  }

  for (const name of ['onboarding_start', 'mini_reading_view', 'validation_failed_client', 'wheel_shared', 'data_deleted']) {
    const r = await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ name, occurred_at: now }] }) });
    console.log(`имя из контракта «${name}»:`, r.status, show(r.body).slice(0, 120));
  }

  const m = await api('/me');
  const required = ['user_id', 'is_new', 'subscription', 'quotas', 'has_profile', 'chart_id', 'entitlements', 'latest_report_id'];
  const miss = required.filter((k) => !(k in m.body));
  console.log('/me обязательные из 1.5.1: отсутствуют →', miss.length ? miss.join(',') : '(нет)');

  // QA-12b: заголовок обязан быть даже на ошибке разбора тела.
  for (const [label, path, body] of [
    ['битый JSON /charts', '/charts', '{oops'],
    ['битый JSON /events', '/events', '{oops'],
  ]) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': INIT, 'content-type': 'application/json', 'x-request-id': 'qa2-fixed-id' },
      body,
    });
    const hdrs = Object.fromEntries(res.headers);
    console.log(`${label}: статус=`, res.status, 'X-Request-Id=', hdrs['x-request-id'] ?? '(нет)',
                'тело=', (await res.text()).slice(0, 140));
  }

  // Клиентское время: сервер принимает `at` и сохраняет его как `occurred_at`.
  // (Сутки и 5 минут — границы контракта; берём час назад, чтобы не попасть в отказ.)
  const clientTime = new Date(Date.now() - 3600_000).toISOString();
  const ok = await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ name: 'screen_view', at: clientTime, props: { step: 'qa-time' } }] }) });
  const stored = sql(`SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM events WHERE props->>'step'='qa-time' ORDER BY created_at DESC LIMIT 1`);
  console.log('событие с временем клиента', clientTime, '→', ok.status, '| в БД occurred_at =', stored,
              stored === clientTime ? '(время клиента сохранено)' : '(время клиента потеряно)');
}

/**
 * R-1 из 001: три оплаты подписки подряд без `subscription_expiration_date`.
 * Ожидание: каждый платёж добавляет период. Факт: `expires_at` не двигается.
 */
async function r1() {
  console.log('\n=== R-1: три оплаты month_399 подряд без expiration ===');
  wipe();
  await stubReset();
  await api('/me');
  const uid = userIdOf(USER);
  console.log('до оплат:', sql(`SELECT plan,status,expires_at FROM subscriptions WHERE user_id='${uid}'`) || '(пусто)');
  for (let i = 1; i <= 3; i += 1) {
    const inv = await invoiceFor('month_399');
    await webhook(paid({ payload: JSON.stringify(inv.payload), chargeId: charge(`r1-${i}`), amount: 399 }));
    console.log(`после оплаты ${i}:`,
      sql(`SELECT plan,status,expires_at FROM subscriptions WHERE user_id='${uid}'`) || '(пусто)',
      '| платежей:', sql(`SELECT count(*) FROM payments WHERE user_id='${uid}' AND status='processed'`));
  }
  console.log('ожидание: expires_at сдвинут на 3 периода вперёд от первой оплаты');
}

/**
 * CR1 из 001: крон и защита джоба от параллельного запуска.
 * Ожидание: два одновременных прогона не делают одну работу дважды
 * (advisory lock или идемпотентность). Факт: каждый прогон возвращает свой платёж.
 */
async function cr1() {
  console.log('\n=== CR1: параллельные прогоны джоба возвратов ===');
  wipe();
  await stubReset();
  await api('/me');
  const uid = userIdOf(USER);
  for (const n of [1, 2]) {
    sql(`INSERT INTO payments (user_id,telegram_id,plan_code,currency,total_amount,telegram_payment_charge_id,invoice_payload,status,processed,paid_at)
         VALUES ('${uid}',${USER},'one_149','XTR',149,'qa2-cr1-${n}','{}','paid',false, now() - interval '3 days')`);
  }
  console.log('зависших платежей до прогона:', sql(`SELECT count(*) FROM payments WHERE user_id='${uid}' AND processed=false AND status='paid'`));

  const runJob = () => fetch(`${API}/internal/jobs/run`, {
    method: 'POST',
    headers: { 'x-jobs-secret': JOBS_SECRET, 'content-type': 'application/json' },
    body: '{}',
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

  const results = await Promise.all([runJob(), runJob(), runJob()]);
  for (const [i, r] of results.entries()) console.log(`прогон ${i + 1}:`, r.status, r.body);

  // В 1.5.2 джоб не возвращает деньги по таймауту, а разрешает платежи тем же
  // путём, что вебхук. Значит проверяем идемпотентность: каждый платёж должен
  // быть обработан ровно один раз, а сумма счётчиков — не больше числа платежей.
  const calls = await stubCalls();
  const refunds = calls.filter((c) => c.method === 'refundStarPayment');
  console.log('refundStarPayment вызовов:', refunds.length, '(ожидание: 0 — возврата по таймауту больше нет)');
  console.log('уникальных charge_id среди возвратов:', new Set(refunds.map((c) => c.body?.telegram_payment_charge_id)).size);
  console.log('итог в БД:', sql(`SELECT status,processed,count(*) FROM payments WHERE user_id='${uid}' GROUP BY 1,2`));
  const reasons = sql(`SELECT coalesce(reject_reason,'(нет)'),count(*) FROM payments WHERE user_id='${uid}' GROUP BY 1`);
  console.log('reject_reason:', reasons || '(пусто)');
}

/**
 * Задача 6 задания: что отдаёт разбор про `unknown` и что уходит в геопоиск.
 *
 * Разбора (`POST /reports`) в этой сборке нет, поэтому проверяем то, что есть и
 * из чего разбор будет собран: `mini_reading` и колесо на живом запросе без
 * времени рождения, плюс что уходит наружу при поиске места.
 */
async function report() {
  console.log('\n=== report: unknown без домов/ASC + ПДн в геопоиске ===');

  const unknownInit = signInitData({ telegramId: 6050935520 });
  const res = await api('/charts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      birth_date: '1991-02-03',
      birth_time: null,
      time_precision: 'unknown',
      birth_place: { name: 'Казань', country: 'RU', lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' },
      consent: { version: '2026-11-10', accepted: true },
    }),
  }, unknownInit);
  console.log('POST /charts (time_precision=unknown):', res.status);
  const chart = res.body?.chart ?? {};
  console.log('  houses =', JSON.stringify(chart.houses ?? null), '| asc =', JSON.stringify(chart.asc ?? null));
  console.log('  mc =', JSON.stringify(chart.mc ?? null), '| warnings =', JSON.stringify(res.body?.warnings ?? null));
  console.log('  mini_reading.asc =', JSON.stringify(res.body?.mini_reading?.asc ?? null));

  if (res.body?.wheel_url) {
    const origin = API.replace(/\/api\/v1$/, '');
    const svg = await (await fetch(origin + res.body.wheel_url)).text();
    const ascMarks = (svg.match(/>ASC</g) ?? []).length;
    const cusps = (svg.match(/class="cusp"/g) ?? []).length;
    const note = (svg.match(/Дома и Асцендент[^<]*/) ?? [''])[0];
    console.log('  wheel.svg: ASC =', ascMarks, '| домов =', cusps, '| подпись =', JSON.stringify(note));
    const leaks = ['1991', 'Казань', '55.79', 'Тест', '6050935520'].filter((p) => svg.includes(p));
    console.log('  wheel.svg ПДн/идентификаторы:', leaks.length ? leaks.join(',') : '(нет)');
  }

  // Что уходит наружу при поиске места: только запрос, без даты/времени/id.
  const geo = await api('/geo/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Каз' }) }, unknownInit);
  const places = geo.body?.places ?? geo.body ?? null;
  console.log('POST /geo/resolve {query:Каз}:', geo.status, 'вариантов =', Array.isArray(places) ? places.length : '(нет массива)');
  console.log('  первый кандидат:', JSON.stringify(Array.isArray(places) ? places[0] ?? null : null).slice(0, 220));

  // Промпты: их в сборке нет — фиксируем, что проверить нечего.
  const health = await (await fetch(`${API}/health`)).json();
  console.log('  /health.llm =', health.llm, '| POST /reports →', (await api('/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, unknownInit)).status);
}

const scenarios = { m11, m11b, m11c, dp1, dp2, vectors, 'delete-then-pay': deleteThenPay, contract, report, r1, cr1 };
const which = process.argv[2] ?? 'all';
if (which === 'all') {
  for (const fn of Object.values(scenarios)) await fn();
} else if (scenarios[which]) {
  await scenarios[which]();
} else {
  console.error(`неизвестный сценарий: ${which}. Есть: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}
