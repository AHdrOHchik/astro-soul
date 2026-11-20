#!/usr/bin/env node
/**
 * Итерация 29, живой прогон отмены подписки на стабе Bot API.
 *
 * Что проверяется и что печатается:
 *   1. **Полный путь оплаты `test_1`** — ровно та подписка, которой владелец
 *      проверяет деньги: счёт → `pre_checkout_query` → `successful_payment` →
 *      доступ в `/me`. Без этого отменять было бы нечего.
 *   2. **Отмена из приложения** — `POST /subscription/cancel` с
 *      `Idempotency-Key`. В `GET /__config` стаба видно **параметры вызова**
 *      `editUserStarSubscription`: `user_id`, `telegram_payment_charge_id`
 *      последнего платежа и `is_canceled: true`.
 *   3. **Отмена ≠ возврат** — `expires_at`, `is_active` и `entitlements` в
 *      `/me` те же, что до отмены; меняются только `auto_renew`/`cancelled_at`.
 *   4. **Повтор** → `409 already_cancelled`, второго вызова в Bot API нет.
 *   5. **Сбой Bot API** (второй пользователь) → `502 telegram_error`, и
 *      `subscription_cancel_failed_24h` в метриках растёт.
 *
 * Использование (стенд поднят, стаб на 8091):
 *   node e2e/qa/iteration-29.mjs
 *
 * Переменные как у `money.mjs`: QA_API, QA_STUB, QA_BOT_TOKEN, QA_WEBHOOK_SECRET.
 */
import { createHmac } from 'node:crypto';

const API = process.env.QA_API ?? 'http://127.0.0.1:8080/api/v1';
const STUB = process.env.QA_STUB ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.QA_BOT_TOKEN ?? '123456789:QA-TEST-TOKEN-not-real';
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? 'qa-webhook-secret-0123456789';
const USER_ID = 777_000_111;
const FAILING_USER_ID = 777_000_112;

const results = [];
let failures = 0;

function check(name, ok, facts) {
  results.push({ name, ok, facts });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  for (const fact of facts ?? []) console.log(`    ${fact}`);
}

