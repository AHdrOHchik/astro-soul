# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Добавлено

#### Итерация 7: контракт 1.4.0, платежи и эксплуатация

- Контракт **1.4.0**: единый `ChartResponse` (`chart`, `mini_reading`,
  `warnings`, `wheel_url`, `wheel_png_url`, `is_restored`) из `POST /charts`
  (201 и 200), `GET /charts/{chart_id}` и `GET /charts/current`; `GET
  /charts/current` с `404` для онбординга; `200` на повторный `POST /charts`
  с `is_restored: true`; `Me.entitlements` и `Me.chart_id`;
  `size=1080|1600` у `wheel.png`; `limit` в `POST /geo/resolve` вне 1…10 →
  `422`; `x-events-forbidden-prop-keys` (16 ключей); `x-bot.share_link_template`.
- `ChartResponse.warnings`: коды `no_birth_time`, `approximate_time`,
  `approximate_place`; считаются на входе и хранятся в `charts.warnings`
  (миграция `0008`), карты до 1.4.0 отдают `[]`.
- `GET /api/v1/charts/current` — последняя карта пользователя; `Me.chart_id`
  указывает туда же.
- `POST /api/v1/charts` возвращает `201` при создании и `200` при повторе
  (идемпотентность по `(user_id, input_hash)`).
- `Me.entitlements` — реальные права из `getEntitlements(userId)` (snake_case,
  как у остальных полей ответа).
- `GET /api/v1/admin/metrics` (только `ADMIN_TG_ID`): MAU, платящие,
  конверсия, churn за 30 дней, звёзды, упавшие разборы, счётчики событий и
  воронка — всё по `events.occurred_at` (`COALESCE(occurred_at, created_at)`).
- `POST /api/v1/internal/jobs/run` (секрет `X-Jobs-Secret`): джоб
  `subscription_downgrade` (истёкшие подписки + одно сообщение «продлить?»
  не чаще раза в 30 дней) и автовозврат звёзд за недоставленный товар
  (`payments.processed = false` дольше 10 минут).
- `/start chart_<id>` в вебхуке: бот отвечает кнопкой «Открыть карту» на
  мини-апп с `startapp=chart_<id>` (`BOT_USERNAME`, `MINI_APP_URL`).
- `wheel.png`: `size` только `1080` или `1600`, иначе `422`.
- `deploy/nginx.miniapp.conf`: `index.html` — `no-cache`, `/assets/*` —
  `immutable`; без этого после смены версии согласия остаётся старый бандл.

#### Итерация 5: контракт 1.3.0

- Контракт **1.3.0**: `POST /geo/resolve` — минимум 2 символа (`422` ниже),
  `503 GEO_NOT_FOUND` с `details.reason` (`provider_timeout | provider_unavailable |
  not_configured`), правило возраста (18 лет в 00:00 UTC дня рождения,
  29 февраля → 1 марта), приём только актуальной версии согласия,
  `POST /api/v1/events` (батч до 20, `202`, `x-analytics-events` из 21 события),
  `GET /api/v1/charts/{id}/wheel.png` и `ChartResponse.wheel_png_url`.
- `POST /api/v1/events`: закрытый список событий, `props` без ПДн (такие события
  отбрасываются), клиентское время в `events.occurred_at` (миграция `0007`),
  батч пишется одним запросом.
- `GET /charts/{id}/wheel.png`: растеризация колеса через `sharp` для шаринга
  (по умолчанию 1080 px), та же подпись `?sig=`, публичный маршрут.
- Колесо SVG: весь текст — векторные контуры (`astro/glyphs.py`), ни `<text>`,
  ни `font-family`; маркеры планет несут градус внутри и раскладываются по
  дорожкам без наездов, подпись «время неизвестно» вынесена под колесо.
- `CONSENT_VERSION` в окружении (по умолчанию `2026-11-10`).
- Тест `init-data.spec.ts` больше не зависит от реальных часов
  (`vi.useFakeTimers` на фиксированном мгновении).

#### Фронт, итерация 3: контракт 1.3.0, тексты владельца, продуктовые события

- **web:** юридические тексты из `legal-texts-2026-11-10.md`, дословно: на
  Welcome — дисклеймер и строка под кнопкой, которая открывает соглашение; экран
  согласия с кнопкой «Не сейчас» (возврат на Welcome, введённое стирается); два
  экрана документов с версией текста. Версия согласия прежняя, `2026-11-10`.
- **web:** отказ сервера по `consent.version`: приложение перезагружается за
  новой сборкой и открывается на экране согласия с пустой галочкой и строкой
  «Условия обновились, подтверди ещё раз.» Если сборка та же — экран с кнопкой
  «Обновить приложение», без повторной перезагрузки. Через перезагрузку
  переносится только отклонённая версия (`sessionStorage`), данные рождения — нет.
