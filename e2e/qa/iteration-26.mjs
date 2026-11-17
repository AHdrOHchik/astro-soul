#!/usr/bin/env node
/**
 * Итерация 26, живой прогон на стабе Bot API.
 *
 * Что проверяется (и что печатается):
 *   1. **Состояние вебхука видно снаружи.** `/health` → `telegram_webhook: ok`,
 *      `/admin/metrics` → `telegram_webhook_ok: true` и время проверки. Раньше
 *      «вебхук не зарегистрирован» можно было узнать только по ssh.
 *   2. **`payments:diagnose`** на этом же окружении: у каждого тарифа
 *      `invoice_title` в лимите 1–32, у `test_1` период 2 592 000, живая
 *      проверка периодов (`--periods`) проходит. Стаб не валидирует периодов —
 *      поэтому это проверка нашего кода и данных, а не Bot API.
 *   3. **Полный путь оплаты** для `compat_249` и `test_report_1`: счёт →
 *      `pre_checkout_query` (ответ `ok: true`) → `successful_payment` → доступ.
 *      В счёт уходит `invoice_title` из базы, а не название тарифа.
 *   4. **`test_1`** выставляется как подписка на 30 дней
 *      (`subscription_period = 2 592 000`), а не недельная.
 *
 * Использование (API поднят на стабе, стаб на 8091):
 *   node e2e/qa/iteration-26.mjs
 *
 * Переменные как у `money.mjs`: QA_API, QA_STUB, QA_BOT_TOKEN, QA_WEBHOOK_SECRET.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const API = process.env.QA_API ?? 'http://127.0.0.1:8080/api/v1';
const STUB = process.env.QA_STUB ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.QA_BOT_TOKEN ?? '123456789:QA-TEST-TOKEN-not-real';
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? 'qa-webhook-secret-0123456789';
const USER_ID = 777_000_111;

/** Ожидаемые названия счёта — ровно то, что лежит в `plans.invoice_title`. */
const EXPECTED_TITLES = {
  compat_249: 'Совместимость с партнёром',
  test_report_1: 'Тестовый разбор — 1 ⭐',
  test_1: 'Тестовая подписка — 1 ⭐',
};

const results = [];
let failures = 0;

function check(name, ok, facts) {
  results.push({ name, ok, facts });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  for (const fact of facts ?? []) console.log(`    ${fact}`);
}

function signInitData(userId = USER_ID) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    query_id: `AAQ${userId}${authDate}`,
    user: JSON.stringify({ id: userId, first_name: 'Тест', last_name: 'Тестов', language_code: 'ru' }),
    auth_date: String(authDate),
  };
  const dcs = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
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

async function stub(path, options) {
  const res = await fetch(`${STUB}${path}`, options);
  return res.json();
}

async function lastCall(method) {
  const calls = await stub('/__calls');
  return [...calls].reverse().find((call) => call.method === method) ?? null;
}

async function invoiceFor(planCode, chartId) {
  return api('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) }),
  });
}

async function payFullPath(planCode, { chartId } = {}) {
  const invoice = await invoiceFor(planCode, chartId);
  if (invoice.status !== 201) {
    return { invoice };
  }

  const link = await lastCall('createInvoiceLink');
  const payload = link?.body?.payload ?? null;
  const total = invoice.body.stars;

  await api(`/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      pre_checkout_query: {
        id: `pcq-${planCode}-${Date.now()}`,
        from: { id: USER_ID },
        currency: 'XTR',
        total_amount: total,
        invoice_payload: payload,
      },
    }),
  });
  const answer = await lastCall('answerPreCheckoutQuery');

  const chargeId = `qa-${planCode}-${Date.now()}`;
  const paid = await api(`/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        chat: { id: USER_ID },
        from: { id: USER_ID },
        successful_payment: {
          currency: 'XTR',
          total_amount: total,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: `provider-${chargeId}`,
        },
      },
    }),
  });

  const me = await api('/me');
  return { invoice, link, payload, answer, paid, me, chargeId };
}

async function createChart() {
  const chart = await api('/charts', {
    method: 'POST',
    body: JSON.stringify({
      birth_date: '1994-05-17',
      birth_time: '14:20',
      time_precision: 'exact',
      birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
      consent: { accepted: true, version: '2026-11-10' },
    }),
  });
  return chart.body?.chart?.chart_id ?? null;
}

