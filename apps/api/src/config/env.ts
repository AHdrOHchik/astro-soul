import { z } from 'zod';
import { DEFAULT_LLM_MODEL, LLM_MODEL_IDS, llmModelSpec } from './llm-models';

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
  /**
   * Таймаут запроса к Nominatim. `geo.md`: 2 с — дольше ждать подсказку
   * бессмысленно, фронт всё равно ушёл дальше.
   */
  GEO_NOMINATIM_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),
  /** Политика Nominatim: не больше одного запроса в секунду на процесс. */
  GEO_NOMINATIM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
  /** Сколько живёт ответ Nominatim в кэше (`geo.md`: 24 часа). */
  GEO_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),
  /**
   * Порог доверия к поясу «по ближайшему городу». Дальше него пояс не
   * подставляем: неверный пояс сдвигает время рождения на часы.
   */
  GEO_TZ_MAX_DISTANCE_KM: z.coerce.number().int().min(10).max(2_000).default(300),
  /**
   * Сколько кандидатов из справочника считается достаточным ответом. Меньше —
   * идём в Nominatim (фолбэк): «нашлось одно созвучие» — это ещё не город.
   */
  GEO_MIN_LOCAL_CANDIDATES: z.coerce.number().int().min(1).max(10).default(3),

  /**
   * Границы поиска городов (итерация 21). Раньше эти четыре числа лежали в
   * `packages/shared/src/geo/limits.ts` — то есть в коде, который уезжал и в
   * клиент. Теперь они здесь, и клиент узнаёт два нужных ему числа из
   * `GET /me` (`limits`), а не из своей копии: копия разошлась бы с сервером,
   * и человек получал бы `422` на длине, которую интерфейс считает нормой.
   *
   * Значения по умолчанию — те же, что были в коде (2/120/5/10): прод без
   * правки `.env` после обновления ведёт себя ровно как раньше.
   */
  GEO_MIN_QUERY_LENGTH: z.coerce.number().int().min(1).max(100).default(2),
  GEO_MAX_QUERY_LENGTH: z.coerce.number().int().min(1).max(500).default(120),
  /** Сколько кандидатов отдавать, если `limit` не передан. */
  GEO_DEFAULT_LIMIT: z.coerce.number().int().min(1).max(50).default(5),
  /** Потолок `limit`: больше — молча зажимаем до этого числа. */
  GEO_MAX_LIMIT: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Redis для кэша геоподсказок. Не задан — кэш в памяти процесса (и это
   * видно в логе `geo_cache_unavailable`): поиск работает, но кэш не общий.
   */
  REDIS_URL: z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional()),

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
  /**
   * Владелец (итерация 8, вопрос 4): `GIGACHAT_API_PERS`. Значение по умолчанию,
   * чтобы для запуска хватало одного ключа авторизации.
   */
  GIGACHAT_SCOPE: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(2).default('GIGACHAT_API_PERS')),
  /**
   * Путь к CA-бандлу НУЦ Минцифры. TLS-проверка не отключается никогда:
   * нет файла — сервис не ходит в провайдера и пишет, что именно проверить.
   */
  GIGACHAT_CA_BUNDLE: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional()),

  /**
   * Модель разбора. Версия входит в имя: она же пишется в `reports.model`,
   * и по ней же берётся цена токена (`config/llm-models.ts`).
   */
  LLM_MODEL: z.string().min(2).default(DEFAULT_LLM_MODEL),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(1400),
  /** Время на один вызов провайдера: разбор не должен висеть минутами. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  /**
   * Потолок расходов на LLM в месяц, рубли — **два раздельных** (итерация 10).
   *
   * Общий лимит смешивал две разные экономики: разбор стоит ~23–30 ₽ и
   * продаётся разово, прогноз — ~1,2–1,6 ₽ и генерируется каждый день всем
   * подписчикам. При общем лимите ночные прогнозы съедали бюджет разборов,
   * то есть деньги на уже проданный товар.
   *
   * `LLM_MONTHLY_CAP_RUB_REPORT` — разборы; `..._FORECAST` — прогнозы и
   * «спроси карту». Упереться в прогнозный лимит при 2000 ₽: ~1280 прогнозов
   * в месяц при цене Max 0,65 ₽/1k (≈42 подписчика на 30 дней) или ~1660 при
   * Ultra (≈55). Дальше джоб пишет `skipped` и не генерирует.
   */
  LLM_MONTHLY_CAP_RUB_REPORT: z.coerce.number().min(0).default(2000),
  LLM_MONTHLY_CAP_RUB_FORECAST: z.coerce.number().min(0).default(2000),
  /**
   * Потолок на один разбор, рубли.
   * Владелец (итерация 8, вопрос 1): 80 ₽. Оценка разбора ~23 ₽, с
   * перегенерациями ~30 ₽; 80 ₽ — «две с половиной попытки». При 149 ⭐
   * выручки маржа остаётся даже в худшем случае.
   */
  LLM_REPORT_CAP_RUB: z.coerce.number().min(0).default(80),
  /**
   * Подставной провайдер вместо GigaChat: включается сам, когда ключей нет,
   * и честно пишется в логах и в ответе. Нужен для разработки и тестов.
   */
  LLM_FAKE: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['0', '1']).optional()),

  /**
   * Автовозврат звёзд за неудавшийся разбор (джоб `report_refund`).
   *
   * Решение владельца (итерация 17, вопрос 2): автовозврата нет. Код джоба
   * оставлен, но по умолчанию выключен — «выключить флагом, а не удалять
   * молча», чтобы возврат можно было включить осознанно на стенде.
   * `'1'` — джоб возвращает звёзды за `failed`-разборы, `'0'` — не трогает
   * ничего (разбор остаётся `failed`, поддержка решает вручную).
   */
  REFUND_ON_REPORT_FAILED: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['0', '1']).default('0'),
  ),

  /**
   * Тестовые тарифы (`test_1` за 1 ⭐, payments.md §1.1). По умолчанию
   * выключены: при выключенном флаге `POST /billing/invoice` с тестовым
   * `plan_code` отвечает `422`, как будто плана нет.
   *
   * Включать только на стенде и только руками: `check.sh --prod` не даёт
   * запустить прод с этой переменной, а `.env.example` её не подсказывает.
   */
  PAYMENTS_TEST_PLANS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['0', '1']).optional(),
  ),

  /**
   * Circuit breaker разборов (итерация 18).
   *
   * `1` (по умолчанию, единственное допустимое значение в проде) — три провала
   * валидации подряд закрывают приём новых разборов на 30 минут.
   * `0` — брейкер не блокирует запуск: `POST /reports` никогда не отвечает
   * `503 report_breaker_open`. Для ручных прогонов при починке промпта.
   *
   * Мусор (`true`, `2`, пустая строка) — ошибка окружения на старте, а не
   * молчаливый дефолт: флаг защиты бюджета, который «сам угадал», хуже
   * отсутствующего. Пустая строка именно поэтому не превращается в `1`:
   * `REPORT_BREAKER_ENABLED=` в `.env` — это опечатка, а не «как обычно».
   *
   * Выключается ровно отказ в запуске: лимит попыток, валидаторы, лимиты
   * стоимости и окно 30 минут остаются на месте.
   */
  REPORT_BREAKER_ENABLED: z.enum(['0', '1'], {
    errorMap: () => ({ message: "REPORT_BREAKER_ENABLED: допустимо только '0' или '1'" }),
  }).default('1'),

  /**
   * Circuit breaker совместимости (итерация 23) — **свой** флаг и свой счётчик.
   *
   * Общий с разбором брейкер означал бы, что четыре плохих раздела
   * совместимости закрывают продажу разборов, и наоборот: разные промпты,
   * разные модели поведения, разные причины. Поэтому счётчик считает только
   * `kind = 'compat'`, а флаг выключает ровно отказ в запуске.
   */
  COMPAT_BREAKER_ENABLED: z.enum(['0', '1'], {
    errorMap: () => ({ message: "COMPAT_BREAKER_ENABLED: допустимо только '0' или '1'" }),
  }).default('1'),

  /**
   * Потолок стоимости одной совместимости, рубли (решение владельца: 0,5 ₽ за
   * 1000 знаков; четыре раздела — это ~1,5 ₽ текста, 25 ₽ — «полторы попытки
   * всех разделов» с запасом). Потолок на разбор (`LLM_REPORT_CAP_RUB`) сюда
   * не подходит: 80 ₽ на товар за 249 ⭐ — это работа в убыток.
   */
  LLM_COMPAT_CAP_RUB: z.coerce.number().min(0).default(25),

  APPLICATION_VERSION: z.string().min(1).default('0.1.0'),
}).superRefine((value, ctx) => {
  // Цена токена берётся из таблицы моделей: неизвестная модель — это не
  // «0 ₽ за токен», а ошибка конфигурации, и лучше упасть на старте.
  if (llmModelSpec(value.LLM_MODEL) === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_MODEL'],
      message: `LLM_MODEL: нет цены для модели (${LLM_MODEL_IDS.join(', ')})`,
    });
  }

  // Границы геопоиска проверяются вместе: по отдельности каждая верна, а
  // вместе они дают «минимум больше максимума» — тогда поиск не работает
  // никогда. Ошибка называет переменную, которую надо править, а не «конфиг».
  if (value.GEO_MAX_QUERY_LENGTH < value.GEO_MIN_QUERY_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GEO_MAX_QUERY_LENGTH'],
      message: `GEO_MAX_QUERY_LENGTH: должен быть не меньше GEO_MIN_QUERY_LENGTH (${String(value.GEO_MIN_QUERY_LENGTH)})`,
    });
  }

  if (value.GEO_MAX_LIMIT < value.GEO_DEFAULT_LIMIT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GEO_MAX_LIMIT'],
      message: `GEO_MAX_LIMIT: должен быть не меньше GEO_DEFAULT_LIMIT (${String(value.GEO_DEFAULT_LIMIT)})`,
    });
  }
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
