# Changelog

## [Unreleased]
### Added
- `AGENTS.md` — правила работы трёх агентов.
- `SPEC.md` — сценарии, экраны, данные, требования.
- `api.openapi.yaml` v1.0.0 — контракт API.
- `payments.md` v1.0.0 — платежи Stars и подписка.
- `prompts/` — init-промпты BACKEND, FRONTEND, QA.

### Открытые вопросы
- Лицензия Swiss Ephemeris (AGPL): коммерческая или `ASTRO_ENGINE=fallback`.
- Выбор языка API (NestJS / FastAPI) фиксируется на первой итерации BACKEND.

## Контракт 1.1.0
### Changed
- `Chart.asc`, `Chart.mc`, `Chart.houses` — nullable (время рождения неизвестно); поля присутствуют в ответе, значение `null`.
- `Aspect.a` / `Aspect.b` — ключи планет (`sun`, `moon`, ...), а не русские названия.
- `balances.elements` / `balances.modalities` — проценты (сумма ≈ 100).
- Весь файл переведён с OpenAPI 3.0 `nullable: true` на 3.1 `type: [X, 'null']`.

### Added
- `Problem.code` — значение `CONFLICT` (409; например, `DELETE /me` при незавершённых платежах).
- `Chart.omitted_planets` — планеты, не рассчитанные в текущем режиме движка (например, Хирон без файлов эфемерид).

## Контракт 1.2.0
### Added
- `Entitlements` и `Me.entitlements` — что куплено и что доступно по подписке (единственный источник для UI).
- `Me.chart_id`, `Me.latest_report_id`, `Me.onboarding_step` теперь обязателен; описано назначение `is_new`/`has_profile`/`has_chart`.
- `ChartCreateRequest.time_precision` (`exact | approximate | unknown`) и `Chart.birth.time_precision`.
- `ChartCreateRequest.consent` (`accepted`, `version`) — факт согласия на обработку ПДн, обязателен.
- `Problem.details.field_errors / reason / quota_code / reset_at`.
- `mini_reading.warnings` (`approximate_time | no_birth_time | approximate_place`).
- Схема тела `Problem` на всех ответах 404/402/409/422/429.
- `x-analytics-events` — список из 21 события для клиента.
- `GET /charts/{chart_id}` возвращает `chart + mini_reading + wheel_url`.

### Changed
- `wheel_url` — описан как относительный путь с уже включённой подписью `sig`.
- `POST /geo/resolve` — чтение, лимит 120/мин (было бы 10/мин как мутация).
- Кавычки в `description` там, где запятая ломала YAML (лишние ключи в `Me.user_id`, `Report.pdf_url`, `Forecast.text`).

## Контракт 1.2.1
### Changed
- Зафиксированы коды HTTP для всех `Problem`: `VALIDATION_FAILED` — всегда 422 (не 400), `CONFLICT` — 409, `GEO_NOT_FOUND` — 503.
- `POST /geo/resolve`: пустой результат — `200 []`, а не 404. `GEO_NOT_FOUND` означает недоступность провайдера геоданных. Лимит 120/мин.
- Зафиксирован тон `Problem.message`: русский, обращение на «ты». Английские тексты фреймворка на клиент не отдаются.
- `wheel.svg`: явно указано, что маршрут исключён из проверки `initData`; подпись `sig` — HMAC по `chart_id`, срок 30 дней.

### Added
- Заголовок `X-Request-Id` в контракте (дублирует `Problem.request_id`).

## Контракт 1.3.0
### Added
- `POST /api/v1/events` — батч до 20 аналитических событий, ответ 202.
- Правило возраста в контракте: 18 лет — в 00:00 UTC дня рождения; 29 февраля → 1 марта.
- `geo/resolve`: `query` короче 2 символов — 422 (раньше трактовалось как «ничего не найдено»).
- `GEO_NOT_FOUND`: причина в `details.reason` (`provider_timeout | provider_unavailable | not_configured`); текст не предлагает ввод координат.