async function main() {
  console.log('1. Состояние вебхука видно снаружи (без ssh в контейнер)\n');

  const health = await api('/health');
  check('GET /health → telegram_webhook: ok', health.body?.telegram_webhook === 'ok', [
    `telegram_webhook = ${String(health.body?.telegram_webhook)}`,
    `db = ${String(health.body?.db)}, astro = ${String(health.body?.astro)}`,
  ]);

  const metrics = await api('/admin/metrics');
  check(
    'GET /admin/metrics → telegram_webhook_ok и время проверки',
    metrics.status === 200 &&
      metrics.body?.telegram_webhook_ok === true &&
      typeof metrics.body?.telegram_webhook_checked_at === 'string',
    [
      `telegram_webhook_ok = ${String(metrics.body?.telegram_webhook_ok)}`,
      `telegram_webhook_checked_at = ${String(metrics.body?.telegram_webhook_checked_at)}`,
    ],
  );

  console.log('\n2. payments:diagnose на этом же окружении\n');

  let report = null;
  try {
    const out = execFileSync(
      process.env.QA_PNPM ?? 'pnpm',
      ['--filter', '@astro-soul/api', 'exec', 'tsx', 'scripts/payments-diagnose.ts', '--periods', '--json'],
      { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    report = JSON.parse(out.slice(out.indexOf('{')));
  } catch (error) {
    console.log(`— не удалось запустить diagnose: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}`);
  }

  const catalogue = report?.catalogue ?? [];
  const overLimit = catalogue.filter((row) => row.invoice_title_chars < 1 || row.invoice_title_chars > 32);
  check(
    'каталог: у каждого тарифа invoice_title 1–32 символа',
    catalogue.length > 0 && overLimit.length === 0,
    catalogue.map((row) => `${row.code}: «${row.invoice_title}» (${String(row.invoice_title_chars)}/32)`),
  );

  const testPlan = catalogue.find((row) => row.code === 'test_1');
  check(
    'test_1: период 2 592 000 и название счёта в лимите',
    testPlan?.period_seconds === 2_592_000 && testPlan?.severity === null,
    [
      `period_seconds = ${String(testPlan?.period_seconds)}`,
      `invoice_title = «${String(testPlan?.invoice_title)}» (${String(testPlan?.invoice_title_chars)}/32)`,
    ],
  );

  const probes = report?.periods ?? [];
  check(
    '--periods: все периоды приняты (стаб, не живой Bot API)',
    probes.length > 0 && probes.every((probe) => probe.ok),
    probes.map((probe) => `${probe.code}: ${String(probe.period_seconds)} → ${probe.ok ? 'ok' : `HTTP ${String(probe.status)}`}`),
  );

  console.log('\n3. Полный путь оплаты: compat_249 и test_report_1\n');

  // Карта: на стенде без движка эфемерид `POST /charts` недоступен, поэтому
  // готовую карту можно передать через `QA_CHART_ID` (QA вставляет её в `charts`
  // от имени того же пользователя). Без карты разовые товары не проверить.
  const chartId = process.env.QA_CHART_ID ?? (await createChart());

  if (chartId === null) {
    console.log('— карта не создана (нет движка на стенде): разовые товары не проверить');
  }

  const compat = await payFullPath('compat_249', { chartId: chartId ?? undefined });
  const compatTitle = compat.link?.body?.title ?? null;
  check(
    'compat_249: счёт → pre_checkout ok → платёж → доступ',
    compat.invoice?.status === 201 &&
      compat.answer?.body?.ok === true &&
      compat.paid?.status === 200 &&
      compat.me?.status === 200,
    [
      `invoice: ${String(compat.invoice?.status)} ${String(compat.invoice?.body?.code ?? '')}`,
      `createInvoiceLink.title = «${String(compatTitle)}» (${String([...(compatTitle ?? '')].length)}/32)`,
      `awaited = «${EXPECTED_TITLES.compat_249}»`,
      `pre_checkout ответ: ${JSON.stringify(compat.answer?.body ?? null)}`,
      `successful_payment: ${String(compat.paid?.status)}, доступ: ${JSON.stringify(compat.me?.body?.entitlements ?? null)}`,
    ],
  );

  if (chartId !== null) {
    const reportPlan = await payFullPath('test_report_1', { chartId });
    const reportTitle = reportPlan.link?.body?.title ?? null;
    check(
      'test_report_1: счёт по карте → pre_checkout ok → платёж → доступ к разбору',
      reportPlan.invoice?.status === 201 &&
        reportPlan.answer?.body?.ok === true &&
        reportPlan.paid?.status === 200 &&
        reportPlan.me?.body?.entitlements?.full_report === true &&
        reportPlan.me?.body?.entitlements?.full_report_chart_id === chartId,
      [
        `createInvoiceLink.title = «${String(reportTitle)}» (${String([...(reportTitle ?? '')].length)}/32)`,
        `awaited = «${EXPECTED_TITLES.test_report_1}»`,
        `pre_checkout ответ: ${JSON.stringify(reportPlan.answer?.body ?? null)}`,
        `entitlements: ${JSON.stringify(reportPlan.me?.body?.entitlements ?? null)}`,
      ],
    );
    check(
      'в счёт уходит invoice_title из базы, а не название тарифа',
      compatTitle === EXPECTED_TITLES.compat_249 && reportTitle === EXPECTED_TITLES.test_report_1,
      [`compat_249: «${String(compatTitle)}»`, `test_report_1: «${String(reportTitle)}»`],
    );
  }

  console.log('\n4. test_1 — подписка на 30 дней\n');

  const testInvoice = await invoiceFor('test_1');
  const testCall = await lastCall('createInvoiceLink');
  check(
    'test_1: счёт подписки с subscription_period = 2 592 000',
    testInvoice.status === 201 &&
      testInvoice.body?.subscription_period_sec === 2_592_000 &&
      testCall?.body?.subscription_period === 2_592_000,
    [
      `invoice: ${String(testInvoice.status)} ${String(testInvoice.body?.code ?? '')}`,
      `subscription_period_sec = ${String(testInvoice.body?.subscription_period_sec)}`,
      `createInvoiceLink.subscription_period = ${String(testCall?.body?.subscription_period)}`,
      `createInvoiceLink.title = «${String(testCall?.body?.title)}»`,
    ],
  );

  console.log(`\nИтог: ${results.length - failures}/${results.length} проверок зелёные`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