- **web:** продуктовые события в `POST /events`: путь от запуска до карты, шаги
  назад, поиск места, отказы сервера, «Поделиться». Пачками, без повторов, без
  введённых данных: у свойств четыре ключа, значения — из закрытых списков.
- **web:** «Поделиться картой» отправляет PNG колеса (`wheel_png_url`); ссылка
  на SVG осталась запасным вариантом.
- **web:** поиск места начинается с двух символов; границы длины запроса взяты
  из `@astro-soul/shared`, как на сервере.
- **web:** мок API отвечает по контракту 1.3.0: `POST /events`, `wheel.png`,
  сценарий отказа по версии согласия (`Версионово`,
  `API_MOCK_CONSENT_VERSION`), `details.reason` у `503`.
- **web:** тест-охранник юридических текстов сверяет приложение с файлом
  текстов; хеш версии `2026-11-10` пересчитан. Новый тест сверяет имена событий
  и ключи их свойств с контрактом.
- **ui:** `Notice` принимает `id`, `ScreenHeading` — `describedBy`: заголовок
  экрана можно связать с пояснением для экранных читалок.

#### Фронт, итерация 2: согласие на обработку данных и контракт 1.2.1

- **web:** экран согласия на обработку персональных данных между Welcome и
  шагом даты. Текст — дословно `legal.md` (раздел 2); галочка по умолчанию не
  стоит, без неё «Продолжить» неактивна. Ссылки из текста открывают экраны
  документов внутри приложения: «Что мы собираем и зачем» (раздел 1) и
  дисклеймер (раздел 3).
- **web:** `POST /charts` по контракту 1.2.1: `consent {accepted, version}` и
  `time_precision`. Версия согласия — константа `CONSENT_VERSION` (дата текста).
  Без отметки пользователя запрос не собирается.
- **web:** отказ сервера по полям (`422`, `details.field_errors`): приложение
  возвращает на экран отклонённого поля, показывает у поля текст сервера и
  ставит на него фокус.
- **web:** поиск места по контракту 1.2.1: `200` с пустым списком — «ничего не
  нашли», `503 GEO_NOT_FOUND` — ошибка с повтором.
- **web:** предупреждение о точности на экране карты берётся из
  `chart.birth.time_precision`; у карт без этого поля — из `time_known`.
- **web:** тест-охранник юридических текстов: тексты согласия и документов в
  `i18n/ru.ts` совпадают с `legal.md`, а версия согласия меняется вместе с
  текстом.
- **web:** мок API отвечает по контракту 1.2.1; добавлены сценарии отказа по
  каждому полю и недоступного справочника мест, см. `apps/web/README.md`.
- **ui:** `Checkbox` — нативный флажок в виде крупной строки, с состоянием
  ошибки; иконки `CheckIcon` и `DocumentIcon`.

Изменено в этой же итерации:

- **web:** `pnpm lint` и `pnpm typecheck` снова проходят на `apps/web`: после
  контракта 1.2.1 они падали (6 ошибок типов, 11 ошибок линта).
- **web:** проверка 18+ на шаге даты считает день по UTC, как `apps/api`.
  Раньше она считала по дню устройства: в часы, когда даты различаются, сервер
  отклонял дату уже после всей формы.
- **web:** `pnpm build` собирает продакшен-бандл при любом `NODE_ENV`. С
  `NODE_ENV=test`, как в CI, в бандл попадала отладочная сборка React:
  147 кБ gzip вместо 93.
- **web:** ответ без тела `Problem`: статус 409 читается как `CONFLICT`, а
  «голый» 400 больше не считается ошибкой ввода — API его не использует.
- **ui:** у прокручиваемой области `Screen` появился нижний отступ прокрутки:
  сообщение об ошибке больше не останавливается под затенением над кнопкой.
- **web:** блок ошибки поиска места прокручивается в видимую область. На
  экране 320×568 от него был виден только значок: заголовок, текст и кнопка
  повтора оставались ниже края экрана.

#### Итерация 4: контракт 1.2.1 — разблокировка фронта

- Контракт **1.2.1**: `VALIDATION_FAILED` всегда 422 (400 в API не используется),
  `FieldError` и `details.field_errors[{field, message}]`, описание жёсткого
  соответствия кодов и статусов, `ChartResponse` для `GET /charts/{id}`,
  `consent` и `time_precision` в `ChartCreateRequest`, `Chart.birth.time_precision`,
  `POST /geo/resolve` — всегда `200` и массив, `503 GEO_NOT_FOUND` только при
  недоступном провайдере.
- `POST /geo/resolve`: локальный справочник на 149 городов
  (`packages/shared/src/geo`), нормализация «ё»/регистра/алиасов, поиск с 3 символов,
  `limit` ≤ 10, лимит маршрута 120/мин, Nominatim только как opt-in фолбэк.
