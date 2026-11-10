import { createHmac } from 'node:crypto';

/**
 * Тестовая подпись initData тем же алгоритмом, что и Telegram:
 *   secret = HMAC_SHA256("WebAppData", botToken)
 *   hash   = HMAC_SHA256(secret, data_check_string)
 * Используется только в тестах: фикстуры вымышленные (AGENTS.md §8).
 */

export interface SignInitDataOptions {
  readonly botToken: string;
  readonly user: Record<string, unknown>;
  /** unix-секунды; по умолчанию «сейчас» */
  readonly authDate?: number;
  readonly queryId?: string;
}

export function signInitData(options: SignInitDataOptions): string {
  return signFields(options.botToken, {
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    ...(options.queryId === undefined ? {} : { query_id: options.queryId }),
    user: JSON.stringify(options.user),
  });
}

/** Подпись произвольного набора полей — для негативных сценариев. */
export function signFields(botToken: string, rawFields: Record<string, string>): string {
  const fields = rawFields;

  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return new URLSearchParams({ ...fields, hash }).toString();
}
