import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка подписи Telegram Login Widget для входа в админ-панель.
 *
 * Отличие от `initData` (`modules/auth/init-data.ts`) не косметическое:
 *
 *   • ключ подписи — `SHA256(bot_token)`, а не `HMAC_SHA256("WebAppData", token)`.
 *     Это два разных протокола Telegram, и перепутать их значит «вход не
 *     работает» либо, хуже, «вход работает по чужому секрету»;
 *   • окно — 300 секунд, а не 24 часа: строку входа можно переслать в чат, и
 *     она не должна оставаться ключом на сутки;
 *   • данные проверяются **один раз** на входе, а не на каждом запросе: дальше
 *     доступ даёт сессия из `admin_sessions`.
 *
 * Функция чистая (токен и «сейчас» — аргументы), поэтому проверяется тестами
 * без HTTP и без базы: включая границу «ровно 300 секунд — годен».
 */

/** Окно входа: `auth_date` старше — `401 auth_stale`. Ровно 300 — ещё годен. */
export const ADMIN_LOGIN_MAX_AGE_SECONDS = 300;

/** Допустимое расхождение часов: будущее `auth_date` дальше — считаем протухшим. */
const CLOCK_SKEW_SECONDS = 60;

export type TelegramLoginRejection =
  | 'malformed'
  | 'missing_hash'
  | 'missing_fields'
  | 'invalid_hash'
  | 'auth_stale';

export interface TelegramLoginAccepted {
  readonly ok: true;
  /** Telegram id из подписанного набора. Наружу и в логи не попадает. */
  readonly tgId: bigint;
  /** Снимок имени на момент входа: `first_name last_name`, иначе `username`. */
  readonly name: string;
  readonly authDate: number;
}

export interface TelegramLoginRejected {
  readonly ok: false;
  readonly reason: TelegramLoginRejection;
}

export type TelegramLoginResult = TelegramLoginAccepted | TelegramLoginRejected;

export interface VerifyTelegramLoginOptions {
  /** Для тестов: фиксированное «сейчас» в unix-секундах. */
  readonly nowSeconds?: number;
  readonly maxAgeSeconds?: number;
}

/** Поля виджета приходят снаружи как `unknown`: тело JSON — не доверенный ввод. */
export type TelegramLoginFields = Readonly<Record<string, unknown>>;

function scalar(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  // Числом приходит как минимум `id` и `auth_date`: `JSON.parse` не знает, что
  // это идентификатор, и отдаёт Number. Принимаем обе формы (требование ТЗ),
  // но только безопасные целые: 2^53 уже неоднозначно.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

/** `id` — bigint: Telegram id уже не влезает в int4 и может не влезть в int8 JSON. */
function parseTgId(raw: string | undefined): bigint | null {
  if (raw === undefined || !/^\d{1,20}$/.test(raw)) {
    return null;
  }
  const value = BigInt(raw);
  return value > 0n ? value : null;
}

function safeHexEqual(expected: string, provided: string): boolean {
  // Длину проверяем до timingSafeEqual: при разной длине он бросает исключение,
  // и «битый hash» превратился бы в 500 вместо 401.
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyTelegramLogin(
  fields: TelegramLoginFields,
  botToken: string,
  options: VerifyTelegramLoginOptions = {},
): TelegramLoginResult {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? ADMIN_LOGIN_MAX_AGE_SECONDS;

  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'hash') {
      continue;
    }
    const text = scalar(value);
    if (text === null) {
      return { ok: false, reason: 'malformed' };
    }
    pairs.push([key, text]);
  }

  const hashRaw = fields['hash'];
  const hash = typeof hashRaw === 'string' ? hashRaw.trim().toLowerCase() : '';
  if (hash === '') {
    // Отдельная причина: «виджет не прислал подпись» и «подпись не сошлась» —
    // разные ошибки в логе, и лечатся они по-разному.
    return { ok: false, reason: 'missing_hash' };
  }

  // Пустой токен — не «пропускаем без проверки», а «проверить нечем»:
  // вход закрыт так же, как при неверной подписи.
  if (botToken === '') {
    return { ok: false, reason: 'invalid_hash' };
  }

  const id = parseTgId(pairs.find(([key]) => key === 'id')?.[1]);
  const authDateRaw = pairs.find(([key]) => key === 'auth_date')?.[1];
  if (id === null || authDateRaw === undefined) {
    return { ok: false, reason: 'missing_fields' };
  }
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { ok: false, reason: 'missing_fields' };
  }

  // Порядок важен: подпись проверяем **до** любых выводов о свежести. Иначе
  // подделанный `auth_date` управлял бы веткой ответа (401/500) и давал
  // оракул по содержимому строки.
  const dataCheckString = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken, 'utf8').digest();
  const expected = createHmac('sha256', secret).update(dataCheckString, 'utf8').digest('hex');

  if (!safeHexEqual(expected, hash)) {
    return { ok: false, reason: 'invalid_hash' };
  }

  // `>` а не `>=`: ровно 300 секунд — годен. Это граница из ТЗ, и она
  // проверяется тестом: иначе «300» и «301» отличались бы на глаз, а не в коде.
  if (now - authDate > maxAge || authDate > now + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'auth_stale' };
  }

  const firstNameRaw = fields['first_name'];
  const lastNameRaw = fields['last_name'];
  const usernameRaw = fields['username'];
  const firstName = typeof firstNameRaw === 'string' ? firstNameRaw.trim() : '';
  const lastName = typeof lastNameRaw === 'string' ? lastNameRaw.trim() : '';
  const username = typeof usernameRaw === 'string' ? usernameRaw.trim() : '';
  const full = [firstName, lastName].filter((part) => part !== '').join(' ');
  const name = full !== '' ? full : username !== '' ? username : id.toString();

  return { ok: true, tgId: id, name, authDate };
}