- `POST /charts`: обязательное согласие (`profiles.consent_at`, `consent_version`),
  `time_precision` → `profiles.time_mode`, проверка 18+, «не раньше 1900»,
  существование часового пояса — всё на сервере, с `field_errors` по полям.
- `GET /charts/{id}` отдаёт тот же конверт, что и `POST /charts`
  (`{chart, mini_reading, wheel_url}` со свежей подписью).
- Лимиты запросов: `RateLimitMiddleware` (60/мин, 10 на создание карты, 120 на гео),
  заголовки `RateLimit-*` и `Retry-After`.
- Единый формат ошибок: тексты на «ты» из `i18n/ru.ts`, неизвестный маршрут и
  неверный метод больше не отдают английский текст фреймворка.
- Миграция `0006`: `profiles.time_accuracy` → `time_mode`
  (значение `approx` → `approximate`), добавлен `consent_version`.
- Node `engines` → `>=22.22.2 <23`, `vitest` в `api`/`shared` поднят до 5.1.0
  (в lock-файле больше нет двух мажорных версий).

### Изменено

- `apps/web`: только перегенерированные типы контракта (`schema.gen.d.ts`).

#### Итерация 3: карты, колесо, платежи, удаление данных

- Контракт **1.2.0**: OpenAPI 3.1 (`type: [X, 'null']` вместо `nullable`),
  `Problem.code += CONFLICT`, `Chart.omitted_planets`, `astro` в `/health`,
  описание `422`/`429`/`500` у инвойсов и вебхука.
- `packages/shared`: типы контракта генерируются `openapi-typescript`
  (`pnpm gen:contracts`); `typecheck` падает, если типы разъехались с контрактом.
- `packages/astro`: HTTP-сайдкар `astro/service.py` (FastAPI + uvicorn) —
  `GET /health`, `POST /chart`, `POST /transits`, `POST /wheel`; темы колеса
  `dark`/`light`; `astro/wire.py` для сборки карты обратно из `charts.data`.
- `apps/api`: `AstroClient` (таймаут 2 с, недоступность → `503 INTERNAL`),
  `GET /health` показывает `astro` и `degraded`.
- `apps/api`: `POST /charts` (валидация 18+, идемпотентность по
  `(user_id, input_hash)`), `GET /charts/{id}`, публичный
  `GET /charts/{id}/wheel.svg?sig=&theme=` с HMAC-подписью на 30 дней.
- `apps/api`: платежи Stars — `POST /billing/invoice` (антифрод 3/час, 10/сутки,
  повтор плана в пределах 5 минут отдаёт ту же ссылку), вебхук
  `POST /internal/telegram/webhook/{secret}` (`pre_checkout_query`,
  `successful_payment` одной транзакцией с блокировкой по charge_id),
  `GET /billing/subscription`, возвраты `refundStarPayment` с отзывом доступа.
- `apps/api`: `DELETE /me` — каскад по `users`, `profiles`, `charts`, `reports`,
  `forecasts`, `asks`, `quotas`; платежи остаются без `telegram_id`,
  незавершённый платёж → `409 CONFLICT`.
- Миграция `0005`: `invoices.chart_id`, снят `entitlements_compat_has_partner`.
- `geo.md`: справочник городов в репозитории, `tz` обязателен, Nominatim только
  как opt-in фолбэк; `POST /charts` от геоданных не зависит.
- CI `.github/workflows/ci.yml`: линт, типы, тесты, миграции и
  `docker compose config -q` (проверка compose-файла без docker-демона).

### Изменено

- `AGENTS.md`: ветку выдаёт среда, размер PR не ограничен, контракт живёт
  в `api.openapi.yaml`, ссылки на удалённые `contracts/` и `docs/` убраны.
- `apps/web`: только перегенерированные типы контракта плюс код `CONFLICT`
  в словарях ошибок (без него `typecheck` фронта не собирался).

### Ограничения

- Docker в песочнице недоступен: локально Postgres поднимался бинарниками,
  `docker-compose` не запускался (в CI проверяется только `config -q`).
- Реальный Bot API не вызывался: платежи проверены на подменённом клиенте
  и локальном стабе `api.telegram.org`.

- Каркас pnpm-монорепо: `package.json`, `pnpm-workspace.yaml`, общий
  `tsconfig.base.json`, ESLint flat config с правилами, требующими типов,
  `docker-compose.yml` (Postgres 16 + Redis 7), `.env.example`, `.gitignore`.
- `packages/shared`: типы контракта (`Me`, `SubscriptionState`, `Quota`,
  `Problem`, `HealthResponse`), единственный источник цен `plans.ts`
  (`payments.md` §1), `Entitlements` и вывод квот из них.
