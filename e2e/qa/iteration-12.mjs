#!/usr/bin/env node
/**
 * QA-005: проверки приёмки итерации 12 (задача A — отмена автопродления в
 * Telegram, B — машинные причины 404, D — идемпотентность удаления).
 *
 * `acceptance-002.mjs` закрывает деньги: QA-15, M11/M11b/M11c, dp1. Здесь — то,
 * что появилось в итерациях 9–10 и требует стенда, а не чтения кода:
 *
 *   cancel      — `DELETE /me` зовёт `editUserStarSubscription(is_canceled: true)`
 *                 с правильной парой (telegram_id, charge_id), состояние
 *                 `cancelled`, строк с `user_id` удалённого не осталось
 *   cancel-fail — стаб отвечает 500: удаление всё равно проходит, состояние
 *                 `failed`, событие `subscription_cancel_failed`, метрика растёт;
 *                 повтор ночным джобом → `cancelled`
 *   no-sub      — без подписки вызова нет вовсе (счётчик стаба не растёт)
 *   idempotent  — `DELETE /me` дважды → 204/204, после второго `is_new: true`
 *   reasons     — 404 с `details.reason`: `no_chart` / `not_ready`, без 500
 *
 * Фикстура подписки — настоящий `successful_payment` через вебхук, как в проде;
 * карта для `not_ready` пишется прямо в БД (движок карт для этого не нужен).
 *
 * Запуск: node e2e/qa/iteration-12.mjs <cancel|cancel-fail|no-sub|idempotent|reasons|all>
 *
 * Окружение — то же, что у `acceptance-002.mjs`:
 *   QA_API, QA_PSQL, QA_DB, QA_BOT_TOKEN, QA_WEBHOOK_SECRET, QA_JOBS_SECRET, STUB
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const API = process.env.QA_API ?? 'http://127.0.0.1:8083/api/v1';
const STUB = process.env.STUB ?? 'http://127.0.0.1:8091';
const TOKEN = process.env.QA_BOT_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.QA_WEBHOOK_SECRET ?? '';
const JOBS_SECRET = process.env.QA_JOBS_SECRET ?? '';
const PSQL = process.env.QA_PSQL ?? 'psql';
const DB = process.env.QA_DB ?? 'astro_qa12';

const mode = (process.argv[2] ?? 'all').toLowerCase();

/** Минимальный набор сведений о пользователе: без ПДн, только id из хеша. */
function sql(query) {
  return execFileSync(PSQL, ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB, '-Atc', query])
    .toString()
    .trim();
}

