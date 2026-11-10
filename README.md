# Разбор личности

Telegram Mini App: дата, время и место рождения → натальная карта и персональный
разбор из шести глав, написанный LLM по рассчитанным фактам. Ежедневный прогноз
приходит в бот. Монетизация — Telegram Stars (XTR).

Документы проекта: [`SPEC.md`](./SPEC.md) — что строим, [`payments.md`](./payments.md) —
платежи и подписка, [`api.openapi.yaml`](./api.openapi.yaml) — контракт API
(единственный источник правды), [`AGENTS.md`](./AGENTS.md) — правила работы.

## Выбор языка API: NestJS

**Зафиксировано: `apps/api` — NestJS (TypeScript, Express), решение не меняется.**

Почему не FastAPI:

1. Definition of Done (`AGENTS.md` §2) — это `pnpm install && pnpm build`, `pnpm lint`,
   `pnpm typecheck`. Один инструментальный контур на весь монорепо дешевле, чем два.
2. Цены и состав планов живут в `packages/shared/src/plans.ts` (`payments.md` §1),
   а доступы — в одном `getEntitlements`. Это TypeScript, и его же используют бот и
   фронт. Платежи на Python означали бы дублирование денежной логики на двух языках —
   ровно тот риск, от которого предостерегает `payments.md`.
3. Бот (`apps/bot/src/texts/ru.ts`) и мини-апп (`apps/web`) тоже TypeScript: одна
   модель типов `Me`, `SubscriptionState`, `Quota`, `Entitlements` на все три части.

Астро-движок по `SPEC.md` остаётся Python (`packages/astro`, pyswisseph) и
подключается к API как отдельный локальный сервис (`ASTRO_SERVICE_URL`,
`ASTRO_ENGINE=fallback|swisseph`), поэтому выбор языка API на движок не влияет.

## Структура

```
apps/api/           HTTP API (NestJS): auth, /me, /health, БД, миграционный раннер
apps/bot/           Telegram-бот (следующие итерации)
apps/web/           Mini App (FRONTEND)
packages/shared/    типы контракта, планы и цены, квоты, Entitlements
packages/astro/     астро-движок (Python, pyswisseph): карта, транзиты, SVG, контекст для LLM
packages/ui/        UI-кит (FRONTEND)
migrations/         SQL-миграции, неизменяемые после мерджа
infra/              локальная инфраструктура (инициализация Postgres и т.п.)
```

## Быстрый старт

```bash
cp .env.example .env          # заполнить TELEGRAM_BOT_TOKEN и PSEUDONYM_PEPPER
pnpm install
pnpm setup:astro              # python-пакет движка (pyswisseph, pytest, ruff)
docker compose up -d          # Postgres 16 + Redis 7
pnpm db:migrate               # миграции
pnpm db:seed                  # plans из packages/shared/src/plans.ts
pnpm dev:api                  # http://localhost:8080/api/v1
```

`PSEUDONYM_PEPPER` — случайные 32+ байта. Менять его нельзя: он определяет
внутренний UUID пользователя, и после смены старые подписки и платежи перестанут
быть связаны с человеком.

### Команды

| Команда | Что делает |
|---|---|
| `pnpm build` | сборка всех пакетов |
| `pnpm lint` | ESLint (flat config, правила с типами) |
| `pnpm typecheck` | `tsc --noEmit` во всех пакетах |
| `pnpm test` | сборка + тесты TS (нужна тестовая БД) |
| `pnpm test:astro` | тесты движка (pytest) |
| `pnpm lint:astro` | ruff по `packages/astro` |
| `pnpm check` | всё сразу: lint, typecheck, build, тесты TS и Python |
| `pnpm db:migrate` | накат миграций из `migrations/` |
| `pnpm db:seed` | синхронизация таблицы `plans` |
| `pnpm dev:api` | API в watch-режиме |

Тесты используют `TEST_DATABASE_URL` (по умолчанию
`postgres://astro:astro_local_only@localhost:5432/astro_soul_test`); база
создаётся один раз из `infra/postgres/init-test-db.sql`.

## Соглашения API

- **Авторизация.** Заголовок `X-Telegram-Init-Data` с сырой строкой
  `Telegram.WebApp.initData`. Функция `verifyInitData` проверяет HMAC-SHA256
  (ключ `HMAC_SHA256("WebAppData", botToken)`), `auth_date` не старше 24 часов,
  подпись сравнивается timing-safe. Middleware закрывает все `/api/v1/*`, кроме
  `/health`. Других способов авторизации нет.
- **Ошибки.** Всегда `application/problem+json`:
  `{ code, message (ru), request_id, details? }`. Коды — из контракта
  (`PROBLEM_CODES` в `packages/shared`).
