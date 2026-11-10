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

### Известные ограничения

- `packages/astro` не портирован: файл `astro/engine.py`, указанный в `SPEC.md`,
  отсутствует в репозитории. Итерация ждёт файл от владельца продукта.
- Контракт требует `Chart.asc`, `Chart.mc` и `Chart.houses` как обязательные
  непустые поля, а `SPEC.md` — `null` при неизвестном времени рождения.
  Расхождение нужно решить правкой `api.openapi.yaml` до реализации `POST /charts`.
- Rate-limit (60/10 req/мин) и `DELETE /me` — следующие итерации.