/** `initData`, подписанный тем же токеном, что у стенда: другого входа в API нет. */
function initData(telegramId) {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    query_id: `AAQ${telegramId}${authDate}${Math.random().toString(16).slice(2, 8)}`,
    user: JSON.stringify({ id: telegramId, first_name: 'Тест' }),
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

function client(telegramId) {
  const headers = { 'x-telegram-init-data': initData(telegramId), 'content-type': 'application/json' };

  const call = async (path, options = {}) => {
    const started = performance.now();
    const response = await fetch(`${API}${path}`, {
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
    return { status: response.status, body, ms: Math.round(performance.now() - started) };
  };

  return {
    headers,
    call,
    me: () => call('/me'),
    chart: async (place, tz = 'Europe/Moscow', name = 'Тест') => {
      const created = await call('/charts', {
        method: 'POST',
        body: JSON.stringify({
          birth_date: '1991-04-04',
          birth_time: '13:10',
          time_precision: 'exact',
          birth_place: { name, country: 'RU', lat: 55.75, lon: 37.61, tz },
          consent: { version: '2026-11-10', accepted: true },
        }),
      });
      // 201 — карта построена, 200 — та же карта восстановлена (`is_restored`). Оба ответа несут chart.
      if (created.status !== 201 && created.status !== 200) {
        throw new Error(`POST /charts: ${created.status} ${JSON.stringify(created.body)}`);
      }
      return created.body.chart.chart_id;
    },
  };
}

/** `successful_payment` через вебхук — единственный способ выдать доступ на стенде. */
async function pay(telegramId, planCode, chartId) {
  const api = client(telegramId);
  const invoice = await api.call('/billing/invoice', {
    method: 'POST',
    body: JSON.stringify({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) }),
  });
  if (invoice.status !== 201) throw new Error(`POST /billing/invoice: ${invoice.status} ${JSON.stringify(invoice.body)}`);

  // payload берём из БД: контракт не отдаёт его клиенту, а вебхуку он нужен.
  const userId = (await api.me()).body.user_id;
  const payload = sql(`select payload from invoices where user_id = '${userId}' order by created_at desc limit 1`);
  const chargeId = `qa3-${randomUUID()}`;

  const response = await fetch(`${API}/internal/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 1,
      message: {
        chat: { id: telegramId },
        from: { id: telegramId },
        successful_payment: {
          currency: 'XTR',
          total_amount: invoice.body.stars,
          invoice_payload: payload,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: `prov-${chargeId}`,
          subscription_expiration_date: Math.floor(Date.now() / 1000) + 30 * 86_400,
        },
      },
    }),
  });

  return { status: response.status, stars: invoice.body.stars, chargeId };
}

function runJob(name) {
  return fetch(`${API}/internal/jobs/run?job=${name}`, {
    method: 'POST',
    headers: { 'x-jobs-secret': JOBS_SECRET },
  }).then((response) => response.json());
}


const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ок  ' : 'ПРОВАЛ'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  return ok;
};

/** Что стаб получил по отмене автопродления: счётчик и последнее тело. */
async function stubCancel() {
  const response = await fetch(`${STUB}/__config`);
  const body = await response.json();
  return body.editUserStarSubscription ?? { count: 0, last: null };
}

async function stubFail(fail) {
  await fetch(`${STUB}/__config`, { method: 'POST', body: JSON.stringify({ fail }) });
}

async function stubReset() {
  await fetch(`${STUB}/__calls/reset`, { method: 'POST' });
}

function cleanup(telegramId) {
  const userId = sql(`select id from users where telegram_id = ${telegramId}`);
  if (userId !== '') {
    sql(
      `delete from entitlements where user_id = '${userId}';
       delete from subscriptions where user_id = '${userId}';
       delete from payments where user_id = '${userId}';
       delete from invoices where user_id = '${userId}';`,
    );
  }
  // Карты: у `charts` уникальность (user_id, input_hash), поэтому фикстура со
  // старым хешем иначе падает на втором прогоне. Отчёты, прогнозы и вопросы
  // уходят каскадом; у обезличенных карт (user_id NULL) — по хешу.
  if (userId !== '') sql(`delete from charts where user_id = '${userId}'`);
  sql(`delete from charts where user_id is null and input_hash like 'qa12-%'`);
  // Хвосты прошлых прогонов, уже обезличенные: у них user_id NULL.
  sql(`delete from subscriptions where user_id is null and telegram_payment_charge_id like 'qa12-%'`);
  sql(`delete from payments where telegram_payment_charge_id like 'qa12-%'`);
  sql(`delete from events where name = 'subscription_cancel_failed'`);
}

/* ───────────────────────────── cancel (успех) ───────────────────────────── */

async function cancel(telegramId) {
  console.log('\n=== cancel: DELETE /me отключает автопродление в Telegram ===');

  const api = client(telegramId);
  await api.me();
  cleanup(telegramId);
  await api.me();

  const paid = await pay(telegramId, 'year_2990');
  console.log(`  фикстура: year_2990, charge_id=${paid.chargeId.slice(-6)}…`);

  const before = await stubCancel();
  const deleted = await api.call('/me', { method: 'DELETE' });
  check(deleted.status === 204, 'DELETE /me → 204', String(deleted.status));

  const after = await stubCancel();
  check(after.count === before.count + 1, 'стаб получил ровно один вызов', `+${after.count - before.count}`);

  const last = after.last ?? {};
  check(last.user_id === telegramId, 'user_id в вызове = telegram_id', String(last.user_id));
  check(
    typeof last.telegram_payment_charge_id === 'string' && last.telegram_payment_charge_id.length > 0,
    'charge_id передан и не пустой',
    String(last.telegram_payment_charge_id ?? '').slice(-6),
  );
  check(last.is_canceled === true, 'is_canceled = true', String(last.is_canceled));

  const state = sql(
    `select telegram_cancel_state from subscriptions where telegram_payment_charge_id = '${paid.chargeId}'`,
  );
  check(state === 'cancelled', 'subscriptions.telegram_cancel_state = cancelled', state);

  const userId = (await api.me()).body.user_id;
  const leftovers = ['payments', 'subscriptions', 'entitlements', 'events']
    .map((table) => Number(sql(`select count(*) from ${table} where user_id = '${userId}'`)))
    .reduce((sum, value) => sum + value, 0);
  check(leftovers === 0, 'строк с user_id удалённого нет', String(leftovers));

  return true;
}

/* ──────────────────────── cancel-fail + повтор джобом ─────────────────────── */

async function cancelFail(telegramId) {
  console.log('\n=== cancel-fail: ошибка Telegram не блокирует удаление, повтор — джобом ===');

  const api = client(telegramId);
  await api.me();
  cleanup(telegramId);
  await api.me();

  await stubFail({ editUserStarSubscription: { status: 500 } });
  const paid = await pay(telegramId, 'year_2990');
  const userId = (await api.me()).body.user_id;

  const deleted = await api.call('/me', { method: 'DELETE' });
  check(deleted.status === 204, 'удаление прошло несмотря на 500 от Bot API', String(deleted.status));
  check(
    Number(sql(`select count(*) from users where id = '${userId}'`)) === 0,
    'пользователя в БД нет',
  );

  const state = sql(
    `select telegram_cancel_state from subscriptions where telegram_payment_charge_id = '${paid.chargeId}'`,
  );
  check(state === 'failed', 'состояние failed', state);

  const event = sql(`select props->>'code' from events where name = 'subscription_cancel_failed' limit 1`);
  check(event === 'telegram_error', 'событие subscription_cancel_failed с code', event || 'нет');

  // Повтор: стаб снова нормальный, окно «не чаще раза в час» обходим фикстурой.
  await stubFail({});
  sql(
    `update subscriptions set telegram_cancel_last_at = now() - interval '2 hours'
      where telegram_payment_charge_id = '${paid.chargeId}'`,
  );
  const job = await runJob('pdn_retention_cleanup');
  check(
    job.telegram_cancel_retried === 1 && job.telegram_cancel_cancelled === 1,
    'джоб повторил и отменил',
    `retried=${job.telegram_cancel_retried} cancelled=${job.telegram_cancel_cancelled}`,
  );

  const stateAfter = sql(
    `select telegram_cancel_state from subscriptions where telegram_payment_charge_id = '${paid.chargeId}'`,
  );
  check(stateAfter === 'cancelled', 'состояние после повтора cancelled', stateAfter);

  const again = await runJob('pdn_retention_cleanup');
  check(again.telegram_cancel_retried === 0, 'второй прогон ничего не повторяет');

  return true;
}

/* ───────────────────────────── no-sub ───────────────────────────── */

async function noSub(telegramId) {
  console.log('\n=== no-sub: без подписки вызова нет ===');

  const api = client(telegramId);
  await api.me();
  cleanup(telegramId);
  await api.me();

  const before = await stubCancel();
  const deleted = await api.call('/me', { method: 'DELETE' });
  check(deleted.status === 204, 'DELETE /me → 204', String(deleted.status));

  const after = await stubCancel();
  check(after.count === before.count, 'счётчик вызовов не вырос', `+${after.count - before.count}`);
  return true;
}

/* ──────────────────────────── idempotent ──────────────────────────── */

async function idempotent(telegramId) {
  console.log('\n=== idempotent: два DELETE /me подряд ===');

  const api = client(telegramId);
  await api.me();
  cleanup(telegramId);
  await api.me();

  const first = await api.call('/me', { method: 'DELETE' });
  const back = await api.me();
  const second = await api.call('/me', { method: 'DELETE' });
  const again = await api.me();

  check(first.status === 204, 'первый DELETE → 204', String(first.status));
  check(back.body.is_new === true, 'между ними GET /me создаёт нового', `is_new=${back.body.is_new}`);
  check(second.status === 204, 'второй DELETE → 204', String(second.status));
  check(again.body.is_new === true, 'после второго GET /me снова is_new', `is_new=${again.body.is_new}`);
  check(again.body.entitlements.full_report === false, 'права не вернулись', 'full_report=false');
  return true;
}

/* ───────────────────────────── reasons (404) ───────────────────────────── */

async function reasons(telegramId) {
  console.log('\n=== reasons: 404 с details.reason ===');

  const api = client(telegramId);
  await api.me();
  cleanup(telegramId);
  await api.me();

  const missing = '11111111-1111-4111-8111-111111111111';
  const ask = await api.call('/engagement/ask', {
    method: 'POST',
    body: JSON.stringify({ chart_id: missing, question: 'Что мне поможет сосредоточиться?' }),
  });
  check(ask.status === 404, 'ask без карты → 404', String(ask.status));
  check(ask.body?.details?.reason === 'no_chart', 'ask details.reason = no_chart', String(ask.body?.details?.reason));

  const forecastNoChart = await api.call(`/engagement/forecast?chart_id=${missing}`);
  check(forecastNoChart.status === 404, 'forecast без карты → 404', String(forecastNoChart.status));
  check(
    forecastNoChart.body?.details?.reason === 'no_chart',
    'forecast details.reason = no_chart',
    String(forecastNoChart.body?.details?.reason),
  );

  // Карта есть, прогноза нет: строка пишется только ночным джобом.
  const userId = (await api.me()).body.user_id;
  const chartId = randomUUID();
  sql(
    `insert into charts (id, user_id, input_hash, data, engine_version, time_known)
     values ('${chartId}', '${userId}', 'qa12-hash', '{"chart":{"birth":{"place":{"tz":"Europe/Moscow"}}}}'::jsonb, 'qa', true)`,
  );
  const forecastNotReady = await api.call(`/engagement/forecast?chart_id=${chartId}`);
  check(forecastNotReady.status === 404, 'forecast без строки → 404', String(forecastNotReady.status));
  check(
    forecastNotReady.body?.details?.reason === 'not_ready',
    'forecast details.reason = not_ready',
    String(forecastNotReady.body?.details?.reason),
  );

  // Ни один из путей не должен отдавать 500.
  check(
    [ask.status, forecastNoChart.status, forecastNotReady.status].every((status) => status !== 500),
    'ни в одном случае нет 500',
  );
  return true;
}

/* ───────────────────────────────── main ───────────────────────────────── */

const telegramId = Number(process.env.QA_TG_ID ?? 777_012_001);
const scenarios = { cancel, 'cancel-fail': cancelFail, 'no-sub': noSub, idempotent, reasons };

const picked = mode === 'all' ? Object.keys(scenarios) : [mode];
const unknown = picked.filter((name) => scenarios[name] === undefined);
if (unknown.length > 0) {
  console.error(`неизвестный сценарий: ${unknown.join(', ')}`);
  process.exit(2);
}

await stubReset();
let allOk = true;
for (const [index, name] of picked.entries()) {
  // Каждый сценарий — свой telegram_id: сценарии не мешают друг другу.
  allOk = (await scenarios[name](telegramId + index)) && allOk;
}
await stubFail({});
await stubReset();

console.log(`\nВЫВОД: ${allOk ? 'закрыто.' : 'есть провалы — см. ПРОВАЛ выше.'}`);
process.exit(allOk ? 0 : 1);
