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

Дальше по порядку: LLM-конвейер (две стадии, лимит $0.35) → ночные прогнозы
с advisory lock → гео-справочник `GET /geo/resolve` → джоб `subscription_downgrade`.

## Версия контракта

`api.openapi.yaml` — 1.2.0. Отличия от 1.1.0:

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
