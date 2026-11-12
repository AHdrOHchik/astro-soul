#!/usr/bin/env node
/**
 * Подпись Telegram WebApp initData по алгоритму из документации:
 *   data_check_string = все пары (кроме hash), отсортированные по ключу, через \n
 *   secret_key        = HMAC_SHA256("WebAppData", bot_token)
 *   hash              = HMAC_SHA256(secret_key, data_check_string)
 *
 * Использование:
 *   node scripts/qa/init-data.mjs --token <bot_token> --user 777000111 \
 *        [--first-name QA] [--auth-date <unix>] [--shift-seconds <n>] [--no-hash]
 *
 * ВАЖНО: только вымышленные пользователи. Токен — тестового бота.
 * Скрипт ничего не пишет в файлы и не логирует токен.
 */
import { createHmac } from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[name] = true;
    } else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (typeof args.token !== 'string' || args.token === '') {
  process.stderr.write('нужен --token <bot_token>\n');
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const authDate =
  typeof args['auth-date'] === 'string'
    ? Number(args['auth-date'])
    : now + Number(typeof args['shift-seconds'] === 'string' ? args['shift-seconds'] : 0);

const user = {
  id: Number(args.user ?? 777_000_111),
  first_name: typeof args['first-name'] === 'string' ? args['first-name'] : 'Тест',
  last_name: typeof args['last-name'] === 'string' ? args['last-name'] : 'Тестов',
  username: 'qa_fictional',
  language_code: 'ru',
};

const fields = {
  query_id: `AAQ${user.id}${authDate}`,
  user: JSON.stringify(user),
  auth_date: String(authDate),
};

const dataCheckString = Object.keys(fields)
  .sort()
  .map((key) => `${key}=${fields[key]}`)
  .join('\n');

const secretKey = createHmac('sha256', 'WebAppData').update(args.token).digest();
const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

const params = new URLSearchParams(fields);
if (args['no-hash'] !== true) {
  params.set('hash', hash);
}

process.stdout.write(params.toString());
