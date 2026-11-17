#!/usr/bin/env node
/**
 * Итерация 25, живой прогон пути оплаты на стабе Bot API.
 *
 * Что проверяется и что печатается:
 *   1. **Вебхук** — API при старте сверяет `getWebhookInfo` с адресом из
 *      окружения. Стаб изображает «старый домен» (`POST /__config`), скрипт
 *      ждёт в логе перерегистрацию и показывает `getWebhookInfo` после неё.
 *      Без этого `pre_checkout_query` не приходит вовсе, и оплата «не
 *      проходит» без единой строки в логах.
 *   2. **Полный путь** для `month_399` (подписка) и `test_report_1` (разовый
 *      товар за 1 ⭐, только при `PAYMENTS_TEST_PLANS=1`):
 *      счёт → `pre_checkout_query` → `successful_payment` → доступ в `/me`.
 *   3. **Отказ по периоду**: `week_149` и `year_2990` остались подписками на
 *      7 и 365 дней, а Telegram принимает только 30. На стабе счёт создастся
 *      (стаб ничего не валидирует), и это честно печатается: живой Bot API
 *      ответил бы `400`. Решение за владельцем (`payments.md` §3.6).
 *
 * Использование (стенд поднят, стаб на 8091):
 *   node e2e/qa/iteration-25.mjs
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

async function stubConfig(webhook) {
  return stub('/__config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(webhook === undefined ? {} : { webhook }),
  });
}

async function lastCall(method) {
  const calls = await stub('/__calls');
  return [...calls].reverse().find((call) => call.method === method) ?? null;
}

async function invoiceFor(planCode, chartId) {
  const res = await api('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) }),
  });
  return res;
}

async function payFullPath(planCode, { chartId, amount } = {}) {
  const invoice = await invoiceFor(planCode, chartId);
  if (invoice.status !== 201) {
    return { invoice };
  }

  const link = await lastCall('createInvoiceLink');
  const payload = link?.body?.payload ?? null;
  const total = amount ?? invoice.body.stars;

  const preCheckout = await api(`/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
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
          ...(invoice.body.is_subscription
            ? { subscription_expiration_date: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 }
            : {}),
        },
      },
    }),
  });

  // Повтор доставки: должен ответить 200 и не выдать доступ второй раз.
  const retried = await api(`/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
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
        },
      },
    }),
  });

  const me = await api('/me');
  return { invoice, link, payload, preCheckout, answer, paid, retried, me, chargeId };
}

async function main() {
  console.log('1. Вебхук: «старый домен» → проверка и перерегистрация\n');

  const before = await stub(`/bot${TOKEN}/getWebhookInfo`);
  check(
    'getWebhookInfo до поломки',
    typeof before.result?.url === 'string',
    [
      `url = ${before.result?.url ?? '—'}`,
      `pending_update_count = ${String(before.result?.pending_update_count)}`,
      `last_error_message = ${before.result?.last_error_message ?? '—'}`,
    ],
  );

  // Стаб изображает состояние, из-за которого Telegram не доставляет
  // pre_checkout_query: адрес указывает на чужой (старый) домен.
  await stubConfig({
    url: 'https://old.example/api/v1/internal/telegram/webhook/old-secret',
    pending_update_count: 3,
    last_error_message: 'Wrong response from the webhook: 403 Forbidden',
    last_error_date: Math.floor(Date.now() / 1000) - 600,
  });

  const broken = await stub(`/bot${TOKEN}/getWebhookInfo`);
  check(
    'стаб изображает старый адрес вебхука',
    String(broken.result?.url).includes('old.example'),
    [
      `url = ${broken.result?.url}`,
      `pending_update_count = ${broken.result?.pending_update_count}`,
      `last_error_message = ${broken.result?.last_error_message}`,
    ],
  );

  // Починка — тем же кодом, что и на старте API: `payments:diagnose
  // --set-webhook` сравнивает адрес с окружением и регистрирует заново.
  let repair = 'не запускалась';
  let repaired = false;
  try {
    const out = execFileSync(
      process.env.QA_PNPM ?? 'pnpm',
      ['--filter', '@astro-soul/api', 'exec', 'tsx', 'scripts/payments-diagnose.ts', '--set-webhook', '--no-db', '--json'],
      { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const report = JSON.parse(out.slice(out.indexOf('{')));
    repair = `${report.webhook.state}: ${report.webhook.description}`;
    repaired = report.webhook.state === 'ok' || report.webhook.state === 'registered';
  } catch (error) {
    repair = `не удалось запустить diagnose: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}`;
  }

  const fixed = await stub(`/bot${TOKEN}/getWebhookInfo`);
  check('адрес вебхука восстановлен на ожидаемый', repaired && String(fixed.result?.url).includes(WEBHOOK_SECRET), [
    `diagnose: ${repair}`,
    `url = ${fixed.result?.url}`,
    `pending_update_count = ${String(fixed.result?.pending_update_count)}`,
  ]);

  console.log('\n2. Полный путь оплаты\n');

  const month = await payFullPath('month_399');
  check(
    'month_399: счёт → pre_checkout ok → платёж → доступ',
    month.invoice.status === 201 &&
      month.answer?.body?.ok === true &&
      month.paid?.status === 200 &&
      month.me?.body?.subscription?.is_active === true,
    [
      `invoice: ${String(month.invoice.status)} ${JSON.stringify(month.invoice.body)}`,
      `createInvoiceLink: ${JSON.stringify(month.link?.body)}`,
      `pre_checkout ответ: ${JSON.stringify(month.answer?.body)}`,
      `successful_payment: ${String(month.paid?.status)}, повтор: ${String(month.retried?.status)}`,
      `subscription: ${JSON.stringify(month.me?.body?.subscription ?? null)}`,
      `(если счёт не 201 — скорее всего 429 антифрод: прогон в тот же час уже был)`,
    ],
  );

  // Разовый товар за 1 ⭐ привязан к конкретной карте: без неё — 422.
  const withoutChart = await invoiceFor('test_report_1');
  check(
    'test_report_1 без карты → 422 (товар привязан к карте)',
    withoutChart.status === 422,
    [`POST /billing/invoice → ${withoutChart.status} ${withoutChart.body?.code ?? ''}`],
  );

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
  const chartId = chart.body?.chart?.chart_id ?? null;

  if (chartId === null) {
    // Стенд без движка эфемерид: карту не создать. Путь разового товара
    // покрыт интеграционным тестом (`payments-precheckout.spec.ts`) на
    // подменённом движке, здесь это не провал стенда.
    console.log(
      `— test_report_1: пропуск, карта не создана (POST /charts → ${String(chart.status)} ${String(chart.body?.code ?? '')})`,
    );
  } else {
    const oneStar = await payFullPath('test_report_1', { chartId });
    const entitlement = (oneStar.me?.body?.entitlements ?? {}).is_active === true;
    check(
      'test_report_1: счёт по карте → pre_checkout ok → доступ к разбору',
      oneStar.invoice.status === 201 &&
        oneStar.answer?.body?.ok === true &&
        oneStar.paid?.status === 200 &&
        entitlement,
      [
        `карта: ${chartId}`,
        `createInvoiceLink: ${JSON.stringify(oneStar.link?.body)}`,
        `pre_checkout ответ: ${JSON.stringify(oneStar.answer?.body)}`,
        `entitlements: ${JSON.stringify(oneStar.me?.body?.entitlements ?? null)}`,
      ],
    );
  }

  console.log('\n3. Тарифы с периодом, которого Telegram не принимает\n');

  for (const planCode of ['week_149', 'year_2990']) {
    const created = await invoiceFor(planCode);
    const call = await lastCall('createInvoiceLink');
    check(
      `${planCode}: на стабе счёт создаётся, живой Bot API ответил бы 400`,
      created.status === 201,
      [
        `subscription_period = ${String(call?.body?.subscription_period)}`,
        `ожидается 2592000; живой ответ: 400 Bad Request: subscription_period_invalid`,
        'решение о тарифах — за владельцем (payments.md §3.6)',
      ],
    );
  }

  console.log(`\nИтог: ${results.length - failures}/${results.length} проверок зелёные`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
