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
  /** База Bot API: подменяется в тестах, в проде — https://api.telegram.org. */
  TELEGRAM_API_BASE_URL: z.string().url().optional(),

  /** Перец для детерминированного UUID пользователя (не ПДн, но секрет). */
  PSEUDONYM_PEPPER: z.string().min(32, 'PSEUDONYM_PEPPER: минимум 32 байта'),

  /** fallback — до покупки коммерческой лицензии Swiss Ephemeris (AGPL). */
  ASTRO_ENGINE: z.enum(['fallback', 'swisseph']).default('fallback'),
  ASTRO_SERVICE_URL: z.string().url().optional(),

  /** Геоданные: по умолчанию только локальный справочник, без сети (geo.md). */
  GEO_PROVIDER: z.enum(['bundled', 'nominatim']).default('bundled'),
  GEO_NOMINATIM_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  /** Контакт для User-Agent при обращении к Nominatim (требование их политики). */
  // Пустая строка в .env — это «не задано», а не ошибка запуска.
  GEO_CONTACT_EMAIL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().email().optional(),
  ),

  /** Лимиты запросов в минуту (SPEC). 0 — выключить (только для тестов). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(60),
  RATE_LIMIT_CHARTS_PER_MIN: z.coerce.number().int().min(0).default(10),
  RATE_LIMIT_GEO_PER_MIN: z.coerce.number().int().min(0).default(120),

  /**
   * Актуальная редакция согласия на обработку ПДн (контракт 1.3.0).
   * Принимаем только её: устаревшая версия — 422 с field_errors[consent.version],
   * по этому полю фронт сбрасывает галочку и показывает «Условия обновились».
   */
  CONSENT_VERSION: z.string().min(1).max(32).default('2026-11-10'),

  /**
   * Имя бота без `@` — из него собирается ссылка шаринга
   * (`x-bot.share_link_template` в контракте):
   * `https://t.me/{BOT_USERNAME}?startapp=chart_{chart_id}`.
   * Не задано — ссылку не собираем, шаринг остаётся «текстом».
   */
  BOT_USERNAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[A-Za-z0-9_]{4,32}$/, 'BOT_USERNAME: 4–32 символа, буквы/цифры/_')
      .optional(),
  ),

  /**
   * Публичный адрес мини-аппа. По нему бот собирает кнопку «открыть карту»
   * для `/start chart_<id>`; без него бот отвечает ссылкой-шаблоном.
   */
  MINI_APP_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),

  /** Telegram id владельца: единственный, кому доступен `GET /admin/metrics`. */
  ADMIN_TG_ID: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),

  /** Секрет `POST /internal/jobs/run` (крон). Не задан — маршрут закрыт всегда. */
  INTERNAL_JOB_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(8).optional(),
  ),

  /**
   * Контакт поддержки для текстов, где пользователю нужно куда-то написать
   * (`DELETE /me` при неудавшемся возврате). Пустое значение — «не задано»:
   * текст тогда не обещает контакт, а просит написать в поддержку бота.
   */
  SUPPORT_CONTACT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(2).max(64).optional(),
  ),

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
