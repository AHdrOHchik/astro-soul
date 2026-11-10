import { z } from 'zod';

/**
 * Валидация окружения на старте: сервис не поднимается с неполным конфигом.
 * Ни одно значение не логируется (в логах — только имена отсутствующих переменных).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Токен бота: из него выводится ключ HMAC для initData. */
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'TELEGRAM_BOT_TOKEN обязателен'),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8).optional(),

  /** Перец для детерминированного UUID пользователя (не ПДн, но секрет). */
  PSEUDONYM_PEPPER: z.string().min(32, 'PSEUDONYM_PEPPER: минимум 32 байта'),

  /** fallback — до покупки коммерческой лицензии Swiss Ephemeris (AGPL). */
  ASTRO_ENGINE: z.enum(['fallback', 'swisseph']).default('fallback'),
  ASTRO_SERVICE_URL: z.string().url().optional(),

  APPLICATION_VERSION: z.string().min(1).default('0.1.0'),
});

export type AppEnv = z.infer<typeof envSchema>;

export const APP_ENV = Symbol('APP_ENV');

export class EnvValidationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Некорректное окружение: ${missing.join(', ')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'ENV');
    throw new EnvValidationError([...new Set(fields)]);
  }

  return parsed.data;
}
