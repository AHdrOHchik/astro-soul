#!/usr/bin/env node
/**
 * QA-13: тестовый тариф `test_1` за 1 звезду.
 *
 * Проверяет то, что нельзя проверить в vitest: живые два процесса API — один
 * с `PAYMENTS_TEST_PLANS` (как стенд владельца), второй без него (как прод), —
 * настоящий вебхук, настоящая БД и стаб Bot API, который записывает тела
 * вызовов. Смысл прогона: тестовая цена не появляется в проде ни при каком
 * забытом флаге, а оплата по ней проходит ровно тем же путём, что у обычного
 * тарифа, включая сверку суммы и возврат одной звезды.
 *
 * Запуск: node e2e/qa/iteration-13.mjs <off|on|pay|wrong-amount|refund|prod-guard|all>
 *
 * Окружение:
 *   QA_API_OFF      — API без флага (по умолчанию http://127.0.0.1:8084/api/v1)
 *   QA_API_ON       — API с PAYMENTS_TEST_PLANS=1 (http://127.0.0.1:8085/api/v1)
 *   QA_PSQL, QA_DB, QA_BOT_TOKEN, QA_WEBHOOK_SECRET, QA_ADMIN_TG_ID, STUB
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const API_OFF = process.env.QA_API_OFF ?? 'http://127.0.0.1:8084/api/v1';
const API_ON = process.env.QA_API_ON ?? 'http://127.0.0.1:8085/api/v1';
const STUB = process.env.STUB ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.QA_BOT_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? '';
const ADMIN_TG_ID = process.env.QA_ADMIN_TG_ID ?? '';
const PSQL = process.env.QA_PSQL ?? 'psql';
const DB = process.env.QA_DB ?? 'astro_qa13';
/** Корень репозитория: `check.sh` живёт там. */
const ROOT = new URL('../../', import.meta.url).pathname;

/** Пользователь один на весь прогон: владелец и есть плательщик. */
const TG_ID = Number(process.env.QA_TG_ID ?? '777013001');

let failures = 0;

function check(ok, what, actual = '') {
  if (ok) {
    console.log(`  ок    ${what}${actual === '' ? '' : ` — ${actual}`}`);
  } else {
    failures += 1;
    console.log(`  ПРОВАЛ ${what}${actual === '' ? '' : ` — ${actual}`}`);
  }
}

function sql(query) {
  return execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB, '-Atc', query])
    .toString()
    .trim();
}

/** `initData`, подписанный токеном стенда: другого входа в API нет. */
function initData(telegramId = TG_ID) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    query_id: `AAQ${telegramId}${authDate}${Math.random().toString(16).slice(2, 8)}`,
    user: JSON.stringify({ id: telegramId, first_name: 'Владелец' }),
    auth_date: String(authDate),
  };
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function client(base, telegramId = TG_ID) {
  const headers = { 'x-telegram-init-data': initData(telegramId), 'content-type': 'application/json' };

  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers ?? {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    // Заголовки нужны проверкам кэша (`Cache-Control` на витрине).
    return { status: response.status, body, headers: Object.fromEntries(response.headers) };
  };

  return { call, me: () => call('/me') };
}

/** Карта через настоящий движок: разбор привязан к конкретной карте. */
async function createChart(base, birth) {
  const api = client(base);
  const created = await api.call('/charts', {
    method: 'POST',
    body: JSON.stringify({
      ...birth,
      time_precision: 'exact',
      consent: { version: '2026-11-10', accepted: true },
    }),
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`POST /charts: ${created.status} ${JSON.stringify(created.body)}`);
  }
  return created.body.chart.chart_id;
}

/** `POST /reports`: 202 — заказ принят, 402 — разбор по этой карте не оплачен. */
async function orderReport(base, chartId) {
  const response = await client(base).call('/reports', {
    method: 'POST',
    body: JSON.stringify({ chart_id: chartId, type: 'full' }),
    headers: { 'idempotency-key': randomUUID() },
  });
  return response.status;
}

async function stubReset() {
  await fetch(`${STUB}/__calls/reset`, { method: 'POST' });
  await fetch(`${STUB}/__config`, { method: 'POST', body: JSON.stringify({ fail: {} }) });
}

/** Журнал стаба: `GET /__calls` отдаёт массив `{method, body, at}`. */
async function stubCalls(method) {
  const response = await fetch(`${STUB}/__calls`);
  const calls = await response.json();
  return (Array.isArray(calls) ? calls : []).filter((call) => call.method === method);
}