function signInitData(userId) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    query_id: `AAQ${userId}${authDate}`,
    user: JSON.stringify({ id: userId, first_name: 'Тест', last_name: 'Тестов', language_code: 'ru' }),
    auth_date: String(authDate),
  };
  const dcs = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function api(path, options = {}) {
  const init = signInitData(options.userId ?? USER_ID);
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'x-telegram-init-data': init,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
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

/** Полный путь оплаты: счёт → pre_checkout → successful_payment. */
async function pay(planCode, userId) {
  const invoice = await api('/billing/invoice', {
    method: 'POST',
    userId,
    body: JSON.stringify({ plan_code: planCode }),
  });
  if (invoice.status !== 201) {
    return { invoice };
  }

  const link = await lastCall('createInvoiceLink');
  const payload = link?.body?.payload ?? null;
  const total = invoice.body.stars;

  await api(`/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    userId,
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      pre_checkout_query: {
        id: `pcq-${planCode}-${Date.now()}`,
        from: { id: userId },
        currency: 'XTR',
        total_amount: total,
        invoice_payload: payload,
      },
    }),
  });

  const chargeId = `qa-cancel-${userId}-${Date.now()}`;
  const paid = await api(`/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    userId,
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        chat: { id: userId },
        from: { id: userId },
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

  return { invoice, link, payload, paid, chargeId };
}

async function cancel(userId = USER_ID, key = `cancel-${Date.now()}`) {
  return api('/subscription/cancel', {
    method: 'POST',
    userId,
    headers: { 'idempotency-key': key },
  });
}

async function main() {
  console.log('1. Тестовая подписка `test_1`: полный путь оплаты\n');

  const payment = await pay('test_1', USER_ID);
  check('счёт выставлен', payment.invoice?.status === 201, [
    `status = ${payment.invoice?.status}`,
    `plan_code = ${payment.invoice?.body?.plan_code ?? '—'}`,
    `stars = ${payment.invoice?.body?.stars ?? '—'}`,
  ]);
  check('successful_payment принят', payment.paid?.status === 200, [
    `charge_id = ${payment.chargeId ?? '—'}`,
    `ответ = ${JSON.stringify(payment.paid?.body)}`,
  ]);

  const before = await api('/me');
  const beforeSub = before.body?.subscription ?? {};
  const beforeAccess = JSON.stringify(before.body?.entitlements ?? {});
  check('подписка активна и продлится', beforeSub.is_active === true && beforeSub.auto_renew === true, [
    `plan = ${beforeSub.plan}`,
    `is_active = ${String(beforeSub.is_active)}`,
    `auto_renew = ${String(beforeSub.auto_renew)}`,
    `cancelled_at = ${JSON.stringify(beforeSub.cancelled_at ?? null)}`,
    `expires_at = ${beforeSub.expires_at}`,
  ]);

  console.log('\n2. Отмена: ключ идемпотентности обязателен\n');

  const noKey = await api('/subscription/cancel', { method: 'POST' });
  check('без Idempotency-Key → 422', noKey.status === 422, [
    `code = ${noKey.body?.code ?? '—'}`,
    `field = ${noKey.body?.details?.field_errors?.[0]?.field ?? '—'}`,
  ]);

  console.log('\n3. Отмена `test_1` из приложения\n');

  const cancelled = await cancel(USER_ID, `qa-test-1-${Date.now()}`);
  check('POST /subscription/cancel → 200', cancelled.status === 200, [
    `status = ${cancelled.body?.status ?? '—'}`,
    `auto_renew = ${String(cancelled.body?.auto_renew)}`,
    `current_period_end = ${cancelled.body?.current_period_end ?? '—'}`,
  ]);

  const config = await stub('/__config');
  const call = config.editUserStarSubscription?.last ?? null;
  check('стаб Bot API получил editUserStarSubscription', config.editUserStarSubscription?.count >= 1, [
    `count = ${String(config.editUserStarSubscription?.count)}`,
    `last = ${JSON.stringify(call)}`,
  ]);
  check(
    'параметры вызова: правильный user_id, charge_id последнего платежа, is_canceled',
    call?.user_id === USER_ID &&
      call?.telegram_payment_charge_id === payment.chargeId &&
      call?.is_canceled === true,
    [
      `user_id = ${String(call?.user_id)} (ожидалось ${USER_ID})`,
      `telegram_payment_charge_id = ${String(call?.telegram_payment_charge_id)} (оплата ${payment.chargeId})`,
      `is_canceled = ${String(call?.is_canceled)}`,
    ],
  );

  const after = await api('/me');
  const afterSub = after.body?.subscription ?? {};
  check(
    'в /me: auto_renew false, cancelled_at заполнен, доступ тот же',
    afterSub.auto_renew === false &&
      typeof afterSub.cancelled_at === 'string' &&
      afterSub.is_active === true &&
      afterSub.expires_at === beforeSub.expires_at &&
      JSON.stringify(after.body?.entitlements ?? {}) === beforeAccess,
    [
      `auto_renew = ${String(afterSub.auto_renew)}`,
      `cancelled_at = ${String(afterSub.cancelled_at)}`,
      `is_active = ${String(afterSub.is_active)}`,
      `expires_at = ${afterSub.expires_at} (было ${beforeSub.expires_at})`,
      `entitlements не изменились = ${JSON.stringify(after.body?.entitlements ?? {}) === beforeAccess}`,
    ],
  );

  console.log('\n4. Повтор\n');

  const beforeRepeat = config.editUserStarSubscription?.count ?? 0;
  const repeat = await cancel(USER_ID, `qa-test-1-repeat-${Date.now()}`);
  const afterRepeat = (await stub('/__config')).editUserStarSubscription?.count ?? 0;
  check('повтор → 409 already_cancelled', repeat.status === 409 && repeat.body?.details?.reason === 'already_cancelled', [
    `status = ${repeat.status}`,
    `reason = ${repeat.body?.details?.reason ?? '—'}`,
  ]);
  check('второго вызова в Bot API нет', afterRepeat === beforeRepeat, [
    `вызовов было ${beforeRepeat}, стало ${afterRepeat}`,
  ]);

  console.log('\n5. Сбой Bot API на отмене (второй пользователь)\n');

  const failingPay = await pay('test_1', FAILING_USER_ID);
  check('второй пользователь оплатил test_1', failingPay.paid?.status === 200, [
    `charge_id = ${failingPay.chargeId ?? '—'}`,
  ]);

  await stub('/__config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fail: { editUserStarSubscription: { status: 500 } } }),
  });

  const broken = await cancel(FAILING_USER_ID, `qa-test-1-failed-${Date.now()}`);
  check('отмена при сбое Bot API → 502 telegram_error', broken.status === 502, [
    `code = ${broken.body?.code ?? '—'}`,
    `reason = ${broken.body?.details?.reason ?? '—'}`,
  ]);

  const afterBroken = await api('/me', { userId: FAILING_USER_ID });
  check(
    'после 502 подписка всё ещё «продлится»',
    afterBroken.body?.subscription?.auto_renew === true &&
      (afterBroken.body?.subscription?.cancelled_at ?? null) === null,
    [
      `auto_renew = ${String(afterBroken.body?.subscription?.auto_renew)}`,
      `cancelled_at = ${JSON.stringify(afterBroken.body?.subscription?.cancelled_at ?? null)}`,
    ],
  );

  // Стаб возвращаем в норму: иначе следующий прогон начнётся со сломанного.
  await stub('/__config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fail: {} }),
  });

  console.log('\n6. Метрики\n');

  const metrics = await api('/admin/metrics');
  check('метрики отмены растут', (metrics.body?.subscription_cancel_total_24h ?? 0) >= 1, [
    `subscription_cancel_total_24h = ${String(metrics.body?.subscription_cancel_total_24h)}`,
    `subscription_cancel_failed_24h = ${String(metrics.body?.subscription_cancel_failed_24h)}`,
    `subscription_cancel_no_charge_id_24h = ${String(metrics.body?.subscription_cancel_no_charge_id_24h)}`,
    `subscriptions_auto_renew_off = ${String(metrics.body?.subscriptions_auto_renew_off)}`,
    `subscriptions_cancelled_pending_telegram = ${String(metrics.body?.subscriptions_cancelled_pending_telegram)}`,
  ]);

  console.log(`\nИтог: ${results.length - failures}/${results.length} проверок пройдено`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('прогон упал:', error);
  process.exitCode = 1;
});