- **`request_id`.** Приходит в заголовке `X-Request-Id` (клиентский принимается,
  если он вида `[A-Za-z0-9._-]{8,64}`, иначе генерируется), дублируется в теле
  ошибки и в каждой строке лога.
- **Логи.** Однострочный JSON в stdout. Не содержат дату/время/место рождения,
  координаты, `telegram_id`, сырой `initData` и тексты разборов — запрещённые
  ключи вырезаются в `common/logger.ts`, а не «по договорённости».
- **Внутренний `user_id`.** Детерминированный UUID:
  `HMAC_SHA256(PSEUDONYM_PEPPER, "telegram:<id>")`. Нужен, чтобы `DELETE /me`
  удалял ПДн (`users`, `profiles`, `charts`, `reports`, `asks`, `forecasts`), но
  подписка и платежи оставались связаны с тем же субъектом. Обратно в
  `telegram_id` не разворачивается.
- **Доступы.** Только через `EntitlementsService.getEntitlements(userId)`.
  Проверки вида `if (plan === 'month')` в обработчиках — ошибка ревью.

## Лимиты запросов

Счётчик — в памяти процесса (`apps/api/src/common/rate-limit.middleware.ts`):
60 запросов в минуту на пользователя, 10 — на `POST /charts`, 120 — на поиск
городов. Ответ `429 RATE_LIMITED` несёт заголовки `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` и `Retry-After`.

Публичные маршруты (health, колесо по подписи, вебхук Telegram) не лимитируются.
При переходе на несколько инстансов счётчики нужно вынести в Redis — сейчас
лимит умножается на число подов, и это записано как известное ограничение.

## Геоданные

`POST /api/v1/geo/resolve` — подсказки городов из локального справочника
`packages/shared/src/geo/cities.data.ts` (149 городов: РФ, СНГ, столицы мира).
Правила, статус датасета и условия включения Nominatim — в [`geo.md`](./geo.md).
`POST /charts` от справочника не зависит: место рождения приходит целиком с фронта.

## Колесо карты без шрифтов

`GET /charts/{id}/wheel.svg` — самодостаточный SVG: текст нарисован контурами
глифов (`packages/astro/tools/build_glyphs.py` собирает их из DejaVu Sans,
лицензия Bitstream Vera разрешает встраивание). В мобильном WebView нет
DejaVu Sans и Segoe UI Symbol, поэтому `<text>` там превращался в «тофу» и
наезжал на маркеры. Раскладка подписей проверяется тестом геометрически
(`wheelLayout` в `packages/astro/astro/wheel.py`).

`GET /charts/{id}/wheel.png?sig=…&size=1080` — та же картинка, растеризованная
через `sharp`, для шаринга в чат.

## Миграции

`migrations/NNNN_описание.sql`, раннер — `apps/api/src/db/migrate.ts`
(advisory lock, `schema_migrations` с checksum). Применённые миграции
неизменяемы: раннер падает, если файл изменили после наката, — нужна новая
миграция.

## Астро-движок

`packages/astro` — Python-пакет с публичным API `calcChart`, `transitsFor`,
`llmContext`, `renderWheel`, `hashInput` (порт `astro/engine.py`). Подробности,
режимы `ASTRO_ENGINE` и ограничения — в [`packages/astro/README.md`](./packages/astro/README.md).

API ходит в движок по HTTP, а не через subprocess:

```bash
# терминал 1 — сайдкар (только localhost)
pnpm dev:astro                                 # = cd packages/astro && python3 -m astro.service

# терминал 2 — API
pnpm dev:api
```

* эндпоинты сайдкара: `GET /health`, `POST /chart`, `POST /transits`, `POST /wheel`;
* таймаут вызова — 2 с; недоступный сайдкар → `503` с `Problem.code = INTERNAL`,
  процесс API при этом живёт;
* `GET /api/v1/health` показывает `astro: ok|down`, а `status` становится `degraded`;
* в `charts.data` хранится и ответ контракта, и внутренние числа движка (долготы,
  система домов) — наружу уходит только контракт.

## Платежи

Stars (`XTR`) по [`payments.md`](./payments.md): цены — только в
`packages/shared/src/plans.ts`, сумма инвойса никогда не берётся из запроса.

* `POST /api/v1/billing/invoice` — ссылка для `Telegram.WebApp.openInvoice`;
  антифрод 3 инвойса в час / 10 в сутки, повтор того же плана в пределах 5 минут
  отдаёт существующую ссылку;