/** `successful_payment` через вебхук — единственный способ выдать доступ. */
async function pay(base, chargeId, amount, payload) {
  const response = await fetch(`${base}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 1,
      message: {
        chat: { id: TG_ID },
        from: { id: TG_ID },
        successful_payment: {
          currency: 'XTR',
          total_amount: amount,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: `provider-${chargeId}`,
        },
      },
    }),
  });
  return response.status;
}

function cleanup() {
  const userId = sql(`select id from users where telegram_id = ${TG_ID}`);
  if (userId !== '') {
    sql(
      `delete from entitlements where user_id = '${userId}';
       delete from subscriptions where user_id = '${userId}';
       delete from payments where user_id = '${userId}';
       delete from invoices where user_id = '${userId}';
       delete from users where id = '${userId}';`,
    );
  }
  sql(`delete from payments where telegram_payment_charge_id like 'qa13-%'`);
  sql(`delete from invoices where plan_code = 'test_1'`);
}

async function invoice(base, planCode) {
  const api = client(base);
  await api.me();
  cleanup();
  await api.me();
  return api.call('/billing/invoice', { method: 'POST', body: JSON.stringify({ plan_code: planCode }) });
}

/* ─────────────────────────── сценарии ─────────────────────────── */

async function off() {
  console.log('\n=== off: флаг выключен — test_1 не существует ===');

  await stubReset();
  const test = await invoice(API_OFF, 'test_1');
  const unknown = await invoice(API_OFF, 'no_such_plan');

  check(test.status === 422, 'POST /billing/invoice {test_1} → 422', String(test.status));
  check(test.body?.code === 'VALIDATION_FAILED', 'code = VALIDATION_FAILED', String(test.body?.code));
  check(
    test.body?.details?.field_errors?.[0]?.field === 'plan_code',
    'field_errors[0].field = plan_code',
  );
  check(
    JSON.stringify(test.body?.details) === JSON.stringify(unknown.body?.details) &&
      test.body?.message === unknown.body?.message,
    'ответ неотличим от несуществующего плана',
  );
  check((await stubCalls('createInvoiceLink')).length === 0, 'Bot API не звали', '0 вызовов');
  check(
    sql(`select count(*) from invoices where plan_code = 'test_1'`) === '0',
    'инвойсов test_1 в БД нет',
  );
  return true;
}

async function on() {
  console.log('\n=== on: флаг включён — 1 ⭐, неделя ===');

  await stubReset();
  const created = await invoice(API_ON, 'test_1');

  check(created.status === 201, 'POST /billing/invoice {test_1} → 201', String(created.status));
  check(created.body?.plan_code === 'test_1', 'plan_code = test_1', String(created.body?.plan_code));
  check(created.body?.stars === 1, 'stars = 1', String(created.body?.stars));
  check(created.body?.is_subscription === true, 'is_subscription = true');
  check(created.body?.subscription_period_sec === 604800, 'период 604800 сек (неделя)');

  const call = (await stubCalls('createInvoiceLink'))[0];
  check(call?.body?.prices?.[0]?.amount === 1, 'в Bot API ушла сумма 1', String(call?.body?.prices?.[0]?.amount));
  check(call?.body?.subscription_period === 604800, 'subscription_period 604800');
  check(
    JSON.stringify(Object.keys(JSON.parse(call?.body?.payload ?? '{}')).sort()) === '["k","p","u"]',
    'payload без ПДн: p, u, k',
  );

  // Витрина (1.5.9): тестовый тариф виден на стенде с флагом — и это
  // единственное место, где он должен быть виден. Разбор ответа — в scenario
  // `plans`, здесь достаточно того, что он пришёл с `test: true`.
  const plans = await client(API_ON).call('/billing/plans');
  const offered = Array.isArray(plans.body?.plans) ? plans.body.plans : [];
  check(
    offered.some((plan) => plan.plan_code === 'test_1' && plan.test === true),
    'в витрине стенда test_1 есть и помечен test: true',
    String(plans.status),
  );
  return true;
}

async function preCheckout() {
  console.log('\n=== precheckout: Telegram спрашивает разрешение на 1 ⭐ ===');

  await stubReset();
  await invoice(API_ON, 'test_1');
  const payload = sql(
    `select payload from invoices where plan_code = 'test_1' order by created_at desc limit 1`,
  );

  const status = await fetch(`${API_ON}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 2,
      pre_checkout_query: {
        id: 'qa13-pcq',
        from: { id: TG_ID },
        currency: 'XTR',
        total_amount: 1,
        invoice_payload: payload,
      },
    }),
  }).then((response) => response.status);

  check(status === 200, 'вебхук принят', String(status));
  const answers = (await stubCalls('answerPreCheckoutQuery')).map((call) => call.body);
  check(answers.length === 1 && answers[0]?.ok === true, 'ответ бота ok = true', JSON.stringify(answers));

  // После удаления данных тот же счёт не принимается — путь общий с каталогом.
  await client(API_ON).call('/me', { method: 'DELETE' });
  const again = await fetch(`${API_ON}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 3,
      pre_checkout_query: {
        id: 'qa13-pcq-2',
        from: { id: TG_ID },
        currency: 'XTR',
        total_amount: 1,
        invoice_payload: payload,
      },
    }),
  }).then((response) => response.status);
  const answersAfter = (await stubCalls('answerPreCheckoutQuery')).map((call) => call.body);
  check(again === 200 && answersAfter[1]?.ok === false, 'после DELETE /me — ok = false', JSON.stringify(answersAfter[1]));
  return true;
}

async function payScenario() {
  console.log('\n=== pay: 1 ⭐ выдаёт права month_399 на 7 дней ===');

  await stubReset();
  const created = await invoice(API_ON, 'test_1');
  const payload = sql(
    `select payload from invoices where plan_code = 'test_1' order by created_at desc limit 1`,
  );
  const chargeId = `qa13-${randomUUID()}`;
  const startedAt = Date.now();

  const status = await pay(API_ON, chargeId, 1, payload);
  check(status === 200, 'вебхук принят', String(status));

  const me = await client(API_ON).me();
  check(me.body?.subscription?.is_active === true, 'subscription.is_active = true');
  check(me.body?.subscription?.plan === 'month', 'plan = month (enum не расширялся)');
  const expires = new Date(me.body?.subscription?.expires_at ?? 0).getTime();
  const days = Math.round((expires - startedAt) / (24 * 3600 * 1000));
  check(days === 7, 'expires_at = +7 дней', `${days} дн.`);
  check(me.body?.entitlements?.full_forecast === true, 'full_forecast = true (как month_399)');
  check(me.body?.entitlements?.ask_per_day === 5, 'ask_per_day = 5');

  const row = sql(
    `select status || '|' || is_test || '|' || total_amount from payments
      where telegram_payment_charge_id = '${chargeId}'`,
  );
  check(row === 'processed|true|1', 'платёж: processed, is_test = true, сумма 1', row);

  // Метрики: тестовая звезда не выручка и не платящий пользователь.
  const metrics = await client(API_ON).call('/admin/metrics');
  check(metrics.status === 200, 'GET /admin/metrics', String(metrics.status));
  check(metrics.body?.test_payments_30d === 1, 'test_payments_30d = 1', String(metrics.body?.test_payments_30d));
  check(metrics.body?.stars_received_30d === 0, 'stars_received_30d = 0', String(metrics.body?.stars_received_30d));
  check(metrics.body?.paying === 0, 'paying = 0 (тестовая подписка не продажа)', String(metrics.body?.paying));
  check(metrics.body?.conversion_to_paid === 0, 'conversion_to_paid = 0');

  check(
    sql(`select count(*) from plans where code = 'test_1' and test_only and not is_active`) === '1',
    'plans: test_only = true, is_active = false',
  );
  check(created.body?.invoice_link?.startsWith('https://t.me/') === true, 'ссылка на оплату есть');
  return true;
}

async function wrongAmount() {
  console.log('\n=== wrong-amount: 2 ⭐ за test_1 — проверка суммы не ослаблена ===');

  await stubReset();
  await invoice(API_ON, 'test_1');
  const payload = sql(
    `select payload from invoices where plan_code = 'test_1' order by created_at desc limit 1`,
  );
  const chargeId = `qa13-${randomUUID()}`;

  await pay(API_ON, chargeId, 2, payload);

  const row = sql(
    `select status || '|' || reject_reason || '|' || is_test from payments
      where telegram_payment_charge_id = '${chargeId}'`,
  );
  check(row === 'rejected|amount_mismatch|true', 'отказ amount_mismatch, is_test = true', row);

  const me = await client(API_ON).me();
  check(me.body?.entitlements?.is_active === false, 'доступа нет', String(me.body?.entitlements?.is_active));
  return true;
}

async function refund() {
  console.log('\n=== refund: возврат одной звезды ===');

  await stubReset();
  await invoice(API_ON, 'test_1');
  const payload = sql(
    `select payload from invoices where plan_code = 'test_1' order by created_at desc limit 1`,
  );
  const chargeId = `qa13-${randomUUID()}`;
  await pay(API_ON, chargeId, 1, payload);

  const run = spawnSync(
    'pnpm',
    // Путь от `apps/api`: скрипт поддержки живёт в `e2e/qa`.
    ['exec', 'tsx', '../../e2e/qa/support-refund.ts', chargeId],
    {
      cwd: `${ROOT}apps/api`,
      env: { ...process.env, DATABASE_URL: `postgres://postgres@127.0.0.1:5432/${DB}` },
      encoding: 'utf8',
    },
  );
  const out = `${run.stdout}${run.stderr}`;
  check(run.status === 0, 'support-refund.ts выполнился', String(run.status));
  check(/refund\(\) -> true/.test(out), 'refund() вернул true');
  check(/повторный refund\(\) -> false/.test(out), 'повторный refund() — false');

  const calls = await stubCalls('refundStarPayment');
  check(calls.length === 1, 'refundStarPayment вызван ровно раз', String(calls.length));
  check(
    calls[0]?.body?.user_id === TG_ID && calls[0]?.body?.telegram_payment_charge_id === chargeId,
    'пара (user_id, charge_id) в вызове',
  );

  const row = sql(`select status || '|' || is_test from payments where telegram_payment_charge_id = '${chargeId}'`);
  check(row === 'refunded|true', 'платёж: refunded, is_test = true', row);

  const me = await client(API_ON).me();
  check(me.body?.entitlements?.is_active === false, 'доступ отозван');
  return true;
}

