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
- С настоящим API Mini App доходит только до шага «Место рождения»:
  `POST /geo/resolve` и `POST /charts` в `apps/api` ещё не реализованы. Экраны
  места и карты целиком работают только с моком (`API_MOCK=1`).
- Вернувшийся пользователь вводит данные заново: в `GET /me` нет идентификатора
  карты.
- На настоящих клиентах Telegram приложение не проверялось, список ручных
  проверок — в `apps/web/README.md`.
