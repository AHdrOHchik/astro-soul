/**
 * QA-стенд: стаб Telegram Bot API.
 *
 * Зачем свой, а не авторский `apps/api/test/fake-telegram.ts`:
 * QA проверяет поведение сервера, поэтому стаб обязан фиксировать всё, что
 * сервер отправил наружу (метод, тело, время), и отдавать то, что QA сам
 * задал. Никакой логики продукта здесь нет.
 *
 * Запуск: node e2e/qa/bot-stub.mjs [port]
 * Управление:
 *   GET  /__calls                  — журнал вызовов Bot API
 *   POST /__calls/reset            — очистить журнал
 *   GET  /__config                 — что сейчас задано
 *   POST /__config                 — {fail: {method: 'refundStarPayment'}} заставить метод упасть
 *
 * `fail` умеет три формы (QA-003/004 — нужны для пуша):
 *   {fail: {sendMessage: 'текст'}}                     → 200 {ok:false, description}
 *   {fail: {sendMessage: {status: 403}}}               → HTTP 403 (бот заблокирован)
 *   {fail: {sendMessage: {status: 429, retryAfter: 5}}} → HTTP 429 + retry-after
 *   {fail: {sendMessage: {byChat: {'<id>': 403}}}}     → адресно по chat_id, остальным — ok
 *
 * Отмена автопродления (`editUserStarSubscription`, итерация 12): по умолчанию
 * `{ok:true, result:true}`. Адресный отказ — по `charge_id`:
 *   {fail: {editUserStarSubscription: {byCharge: {'<charge>': 'CHARGE_ID_INVALID'}}}}
 *   {fail: {editUserStarSubscription: {status: 500}}}
 * `GET /__config` показывает счётчик вызовов и последние параметры: по ним
 * проверяется, что сервер передал правильную пару (user_id, charge_id).
 *
 * Вебхук (`setWebhook`, `getWebhookInfo`, `deleteWebhook`) — итерация 25:
 * API при старте сверяет `getWebhookInfo` с ожидаемым адресом и при
 * расхождении регистрирует вебхук заново. Стаб хранит это состояние и умеет
 * изображать «старый домен» и «очередь не доставляется»:
 *   POST /__config {webhook: {url: 'https://old.example/...', pending_update_count: 42,
 *                             last_error_message: 'Wrong response from the webhook: 403 Forbidden'}}
 * `GET /__config` показывает `webhook` — по нему проверяется, что API
 * действительно перерегистрировал адрес.
 *
 * Совместимость: без `/__config` стаб отвечает 200 `{ok:true}` на всё, как
 * раньше; старые прогоны (`acceptance-002.mjs`) не знают про статусы и
 * продолжают работать.
 *
 * Почему статус, а не только `ok:false`: `TelegramClient.sendPush` различает
 * «бот заблокирован» и «слишком часто» именно по HTTP-статусу, и на 200/ok:false
 * обе ветки (`push_blocked_at`, `pushes_deferred`) недостижимы.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 8091);
const LOG = '/tmp/bot-stub.log';

/** @type {{method: string, body: any, at: number}[]} */
const calls = [];
/** @type {Record<string, unknown>} */
let failures = {};

/**
 * Состояние вебхука: `getWebhookInfo` отдаёт его как есть. Пустой `url` —
 * «вебхук не зарегистрирован», ровно тот случай, из-за которого Telegram
 * не присылает `pre_checkout_query`.
 */
let webhook = {
  url: '',
  secret_token: null,
  pending_update_count: 0,
  last_error_message: null,
  last_error_date: null,
};
let invoiceSeq = 0;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function record(method, body) {
  calls.push({ method, body, at: Date.now() });
  writeFileSync(LOG, JSON.stringify(calls, null, 2));
}