const CHART_A = {
  birth_date: '1992-03-08',
  birth_time: '11:15',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
};
const CHART_B = {
  birth_date: '1988-09-30',
  birth_time: '22:05',
  birth_place: { name: 'Тбилиси', country: 'GE', lat: 41.7151, lon: 44.8271, tz: 'Asia/Tbilisi' },
};

async function reportOff() {
  console.log('\n=== report-off: без флага разового тарифа нет ===');

  await stubReset();
  const api = client(API_OFF);
  await api.me();
  cleanup();
  await api.me();
  const chartId = await createChart(API_OFF, CHART_A);

  const test = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'test_report_1', chart_id: chartId }),
  });
  const unknown = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'no_such_plan', chart_id: chartId }),
  });

  check(test.status === 422, 'POST /billing/invoice {test_report_1} → 422', String(test.status));
  check(
    JSON.stringify(test.body?.details) === JSON.stringify(unknown.body?.details) &&
      test.body?.message === unknown.body?.message,
    'ответ неотличим от несуществующего плана',
  );
  check((await stubCalls('createInvoiceLink')).length === 0, 'Bot API не звали');
  check(
    sql(`select count(*) from invoices where plan_code = 'test_report_1'`) === '0',
    'инвойсов test_report_1 в БД нет',
  );
  return true;
}

