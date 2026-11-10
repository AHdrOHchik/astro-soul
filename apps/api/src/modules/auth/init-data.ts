import { createHmac, timingSafeEqual } from 'node:crypto';
import { unauthorized } from '../../common/api-error';

/**
 * Валидация Telegram WebApp initData (SPEC «Технические рамки»):
 * HMAC-SHA256 с ключом HMAC_SHA256("WebAppData", botToken),
 * auth_date не старше 24 часов, сравнение подписи — timing-safe.
 *
 * Других способов авторизации нет: JWT в localStorage не используется.
 */

export const INIT_DATA_HEADER = 'X-Telegram-Init-Data';
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Допустимое расхождение часов клиента и сервера. */
const CLOCK_SKEW_SECONDS = 60;

export interface TelegramInitUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
  readonly is_premium?: boolean;
}

export interface VerifiedInitData {
  /** Telegram user id. Наружу не отдаётся и в логи не попадает. */
  readonly telegramUserId: bigint;
  readonly user: TelegramInitUser;
  readonly authDate: number;
  readonly queryId: string | undefined;
}

export type InitDataRejection =
  | 'empty'
  | 'malformed'
  | 'missing_hash'
  | 'signature_mismatch'
  | 'auth_date_missing'
  | 'auth_date_invalid'
  | 'auth_date_too_old'
  | 'auth_date_in_future'
  | 'user_missing'
  | 'user_malformed';

export class InitDataError extends Error {
  constructor(readonly reason: InitDataRejection) {
    super(`initData отклонён: ${reason}`);
    this.name = 'InitDataError';
  }
}

export interface VerifyInitDataOptions {
  /** Для тестов: фиксированное «сейчас» в unix-секундах. */
  readonly nowSeconds?: number;
  readonly maxAgeSeconds?: number;
}

function toApiError(error: InitDataError): never {
  // Причина уходит в details.reason и в лог: она не содержит ПДн.
  throw unauthorized({ reason: error.reason, details: { reason: error.reason } });
}

/**
 * Проверяет подпись и срок жизни initData.
 * Бросает ApiError(UNAUTHORIZED) — наружу отдаётся единый формат ошибки.
 */
export function verifyInitData(
  rawInitData: string | undefined,
  botToken: string,
  options: VerifyInitDataOptions = {},
): VerifiedInitData {
  try {
    return verify(rawInitData, botToken, options);
  } catch (error) {
    if (error instanceof InitDataError) {
      toApiError(error);
    }
    throw error;
  }
}

function verify(
  rawInitData: string | undefined,
  botToken: string,
  options: VerifyInitDataOptions,
): VerifiedInitData {
  if (rawInitData === undefined || rawInitData.trim() === '') {
    throw new InitDataError('empty');
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(rawInitData);
  } catch {
    throw new InitDataError('malformed');
  }

  const providedHash = params.get('hash');
  if (providedHash === null || providedHash === '') {
    throw new InitDataError('missing_hash');
  }

  // data_check_string: все пары кроме hash, отсортированные по ключу.
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(providedHash.toLowerCase(), 'utf8');

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new InitDataError('signature_mismatch');
  }

  const authDateRaw = params.get('auth_date');
  if (authDateRaw === null || authDateRaw === '') {
    throw new InitDataError('auth_date_missing');
  }

  const authDate = Number(authDateRaw);
  if (!Number.isInteger(authDate) || authDate <= 0) {
    throw new InitDataError('auth_date_invalid');
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS;

  if (authDate - nowSeconds > CLOCK_SKEW_SECONDS) {
    throw new InitDataError('auth_date_in_future');
  }

  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new InitDataError('auth_date_too_old');
  }

  const userRaw = params.get('user');
  if (userRaw === null || userRaw === '') {
    throw new InitDataError('user_missing');
  }

  const user = parseUser(userRaw);

  return {
    telegramUserId: BigInt(user.id),
    user,
    authDate,
    queryId: params.get('query_id') ?? undefined,
  };
}

function parseUser(raw: string): TelegramInitUser {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InitDataError('user_malformed');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new InitDataError('user_malformed');
  }

  const candidate = parsed as Record<string, unknown>;
  const id = candidate['id'];

  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new InitDataError('user_malformed');
  }

  const pickString = (key: string): string | undefined => {
    const value = candidate[key];
    return typeof value === 'string' ? value : undefined;
  };

  return {
    id,
    ...(pickString('first_name') === undefined ? {} : { first_name: pickString('first_name') }),
    ...(pickString('last_name') === undefined ? {} : { last_name: pickString('last_name') }),
    ...(pickString('username') === undefined ? {} : { username: pickString('username') }),
    ...(pickString('language_code') === undefined
      ? {}
      : { language_code: pickString('language_code') }),
    ...(candidate['is_premium'] === true ? { is_premium: true } : {}),
  };
}

/** Имя для показа в `Me.display_name`: только из проверенного initData. */
export function displayNameOf(user: TelegramInitUser): string | null {
  const parts = [user.first_name, user.last_name].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length === 0 ? null : parts.join(' ');
}