### Changed
- `consent.version`: сервер принимает только актуальную версию (`CONSENT_VERSION`), иначе 422 по полю `consent.version`.
- `legal.md`: версия зафиксирована (`2026-11-10`), единый тон — «ты», добавлены константа синхронизации версии и правило «обещание в тексте = существующий экран».

### Added (документы)
- `legal-texts-2026-11-10.md` — строки для `i18n/ru.ts`: короткий дисклеймер, согласие, документы.

## Контракт 1.4.0
### Added
- `ChartResponse` — единый конверт для `POST /charts` (200/201), `GET /charts/{id}`, `GET /charts/current`.
- `ChartResponse.warnings` (обязательное, может быть пустым): `no_birth_time | approximate_time | approximate_place`. Незнакомые коды клиент пропускает.
- `ChartResponse.is_restored` — отличает восстановленную карту от только что построенной.
- `ChartResponse.wheel_png_url` — PNG 1080×1080 для шаринга.
- `GET /api/v1/charts/current` — карта вернувшегося пользователя (404 → онбординг). Закрывает #5.
- `GET /api/v1/charts/{id}/wheel.png?sig=&size=1080|1600`.
- `x-bot` — шаблон ссылки для шаринга, username из `BOT_USERNAME`.
- Событие `validation_failed_client` в `x-analytics-events`.

### Changed
- `POST /charts` может отвечать `200`, если карта уже существует.
- `POST /events` → `202 {accepted}`; список запрещённых ключей в `props` выровнен с кодом (16 ключей).
- `POST /geo/resolve`: `limit` вне 1…10 — 422, без молчаливого зажатия.
- `SPEC.md`: поиск места — от 2 символов (было 3).

### Документы
- `legal.md` синхронизирован с `legal-texts-2026-11-10.md` (тон «ты»).
- Добавлен раздел 0 «Согласие, cookie и аналитика»: события до согласия разрешены, в политике появился абзац про обезличенную статистику.

## Контракт 1.5.1 — сведение ветвей контракта, по итогам приёмки QA-001

### Контекст
В `main` (1.4.0) лежал один набор полей, в рабочей копии оркестратора — другой, и правки второй версии
в `main` ни разу не попадали. QA-001 (находка QA-12) это и обнаружил. 1.5.1 собрана **на основе файла из `main`**:
ничего из 1.4.0 не потеряно (проверено обходом всех ключей: единственное удаление — `ClientEvent.at`, переименованное
в `occurred_at`).

### Изменено против 1.4.0
- `ClientEvent.at` → **`ClientEvent.occurred_at`** (каноническое имя: так поле и в БД, и в метриках, и в задании приёмки). Добавлен необязательный `ClientEvent.chart_id`.
- `x-analytics-events` — **объединение двух наборов имён** (37 вместо 21): фронт вёл `onboarding_*`, `mini_reading_view`, `wheel_shared`, `checkout_started`; бэк — `consent_view`, `birth_date_done`, `screen_view`, `share_clicked`, `checkout_opened`. Приняты оба набора, пары зафиксированы в `x-event-aliases`; сведение в один набор — 1.6.0, отдельным PR, когда фронт отчитается о фактических именах.
- `enum` в `ClientEvent.name` и список `x-analytics-events` теперь совпадают один-к-одному (37).
- `Me.required` дополнен: `has_chart`, `chart_id`, `entitlements`, `onboarding_step`. Добавлен `Me.latest_report_id` (был в 1.2.0, потерялся).
- `ChartResponse.required` дополнен `wheel_png_url`.
- `GET /admin/metrics`: `payments_rejected_30d`, `amount_mismatch_30d`, `refunded_30d`, `pending_payments_now`.
- `Problem.details`: `reason`, `quota_code`, `reset_at`. Заголовок `X-Request-Id` описан в `components.headers` и обязателен даже на ошибке разбора тела (QA-12b).