async function reportOn() {
  console.log('\n=== report-on: разовый счёт на 1 ⭐ без периода ===');

  await stubReset();
  const api = client(API_ON);
  await api.me();
  cleanup();
  await api.me();
  const chartId = await createChart(API_ON, CHART_A);

  const created = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'test_report_1', chart_id: chartId }),
  });

  check(created.status === 201, 'POST /billing/invoice → 201', String(created.status));
  check(created.body?.plan_code === 'test_report_1', 'plan_code = test_report_1');
  check(created.body?.stars === 1, 'stars = 1', String(created.body?.stars));
  check(created.body?.is_subscription === false, 'is_subscription = false');
  check(created.body?.subscription_period_sec === null, 'subscription_period_sec = null');

  const call = (await stubCalls('createInvoiceLink'))[0];
  check(call?.body?.prices?.[0]?.amount === 1, 'в Bot API ушла сумма 1');
  check(call?.body?.subscription_period === undefined, 'subscription_period не передан (не подписка)');
  return true;
}

async function reportPay() {
  console.log('\n=== report-pay: доступ только на оплаченную карту ===');

  await stubReset();
  const api = client(API_ON);
  await api.me();
  cleanup();
  await api.me();

  const paidChart = await createChart(API_ON, CHART_A);
  const otherChart = await createChart(API_ON, CHART_B);

  const created = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'test_report_1', chart_id: paidChart }),
  });
  check(created.status === 201, 'счёт выставлен', String(created.status));

  const payload = sql(
    `select payload from invoices where plan_code = 'test_report_1' order by created_at desc limit 1`,
  );
  const chargeId = `qa13-${randomUUID()}`;
  await pay(API_ON, chargeId, 1, payload);

  const me = await client(API_ON).me();
  check(me.body?.entitlements?.full_report === true, 'entitlements.full_report = true');
  check(
    me.body?.entitlements?.full_report_chart_id === paidChart,
    'full_report_chart_id = оплаченная карта',
  );
  check(me.body?.entitlements?.full_report_chart_id !== otherChart, 'на второй карте доступа нет');

  // «К разбору» на оплаченной карте, цена — на второй.
  check((await orderReport(API_ON, paidChart)) === 202, 'POST /reports по оплаченной карте → 202');
  check((await orderReport(API_ON, otherChart)) === 402, 'POST /reports по второй карте → 402 (цена)');

  const row = sql(
    `select status || '|' || is_test || '|' || total_amount from payments
      where telegram_payment_charge_id = '${chargeId}'`,
  );
  check(row === 'processed|true|1', 'платёж: processed, is_test, 1 ⭐', row);

  // Повторная покупка того же разбора — отказ, второго доступа нет.
  const again = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'test_report_1', chart_id: paidChart }),
  });
  check(again.status === 422, 'повторный счёт на ту же карту → 422', String(again.status));
  check(
    again.body?.details?.field_errors?.[0]?.field === 'chart_id',
    'отказ указывает на chart_id',
  );
  check(
    sql(`select count(*) from entitlements where kind = 'report' and status = 'active'`) === '1',
    'активный report-доступ ровно один',
  );

  // Та же защита для настоящего тарифа: она не про цену.
  const one = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'one_149', chart_id: paidChart }),
  });
  check(one.status === 422, 'one_149 на уже купленную карту → 422 (защита не про цену)', String(one.status));

  const metrics = await client(API_ON).call('/admin/metrics');
  check(metrics.body?.test_payments_30d === 1, 'test_payments_30d = 1', String(metrics.body?.test_payments_30d));
  check(metrics.body?.stars_received_30d === 0, 'stars_received_30d = 0', String(metrics.body?.stars_received_30d));
  return true;
}

