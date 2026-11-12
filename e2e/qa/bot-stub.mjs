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
 *   POST /__config                 — {fail: {method: 'refundStarPayment'}} заставить метод упасть
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 8091);
const LOG = '/tmp/bot-stub.log';

/** @type {{method: string, body: any, at: number}[]} */
const calls = [];
/** @type {Record<string, string>} */
let failures = {};
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
    if (url.pathname === '/__config' && req.method === 'POST') {
      try {
        failures = JSON.parse(raw || '{}').fail ?? {};
      } catch {
        failures = {};
      }
      return json(res, 200, { ok: true, failures });
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

    if (failures[method] !== undefined) {
      return json(res, 200, { ok: false, description: failures[method], error_code: 400 });
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
        return json(res, 200, { ok: true, result: true });
      case 'getMe':
        return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'qa_bot' } });
      default:
        return json(res, 200, { ok: false, description: `method ${method} not stubbed` });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`bot-stub listening on 127.0.0.1:${PORT}\n`);
});
