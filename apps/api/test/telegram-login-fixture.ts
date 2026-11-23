import { createHash, createHmac } from 'node:crypto';

/**
 * Подпись Telegram Login Widget для тестов — по тому же алгоритму, что в
 * `modules/admin-auth/telegram-login.ts`:
 * `secret = SHA256(bot_token)`, `HMAC_SHA256(secret, data_check_string)`.
 *
 * Считается здесь независимо, а не импортом из продакшн-кода: если алгоритм
 * поменяют в одном месте, тест обязан упасть, а не подстроиться.
 */
export function signTelegramLogin(
  fields: Readonly<Record<string, string | number>>,
  botToken: string,
): Record<string, string> {
  const pairs = Object.entries(fields).map(([key, value]) => [key, String(value)] as const);
  const dataCheckString = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken, 'utf8').digest();
  const hash = createHmac('sha256', secret).update(dataCheckString, 'utf8').digest('hex');

  return { ...Object.fromEntries(pairs), hash };
}

/** Набор полей «как из виджета»: id строкой, имя и фамилия, время подписи. */
export function telegramLoginPayload(
  options: {
    readonly id: string | number;
    readonly botToken: string;
    readonly nowSeconds?: number;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly username?: string;
  },
): Record<string, string | number> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  return signTelegramLogin(
    {
      id: options.id,
      auth_date: now,
      first_name: options.firstName ?? 'Владелец',
      last_name: options.lastName ?? 'Панели',
      username: options.username ?? 'admin_owner',
    },
    options.botToken,
  );
}