/** Ответ с заданным HTTP-статусом: только так воспроизводятся 403 и 429. */
function forced(res, status, retryAfter = 30) {
  if (status === 429) {
    res.setHeader('retry-after', String(retryAfter));
    return json(res, 429, {
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    });
  }
  if (status === 403) {
    return json(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  }
  return json(res, status, { ok: false, description: `qa forced failure ${status}`, error_code: status });
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/__calls' && req.method === 'GET') {
      return json(res, 200, calls);
    }
    if (url.pathname === '/__calls/reset' && req.method === 'POST') {
      calls.length = 0;
      failures = {};
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__config' && req.method === 'GET') {
      const cancels = calls.filter((call) => call.method === 'editUserStarSubscription');
      return json(res, 200, {
        failures,
        calls: calls.length,
        webhook,
        editUserStarSubscription: {
          count: cancels.length,
          last: cancels.at(-1)?.body ?? null,
        },
      });
    }
    if (url.pathname === '/__config' && req.method === 'POST') {
      let parsed = {};
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        parsed = {};
      }
      failures = parsed.fail ?? {};
      // `webhook` — «изобразить старый домен / недоставленную очередь».
      if (parsed.webhook !== undefined && parsed.webhook !== null) {
        webhook = { ...webhook, ...parsed.webhook };
      }
      return json(res, 200, { ok: true, failures, webhook });
    }

    // /bot<token>/<method>
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!match) {
      return json(res, 404, { ok: false, description: 'not a bot api path' });
    }

    const token = match[1];
    const method = match[2];
    let body = {};
    try {
      body = raw === '' ? {} : JSON.parse(raw);
    } catch {
      body = { raw };
    }
    record(method, body);

    const failure = failures[method];
    if (failure !== undefined) {
      // Адресный отказ: один прогон проверяет 403 и 429 на разных чатах.
      const perChat = /** @type {{byChat?: Record<string, number>}} */ (failure).byChat;
      if (perChat !== undefined) {
        const status = perChat[String(body.chat_id)];
        if (status !== undefined) return forced(res, status);
        return json(res, 200, { ok: true, result: true });
      }
      // Адресный отказ по платежу: один прогон проверяет успех и
      // CHARGE_ID_INVALID на разных charge_id.
      const byCharge = /** @type {{byCharge?: Record<string, string>}} */ (failure).byCharge;
      if (byCharge !== undefined) {
        const code = byCharge[String(body.telegram_payment_charge_id)];
        if (code !== undefined) {
          return json(res, 200, { ok: false, error_code: 400, description: `Bad Request: ${code}` });
        }
        return json(res, 200, { ok: true, result: true });
      }
      if (typeof failure === 'object' && failure !== null && 'status' in failure) {
        const spec = /** @type {{status: number, retryAfter?: number}} */ (failure);
        return forced(res, Number(spec.status), spec.retryAfter);
      }
      return json(res, 200, { ok: false, description: failure, error_code: 400 });
    }

    switch (method) {
      case 'createInvoiceLink':
        invoiceSeq += 1;
        return json(res, 200, {
          ok: true,
          result: `https://t.me/$qa_bot?invoice=qa-${invoiceSeq}&token=${token.length}`,
        });
      case 'answerPreCheckoutQuery':
      case 'sendMessage':
      case 'refundStarPayment':
      case 'editUserStarSubscription':
        return json(res, 200, { ok: true, result: true });
      case 'getMe':
        return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'qa_bot' } });
      case 'getWebhookInfo':
        return json(res, 200, {
          ok: true,
          result: {
            url: webhook.url,
            has_custom_certificate: false,
            pending_update_count: webhook.pending_update_count,
            last_error_date: webhook.last_error_date,
            last_error_message: webhook.last_error_message,
            max_connections: 40,
            allowed_updates: ['message', 'pre_checkout_query'],
          },
        });
      case 'setWebhook': {
        // Bot API принимает и form-urlencoded, и JSON: API шлёт JSON, curl из
        // инструкции — форму. Стаб понимает оба, иначе «проверка на стабе»
        // расходится с живым поведением.
        let params = body;
        if (typeof body === 'object' && body !== null && typeof body.raw === 'string') {
          params = Object.fromEntries(new URLSearchParams(body.raw));
        }
        webhook = {
          url: typeof params.url === 'string' ? params.url : '',
          secret_token: typeof params.secret_token === 'string' ? params.secret_token : null,
          // Регистрация вебхука на живом Bot API сбрасывает ошибки доставки.
          pending_update_count: 0,
          last_error_message: null,
          last_error_date: null,
        };
        return json(res, 200, { ok: true, result: true });
      }
      case 'deleteWebhook':
        webhook = { ...webhook, url: '', secret_token: null, pending_update_count: 0 };
        return json(res, 200, { ok: true, result: true });
      default:
        return json(res, 200, { ok: false, description: `method ${method} not stubbed` });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`bot-stub listening on 0.0.0.0:${PORT}\n`);
});