### Добавлено
- `x-analytics-server-events`: `payment_rejected`, `refund_issued`, `subscription_expired` — события, которые пишет только сервер; попытка отправить их клиентом → `422`.

### Требования к коду (схемой не выражаются, фиксируются здесь)
- `successful_payment` обязан сверять: наличие серверного инвойса по `payload.k`, равенство `total_amount` цене плана, принадлежность платежа пользователю. При расхождении доступ не выдаётся, вебхук всё равно отвечает `200`, платёж пишется со статусом `rejected`, событие `payment_rejected`, счётчик в метриках. Автовозврат не делать — решает человек (QA-11).
- При отсутствии `subscription_expiration_date` продление идёт от текущего `expires_at`, а не от `now()` (R-1).
- `409` при `DELETE /me` обязан содержать путь решения, а не только «подожди» (QA-14).
- `validation_failed_client`: props — `step` и `field`, без причины отказа (причина по возрасту — сведение о ПДн).

## Фронт, итерация 5 — пейволл, разбор, настройки (контракт 1.5.1)

### Добавлено
- **Пейволл (экран 7).** Полный разбор (`one_149`, для одной карты) и три подписки; счёт через `POST /billing/invoice` и `openInvoice`. Слово Telegram «paid» ничего не открывает: купленное выдаёт только сервер (`GET /me`), иначе — «Платёж обрабатывается». Пока платёж не подтверждён, приложение не предлагает оплатить то же ещё раз. Цена — из `Invoice.stars`; отмена счёта — не ошибка; `429`, `422`, отказ платежа — свои тексты. Вне Telegram — «Оплата доступна в Telegram».
- **Разбор (экран 6).** Заказ `POST /reports` с `chart_id` и `Idempotency-Key` (ключ хранится в `sessionStorage`, новый — только после `failed`/`refunded` по нажатию «Попробовать снова»); опрос `GET /reports/{id}` с паузой 2–10 с, без запросов на скрытой странице и после ухода с экрана; прогресс и главы — как их отдаёт сервер; `refunded` — не ошибка. Текст глав выводится без HTML.
- **Настройки (экран 9).** Подписка и как её отменить, лимиты (`-1` — «Без ограничений»), документы, поддержка, удаление данных — кнопка и два подтверждения подряд, удаляет только второе (`DELETE /me`), экран «Данные удалены».
- **Карта (экран 5).** Блок полного разбора: начало разбора от сервера (`teaser`) в три строки, цена и переход на пейволл; для купившего — «Получить разбор» или «К разбору». Возврат на карту с других экранов не запрашивает её заново и не считает `chart_restored` второй раз.
- **События:** `paywall_view`, `checkout_started`, `checkout_opened`, `payment_succeeded`, `payment_cancelled`, `report_requested`, `report_ready_view`, `quota_exhausted`, `error_shown`, `data_deleted`. Неудавшееся удаление — `error_shown {screen: settings, code}`.
- **Мок API:** счета, оплата, разбор по главам, `DELETE /me`, сценарии пользователя и отказов, сброс без перезапуска (`/api/v1/__mock/reset`).
- **Dev-сборка:** `VITE_DEV_INVOICE` — «оплата» без Telegram, чтобы пройти экраны после покупки в браузере. В продакшен-бандл не попадает.

### Изменено
- `ClientEvent.at` → `occurred_at` во всех событиях.
- Код обращения (`request_id`) на экранах ошибок копируется тапом; если у ответа нет тела `Problem`, берётся из заголовка `X-Request-Id`.
- `validation_failed_client` в контракте есть, но по-прежнему не отправляется: ждёт подтверждения бэкенда.
- Кнопка «Написать в поддержку» ведёт на `VITE_SUPPORT_CONTACT`; пока он не задан, кнопка неактивна: «Поддержка скоро появится».
