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

  /**
   * Регистрировать вебхук при старте API (`telegram-webhook.service.ts`).
   *
   * По умолчанию включено: адрес собирается из `MINI_APP_URL` и секрета, а
   * расхождение с `getWebhookInfo` чинится автоматически. `0` — адрес
   * регистрирует кто-то снаружи, сервис только проверяет и пишет в лог.
   */
  TELEGRAM_WEBHOOK_AUTO: z.enum(['0', '1']).default('1'),

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

  /**
   * Срок жизни сессии админ-панели (итерация 40). 12 часов — «один рабочий
   * день»: за это время админ успевает всё, а забытая на чужом ноутбуке
   * сессия не живёт до следующей недели.
   */
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),

  /**
   * `Secure` у cookie сессии. В проде — только `true`: cookie с идентификатором
   * админа по http не должна уезжать вовсе. В песочнице и на `http://localhost`
   * браузер её иначе не сохранит, поэтому там `false` (см. docs/ADMIN.md).
   */
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),

  /**
   * Порог блокировки входа в панель: не больше N неудач за окно с одного IP.
   * Считаем **неудачи**, а не запросы: успешный вход обнуляет счётчик, иначе
   * дежурный, ошибшийся паролем/виджетом десять раз за неделю, закрыл бы себе
   * вход окончательно.
   */
  ADMIN_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
  ADMIN_LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

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

  // ── Прогноз дня и «спроси карту» (итерация 30, контракт 1.6.6) ──────────
  //
  // Решения приняты владельцем и меняются конфигом, а не правкой кода. Ни одно
  // значение ниже не повторяется в бизнес-логике: сервисы читают `env`.
  /**
   * Прогноз дня целиком — по подписке. `0` — отдавать без подписки (стенд).
   */
  FORECAST_REQUIRES_SUBSCRIPTION: z
    .enum(['0', '1'], {
      errorMap: () => ({ message: "FORECAST_REQUIRES_SUBSCRIPTION: допустимо только '0' или '1'" }),
    })
    .default('1'),
  /**
   * Без подписки — одна детерминированная строка (знак Луны и фаза), **без
   * вызова модели**. `0` — не показывать ничего, только закрытый экран.
   */
  FORECAST_FREE_FACTS: z
    .enum(['0', '1'], {
      errorMap: () => ({ message: "FORECAST_FREE_FACTS: допустимо только '0' или '1'" }),
    })
    .default('1'),
  /**
   * Потолок на один прогноз дня, рубли. Один вызов модели на 900–1400 знаков
   * стоит ~1,1 ₽; 3 ₽ — «вызов с запасом и одна перегенерация».
   */
  LLM_DAILY_FORECAST_CAP_RUB: z.coerce.number().min(0).default(3),
  /** Сколько вопросов в сутки можно задать подписчику (по местной дате). */
  QUESTION_DAILY_LIMIT: z.coerce.number().int().min(0).default(3),
  /**
   * Вопросы без подписки. Решение владельца: нет (`403 subscription_required`).
   * `1` — разрешить (стенд, ручная проверка).
   */
  QUESTION_FOR_NON_SUBSCRIBERS: z
    .enum(['0', '1'], {
      errorMap: () => ({ message: "QUESTION_FOR_NON_SUBSCRIBERS: допустимо только '0' или '1'" }),
    })
    .default('0'),
  /** Потолок на один ответ, рубли: 550–950 знаков — это ~0,7 ₽, 3 ₽ с запасом. */
  LLM_QUESTION_CAP_RUB: z.coerce.number().min(0).default(3),
  /**
   * Дневной потолок расходов на вопросы одного человека, рубли. При исчерпании
   * — `429`, а не молчание: человек должен понимать, что лимит на сегодня.
   */
  LLM_QUESTION_DAILY_CAP_RUB: z.coerce.number().min(0).default(15),
  /**
   * Версии промптов — отдельные от разбора и совместимости: одна версия на все
   * продукты означала бы «правка прогноза пересчитывает разборы».
   */
  /**
   * Таймаут генерации прогноза, миллисекунды. Решение владельца — 25 с: за это
   * время GigaChat успевает, а HTTP-запрос не держится дольше разумного.
   * Вынесено в окружение ради тестов: 25 с в тесте — это 25 с ожидания.
   */
  FORECAST_TIMEOUT_MS: z.coerce.number().int().min(100).default(25_000),
  /**
   * Пауза перед повтором после провала или таймаута, секунды (решение
   * владельца — 60). Она же — порог «строка `pending` повисла»: пока она не
   * прошла, второй запрос ждёт, а не генерирует заново.
   */
  FORECAST_RETRY_SECONDS: z.coerce.number().int().min(1).default(60),
  PROMPT_VERSION_FORECAST: z.string().min(1).default('prompts_v1.0'),
  PROMPT_VERSION_QUESTION: z.string().min(1).default('prompts_v1.0'),
  /**
   * Версия астро-движка, которой считаются факты дня. 1.1.0 — сайдкар получил
   * `POST /forecast/facts`. Старые прогнозы не пересчитываются: у строки своя
   * версия.
   */
  ENGINE_VERSION: z.string().min(1).default('1.1.0'),

  // ── PDF и карточки шеринга (итерация 32, контракт 1.6.8) ─────────────────
  //
  // Файлы лежат в приватном хранилище, публичных ссылок нет: API подписывает
  // адрес на время и проверяет подпись при скачивании. Отсюда три переменные
  // ниже — где лежит, чем подписывать и какой у ссылки TTL.
  /**
   * Каталог приватного хранилища. Он не отдаётся статикой ни одним сервером:
   * единственный вход к файлам — `GET /api/v1/files/{key}` с подписью.
   * По умолчанию `var/storage` рядом с процессом (в `.gitignore`).
   */
  FILE_STORAGE_DIR: z.string().min(1).default('var/storage'),
  /**
   * Ключ подписи ссылок. Не задан — выводится из `PSEUDONYM_PEPPER` с
   * отдельной меткой: подпись работает «из коробки», но ротация перца
   * инвалидирует старые ссылки, а это и так допустимо (они живут 24 часа).
   * Отдельная переменная нужна, чтобы можно было менять подпись без перца.
   */
  // ── Бренд на карточках сторис (итерация 37, контракт 1.6.12) ─────────────
  //
  // Имя продукта на карточке — не username бота и не «Astro Soul по
  // умолчанию»: значение определяет владелец. Не задано — карточки-сторис не
  // создаются вовсе (`503 brand_name_missing`), потому что безымянная
  // карточка в чужой ленте не находится и не узнаётся.
  BRAND_NAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).max(60).optional(),
  ),
  /**
   * Подсказка для поиска в нижней безопасной зоне: «ищи в Telegram: …».
   * Точная строка — решение владельца; не задана — собирается из `BRAND_NAME`
   * («ищи в Telegram: <имя>»), чтобы подсказка не выдумывала чужой бренд.
   */
  BRAND_SEARCH_HINT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).max(80).optional(),
  ),
  /**
   * Файл-маркер последнего успешного бэкапа (`scripts/db-dump.sh`).
   *
   * Не задан — алерт `backup_stale` в `/admin/alerts` стреляет как «не знаем,
   * делаются ли бэкапы»: молчание здесь было бы равно «всё хорошо», а это
   * неправда. В проде файл пишется скриптом дампа после успешной выгрузки.
   */
  // ── Утренний пуш 08:00 (итерация 38, контракт 1.6.13) ─────────────────────
  //
  // По умолчанию **выключен**: включается одновременно с `VITE_NOTIFICATIONS_UI=1`
  // после пересборки web (порядок выпуска — `docs/PUSH.md`). Фронт-флаг запекается
  // при сборке, бэкенд читается в рантайме, поэтому «включить оба» — две разные
  // процедуры, и их легко перепутать.
  //
  // `0` — планировщик не запускается вовсе (не «запускается и молчит»): иначе
  // `/health` показывал бы живого планировщика у выключенной функции.
  PUSH_ENABLED: z.enum(['0', '1']).default('0'),

  /**
   * Час отправки по поясу рождения. 8 — «доброе утро» до работы; менять только
   * осознанно: текст сообщения начинается с «Доброе утро» именно из-за него.
   */
  PUSH_SEND_HOUR: z.coerce.number().int().min(0).max(23).default(8),

  /**
   * Ширина окна отправки в минутах, начиная с `PUSH_SEND_HOUR:00`.
   *
   * Планировщик просыпается каждую минуту, но тик может опоздать (деплой, GC,
   * ретрай). Пять минут — запас: человек, у которого 08:00 попало на паузу,
   * всё равно получит сообщение в 08:04. Дальше окна пуш не догоняется: лучше
   * пропустить день, чем прислать «доброе утро» в обед.
   */
  PUSH_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

  /** Размер порции: сколько получателей берём за один проход по БД. */
  PUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),

  BACKUP_STATE_FILE: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),

  /**
   * Настройки выгрузки для `scripts/db-dump.sh` (итерация 43).
   *
   * Скрипт читал их из окружения и раньше — здесь они появляются в схеме,
   * потому что теперь их читает **и API**: `POST /admin/backup/run` обязан
   * сказать «не настроено» (`503`), а не «сделалось», если выгрузки нет.
   * Секретов тут нет: у S3 креденшелы живут в `~/.aws`/роли, у `scp` — в
   * `~/.ssh`, а в переменных только адреса и каталоги.
   */
  /**
   * Сколько **неудачных** активаций кода в час допускается на человека (1.6.17).
   *
   * 10 — «ошибся пару раз и ввёл правильно» проходит, а перебор — нет. Счётчик
   * снимается успешной активацией (см. `code-activation-throttle.service.ts`).
   */
  CODE_ACTIVATION_MAX_FAILURES: z.coerce.number().int().min(1).max(100).default(10),

  BACKUP_DIR: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  BACKUP_S3_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  BACKUP_REMOTE: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  /**
   * Путь к скрипту дампа. По умолчанию — `scripts/db-dump.sh` монорепо.
   *
   * Нужен для тестов (и для нестандартной раскладки в проде): тест подставляет
   * настоящий скрипт с поддельными `pg_dump`/`aws` в `PATH` и проверяет порядок
   * «файл → выгрузка → маркер» на живом `db-dump.sh`, а не на его копии.
   */
  BACKUP_SCRIPT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  FILE_SIGNING_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(16).optional(),
  ),
  /** Сколько живёт подписанная ссылка, секунды. Решение владельца: 24 часа. */
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(86_400),
  /**
   * Публичный адрес API для подписанных ссылок. Пусто — ссылка собирается
   * относительно (`/api/v1/files/...`): мини-апп ходит на тот же origin. Для
   * бота и внешних получателей адрес обязателен.
   */
  PUBLIC_API_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  /** Потолок размера PDF, байты (решение владельца — 12 МБ). */
  PDF_MAX_BYTES: z.coerce.number().int().min(64_000).default(12 * 1024 * 1024),
  /**
   * Таймаут сборки PDF в сайдкаре. 5–15 с — нормальное время, 60 с — потолок:
   * дольше держать HTTP-запрос бессмысленно, сборка идёт в фоне.
   */
  PDF_BUILD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),

  // ── Бесплатный доступ по праву (итерация 39, контракт 1.6.14) ────────────
  //
  // Здесь **нет** ни одной цены продукта: цены живут в `plans` (итерация 23).
  // Переменные ниже — себестоимость и границы, а не витрина.
  /**
   * Месячный бюджет бесплатного доступа, рубли. Решение владельца: 15 000 ₽.
   *
   * Считается по себестоимости уже выданных прав за текущий календарный месяц:
   * дни доступа × дневная себестоимость + израсходованные одноразовые права.
   * Бюджет не трогает проданное: исчерпанный бюджет отказывает только в **новых**
   * грантах (`503 bonus_budget_exhausted`), действующие права продолжают
   * работать — иначе человек, получивший месяц за приглашённого друга, потерял
   * бы его из-за чужих подарков.
   *
   * `0` — бюджет исчерпан всегда (стенд «как будто денег нет»); отрицательное
   * значение запрещено: «минус бюджет» — это не «выключено».
   */
  BONUS_BUDGET_RUB: z.coerce.number().min(0).default(15_000),
  /**
   * Дневная себестоимость доступа «всё включено», рубли (для бюджета).
   *
   * Оценка по факту: полный прогноз (~1,1 ₽) + ответы на вопросы (~0,7 ₽ × 3)
   * при среднем использовании ≈ 3,2 ₽/день; 5 ₽ — с запасом на «человек
   * спрашивает каждый день». Не цена для человека и не в витрине: это то,
   * сколько стоит подарить день доступа.
   */
  BONUS_DAY_COST_RUB: z.coerce.number().min(0).default(5),
  /**
   * Себестоимость одного бесплатного разбора, рубли (оценка из `LLM_REPORT_CAP_RUB`:
   * ~30 ₽ с перегенерациями). Одноразовые права списываются по этой цене в
   * бюджет в момент выдачи.
   */
  BONUS_REPORT_COST_RUB: z.coerce.number().min(0).default(30),

  /**
   * Курс звезды в рублях — **только для управленческой оценки** упущенной
   * выручки в `/admin/metrics` (`grants_revenue_lost_rub_24h`).
   *
   * Не цена продукта и нигде не показывается человеку: цены живут в `plans` и
   * меняются через `pnpm plans:set-price`. Значение по умолчанию — 1: консервативно,
   * «звезда ≈ рубль», чтобы оценка потерь не выглядела драматичнее, чем есть.
   */
  STAR_RATE_RUB: z.coerce.number().min(0).default(1),

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
