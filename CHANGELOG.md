# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Добавлено

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