async function reportRefund() {
  console.log('\n=== report-refund: возврат 1 ⭐ отзывает доступ и разрешает покупку снова ===');

  await stubReset();
  const api = client(API_ON);
  await api.me();
  cleanup();
  await api.me();
  const chartId = await createChart(API_ON, CHART_A);

  await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'test_report_1', chart_id: chartId }),
  });
  const payload = sql(
    `select payload from invoices where plan_code = 'test_report_1' order by created_at desc limit 1`,
  );
  const chargeId = `qa13-${randomUUID()}`;
  await pay(API_ON, chargeId, 1, payload);

  const run = spawnSync('pnpm', ['exec', 'tsx', '../../e2e/qa/support-refund.ts', chargeId], {
    cwd: `${ROOT}apps/api`,
    env: { ...process.env, DATABASE_URL: `postgres://postgres@127.0.0.1:5432/${DB}` },
    encoding: 'utf8',
  });
  check(run.status === 0, 'support-refund.ts выполнился', String(run.status));

  const me = await client(API_ON).me();
  check(me.body?.entitlements?.full_report === false, 'full_report = false после возврата');
  check(me.body?.entitlements?.full_report_chart_id === null, 'full_report_chart_id = null');
  check((await orderReport(API_ON, chartId)) === 402, 'POST /reports → 402 после возврата');

  const again = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: 'test_report_1', chart_id: chartId }),
  });
  check(again.status === 201, 'после возврата разбор можно купить снова', String(again.status));
  return true;
}

