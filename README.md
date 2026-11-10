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

## Статус

Сделано: каркас монорепо, миграции, авторизация через `initData`, `GET /me`,
`GET /health`, порт астро-движка.

Дальше по порядку: `POST /charts` (и решение по транспорту до Python-движка) →
платежи и `getEntitlements` в обработчиках → LLM-конвейер → ночные прогнозы →
удаление данных.

## Версия контракта

`api.openapi.yaml` — 1.1.0. Отличия от 1.0.0:

* `Chart.asc`, `Chart.mc`, `Chart.houses` могут быть `null`: при неизвестном
  времени рождения дома и Асцендент не рассчитываются (`SPEC.md`);
* `Aspect.a` / `Aspect.b` — ключи планет (`PlanetPosition.key`), а не названия;
* `Chart.balances` — проценты.