- Миграции `0001_core_users`, `0002_astro`, `0003_billing`, `0004_events`:
  `users`, `profiles`, `charts`, `reports`, `forecasts`, `asks`, `plans`,
  `invoices`, `payments`, `subscriptions`, `entitlements`, `quotas`, `events`.
- Раннер миграций с advisory lock и checksum (`apps/api/src/db/migrate.ts`),
  сид планов из `plans.ts` (`apps/api/src/db/seed-plans.ts`).
- `verifyInitData`: HMAC-SHA256, `auth_date` ≤ 24 ч, timing-safe сравнение;
  middleware на всех `/api/v1/*` кроме `/health`; `GET /api/v1/me`,
  `GET /api/v1/health`.
- Единый формат ошибок `application/problem+json`, `request_id` в ответе и
  логах, JSON-логи с вырезанием ПДн-полей.

- `packages/astro` — порт прототипа `astro/engine.py` в Python-пакет:
  `calcChart`, `transitsFor`, `llmContext`, `renderWheel`, `hashInput`, CLI,
  режимы `ASTRO_ENGINE=fallback|swisseph` (Moshier / файлы `.se1`), 34 теста
  на pytest, включая проверку вывода по схеме контракта. Аспекты в контракте —
  по ключам планет, `balances` — проценты, в SVG нет персональных данных.
- **web:** Mini App, итерация 1 — экраны Welcome (дисклеймер 18+ виден без
  прокрутки), BirthDate (проверка 18+), BirthTime («точно» / «примерно» /
  «не знаю» с предупреждением о точности), BirthPlace (поиск с 3 символов,
  часовой пояс берётся из места) и Chart (колесо, карточки Солнца, Луны и
  Асцендента, тизер полного разбора с ценой из `@astro-soul/shared`,
  «Поделиться»). У экранов есть состояния загрузки, пустого результата и
  ошибки. Без времени рождения карта строится, Асцендент и дома помечаются как
  нерассчитанные.
- **web:** клиент API по `api.openapi.yaml`: типы генерируются из контракта,
  `pnpm typecheck` и `pnpm build` падают при расхождении. Вход — только по
  `initData` в заголовке `X-Telegram-Init-Data`. Ошибки разбираются по
  `Problem.code`; `Problem.message` показывается, только если это русский
  текст, `request_id` виден на экране ошибки.
- **web:** обёртка над `@telegram-apps/sdk`: системная кнопка «Назад», цвета
  клиента, запрет закрытия свайпом, «Поделиться». Если SDK не принимает
  параметры запуска, приложение всё равно входит по `initData`.
- **web:** мок API для разработки (`API_MOCK=1`) со сценариями ошибок, см.
  `apps/web/README.md`.
- **web:** проверка бандла при сборке: лимит 350 кБ gzip из `SPEC.md` и
  отсутствие dev-переменных в `dist/`.
- **web:** тест-охранник дизайн-системы: значения только из токенов темы, вся
  кириллица только в `src/i18n/`, без CSS, которого нет в старых WebView.
- **ui:** пакет `@astro-soul/ui` — UI-кит на дизайн-токенах, базовый
  `tsconfig` фронтенда и слой правил ESLint для `apps/web` и `packages/ui`
  (`strictTypeChecked`, React Hooks), который подключён в корневой
  `eslint.config.mjs`: линт остаётся один на весь монорепо.

### Изменено

- `api.openapi.yaml` 1.0.0 → 1.1.0: `Chart.asc`, `Chart.mc`, `Chart.houses`
  теперь могут быть `null` (неизвестное время рождения — требование `SPEC.md`);
  уточнены `Aspect.a`/`Aspect.b` (ключи планет) и единицы `Chart.balances`
  (проценты). Структура ответов не менялась, поля добавлены не были.

### Известные ограничения

- Хирон не рассчитывается в fallback-режиме: нужен файл `seas_18.se1` из
  Swiss Ephemeris. До его подключения (и до решения по лицензии) в разборе
  нет Хирона.
- Транспорт между `apps/api` (NestJS) и `packages/astro` (Python) не выбран:
  решается вместе с `POST /charts`. Сейчас движок доступен как библиотека и CLI.
- Rate-limit (60/10 req/мин) и `DELETE /me` — следующие итерации.
- Покупка полного разбора не подключена: кнопка в тизере называет цену, но
  неактивна.
- Вернувшийся пользователь вводит данные рождения заново: `GET /me` не отдаёт
  идентификатор карты (#5).
- Экрана настроек в Mini App нет, а текст согласия из `legal.md` обещает
  «Настройки → «Удалить мои данные»».
- На настоящих клиентах Telegram Mini App не запускался: проверен в headless
  Chromium с моком и с локальным `apps/api`. Список ручных проверок — в
  `apps/web/README.md`.