async function plans() {
  console.log('\n=== plans: витрина — данные сервера, тестовые тарифы только по флагу ===');

  const off = await client(API_OFF).call('/billing/plans');
  const offPlans = Array.isArray(off.body?.plans) ? off.body.plans : [];
  const offRaw = JSON.stringify(off.body);

  check(off.status === 200, 'флаг выключен: 200', String(off.status));
  check(offPlans.length === 6, 'шесть тарифов каталога', String(offPlans.length));
  check(
    offPlans.every((plan) => plan.test === false),
    'ни одного тарифа с test: true',
  );
  check(!offRaw.includes('test_1'), 'в ответе нет test_1 — даже подстрокой');
  check(!offRaw.includes('test_report_1'), 'в ответе нет test_report_1');
  check(
    off.headers?.['cache-control'] === 'no-store',
    'Cache-Control: no-store',
    off.headers?.['cache-control'] ?? 'нет заголовка',
  );
  check(
    offPlans.map((plan) => plan.plan_code).join(',') === 'one_149,week_149,month_399,year_2990,compat_249,solar_590',
    'порядок пейволла и цены из общей таблицы',
    offPlans.map((plan) => `${plan.plan_code}:${plan.stars}`).join(' '),
  );
  const report = offPlans.find((plan) => plan.plan_code === 'one_149');
  check(
    report?.kind === 'one_off' && report?.period_sec === null && report?.stars === 149,
    'разбор: one_off, 149 ⭐, без периода',
  );
  check(
    offPlans.find((plan) => plan.plan_code === 'month_399')?.period_sec === 2592000,
    'месяц: период 2592000',
  );

  const on = await client(API_ON).call('/billing/plans');
  const onPlans = Array.isArray(on.body?.plans) ? on.body.plans : [];
  const catalogue = onPlans.filter((plan) => plan.test !== true);
  const tests = onPlans.filter((plan) => plan.test === true);

  check(on.status === 200, 'флаг включён: 200', String(on.status));
  check(onPlans.length === 8, 'каталог + два тестовых', String(onPlans.length));
  check(catalogue.length === 6, 'каталог не сдвинулся', String(catalogue.length));
  check(
    tests.map((plan) => plan.plan_code).join(',') === 'test_1,test_report_1',
    'тестовые идут после каталога парой',
    tests.map((plan) => plan.plan_code).join(','),
  );
  check(
    tests.every((plan) => plan.stars === 1),
    'оба по 1 ⭐',
  );
  const testReport = tests.find((plan) => plan.plan_code === 'test_report_1');
  const testSubscription = tests.find((plan) => plan.plan_code === 'test_1');
  check(testReport?.kind === 'one_off' && testReport?.period_sec === null, 'тест-разбор: one_off без периода');
  check(testSubscription?.period_sec === 604800, 'тест-подписка: период 604800');
  check(
    typeof testReport?.title === 'string' && testReport.title.length > 0 &&
      Array.isArray(testReport?.includes) && testReport.includes.length > 0,
    'тексты и состав приходят с сервера',
  );

  // Метрика «включил и забыл»: на стенде с флагом она true, без флага — false.
  const metricsOn = await client(API_ON).call('/admin/metrics');
  const metricsOff = await client(API_OFF).call('/admin/metrics');
  check(metricsOn.body?.test_plans_active === true, 'metrics: test_plans_active = true при флаге');
  check(metricsOff.body?.test_plans_active === false, 'metrics: test_plans_active = false без флага');
  return true;
}

async function prodGuard() {
  console.log('\n=== prod-guard: check.sh --prod не пускает с флагом ===');

  const withFlag = spawnSync('bash', ['check.sh', '--prod'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PAYMENTS_TEST_PLANS: '1' },
    encoding: 'utf8',
  });
  check(withFlag.status === 1, 'код выхода 1', String(withFlag.status));
  check(withFlag.stderr.includes('PAYMENTS_TEST_PLANS'), 'в тексте названа переменная');
  check(withFlag.stderr.includes('test_1'), 'в тексте объяснено, что это за тариф');

  const clean = spawnSync('bash', ['check.sh', '--prod'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  check(clean.status === 0, 'чистое окружение проходит', String(clean.status));
  return true;
}

/* ───────────────────────────── main ───────────────────────────── */

const scenarios = {
  off,
  on,
  precheckout: preCheckout,
  pay: payScenario,
  'wrong-amount': wrongAmount,
  refund,
  'report-off': reportOff,
  'report-on': reportOn,
  'report-pay': reportPay,
  'report-refund': reportRefund,
  plans,
  'prod-guard': prodGuard,
};
const which = (process.argv[2] ?? 'all').toLowerCase();

if (which === 'all') {
  for (const [name, fn] of Object.entries(scenarios)) {
    const ok = await fn();
    if (ok !== true) {
      console.log(`  прогон остановлен на сценарии ${name}`);
      process.exit(1);
    }
  }
} else if (scenarios[which] !== undefined) {
  await scenarios[which]();
} else {
  console.error(`неизвестный сценарий: ${which}. Есть: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

console.log(failures === 0 ? '\nВЫВОД: закрыто.' : `\nВЫВОД: провалов ${failures}.`);
process.exit(failures === 0 ? 0 : 1);