* `POST /api/v1/internal/telegram/webhook/{secret}` — `pre_checkout_query` и
  `successful_payment`; учёт платежа и выдача доступа — одна транзакция с
  `SELECT ... FOR UPDATE` по `telegram_payment_charge_id`, поэтому повторная
  доставка не создаёт второй доступ;
* `GET /api/v1/billing/subscription` — то же состояние, что в `GET /me`;
* доступ всегда проверяется через `getEntitlements` — второй правды нет.

## Статус

Сделано: каркас монорепо, миграции, авторизация через `initData`, `GET /me`,
`GET /health`, порт астро-движка, HTTP-сайдкар движка, `POST /charts` +
`GET /charts/{id}` + подписанный `wheel.svg`, платежи (инвойсы, вебхук, подписка,
возвраты), `DELETE /me` с каскадом.

Итерация 5: контракт 1.3.0, правила возраста и версии согласия, `POST /events`,
`wheel.png` и колесо без шрифтов.

Итерация 4: контракт 1.2.1, `POST /geo/resolve` со справочником городов,
`consent` и `time_precision` в `POST /charts`, `field_errors`, русские тексты
ошибок, лимиты запросов, Node ≥ 22.22.2 и единая версия vitest.

Дальше по порядку: LLM-конвейер (две стадии, лимит $0.35) → ночные прогнозы
с advisory lock → джоб `subscription_downgrade` → полная сборка гео-датасета из GeoNames.

## Версия контракта

`api.openapi.yaml` — 1.3.0. Отличия от 1.2.1 (по отчёту фронта в PR #12):

* `POST /geo/resolve`: `query` — минимум 2 символа; короче — `422` с
  `field_errors[{field: "query"}]`. Пустой массив = только «города нет»;
* `503 GEO_NOT_FOUND` отдаёт машинную причину в `details.reason`
  (`provider_timeout | provider_unavailable | not_configured`); текст больше
  не предлагает ручной ввод координат;
* возраст: 18 лет — в **00:00 UTC** дня рождения, для рождённых 29 февраля
  в невисокосный год — 1 марта (фронт повторяет то же правило);
* согласие принимается только в редакции `CONSENT_VERSION` (сейчас `2026-11-10`);
  устаревшая — `422` с `field_errors[{field: "consent.version"}]`;
* `POST /api/v1/events` — события продукта батчем до 20 штук, ответ `202`,
  закрытый список в `x-analytics-events`, ПДн в `props` отбрасываются;
* `GET /api/v1/charts/{id}/wheel.png` — растр колеса для шаринга, в
  `ChartResponse` добавлен `wheel_png_url`;
* колесо SVG больше не содержит `<text>` и `font-family`: все подписи —
  векторные контуры (`packages/astro/astro/glyphs.py`), поэтому глифы планет
  рисуются в любом WebView, а подписи не наезжают на маркеры.

Отличия 1.2.1 от 1.2.0 (по отчёту фронта в PR #2):

* `VALIDATION_FAILED` — **всегда 422**, `CONFLICT` — 409; у ошибки валидации есть
  `details.field_errors[{field, message}]`, чтобы фронт подсвечивал поле;
* `message` в `Problem` — готовый текст на «ты», включая неизвестный маршрут
  (`NOT_FOUND`, «Такой страницы нет. Обнови приложение.»);
* `POST /geo/resolve` всегда отвечает `200` и массивом (пустой = «города нет»),
  `GEO_NOT_FOUND` (503) — только при недоступном провайдере, лимит 120/мин;
* `POST /charts` требует `consent {accepted, version}` и `time_precision`
  (`exact | approximate | unknown`), отдаёт `Chart.birth.time_precision`,
  проверяет 18+ и «не раньше 1900» на сервере;
* `GET /charts/{id}` отвечает тем же конвертом, что и `POST /charts`:
  `{chart, mini_reading, wheel_url}`.

Отличия 1.2.0 от 1.1.0:

* OpenAPI 3.1: `nullable: true` заменён на `type: [X, 'null']` (12 схем) —
  так типы корректно генерируются `openapi-typescript`;
* `Problem.code` += `CONFLICT` (удаление аккаунта при незавершённых платежах);
* `Chart.omitted_planets` — движок сообщает, что не считает (`chiron`);
* `/health` += `astro: ok|down`;
* у вебхука описан `500` (Telegram повторит доставку), у инвойса — `422`/`429`.

Отличия 1.1.0 от 1.0.0:

* `Chart.asc`, `Chart.mc`, `Chart.houses` могут быть `null`: при неизвестном
  времени рождения дома и Асцендент не рассчитываются (`SPEC.md`);
* `Aspect.a` / `Aspect.b` — ключи планет (`PlanetPosition.key`), а не названия;
* `Chart.balances` — проценты.
