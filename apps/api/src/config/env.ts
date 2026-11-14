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

  /**
   * GigaChat: ключ авторизации (Basic) и параметры OAuth. Статического
   * access_token нет: он живёт 30 минут и берётся по ключу.
   */
  GIGACHAT_AUTH_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(8).optional()),
  GIGACHAT_OAUTH_URL: z.string().url().default('https://ngw.devices.sberbank.ru:9443/api/v2/oauth'),
  GIGACHAT_BASE_URL: z.string().url().default('https://gigachat.devices.sberbank.ru/api/v1'),
  GIGACHAT_SCOPE: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(2).optional()),
  /**
   * Путь к CA-бандлу НУЦ Минцифры. TLS-проверка не отключается никогда:
   * нет файла — сервис не ходит в провайдера и пишет, что именно проверить.
   */
  GIGACHAT_CA_BUNDLE: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional()),

  /** Модель разбора. Версия входит в имя: она же пишется в `reports.model`. */
  LLM_MODEL: z.string().min(2).default('GigaChat-3-Ultra'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(1400),
  /** Время на один вызов провайдера: разбор не должен висеть минутами. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  /**
   * Цена в рублях за 1000 токенов (вход и выход по одной цене — так в блоке
   * владельца). Значение — бизнесовое, поэтому задаётся окружением.
   */
  LLM_PRICE_PER_1K_RUB: z.coerce.number().min(0).default(0.5),
  /** Потолок расходов на LLM в месяц, рубли. */
  LLM_MONTHLY_CAP_RUB: z.coerce.number().min(0).default(1000),
  /**
   * Потолок на один разбор в рублях. Не задан — действует только месячный:
   * отдельного значения владелец не давал, придумывать его нельзя.
   */
  LLM_REPORT_CAP_RUB: z.coerce.number().min(0).optional(),
  /**
   * Подставной провайдер вместо GigaChat: включается сам, когда ключей нет,
   * и честно пишется в логах и в ответе. Нужен для разработки и тестов.
   */
  LLM_FAKE: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['0', '1']).optional()),

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
