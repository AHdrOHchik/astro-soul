# Итерация 41, волна 40.2 — панель поддержки и цен (контракт 1.6.16)

Контракт **1.6.15 → 1.6.16**, аддитивно. `required` нигде не тронут, ни одно
существующее поле не переименовано; формы `GET/POST /admin/grants`,
`GET/POST /admin/codes`, `GET /admin/metrics`, `GET /admin/alerts`,
`POST /admin/auth/telegram`, `GET /admin/me`, `POST /admin/auth/logout`,
`GET /admin/audit` остались прежними — это закреплено тестом
`layouts not changed` внутри `admin-support.spec.ts` (сравнение формы ответа
`GET /admin/plans` и прежних маршрутов) и сьютом `admin-grants.spec.ts`, который
прошёл без правок.

**Файл форм панели `answers/admin-40.2-routes.md`, на который ссылается ТЗ, в
репозитории отсутствует** (`answers/` содержит только `admin-contract-request.md`
и `admin-pr1-review.md`). Поэтому формы маршрутов взяты из текста ТЗ, а места,
где ТЗ молчало (фильтры `GET /admin/reports`, тело `GET /admin/users`, поля
карточки), заполнены минимально и перечислены в разделе «Контракт» — панель
должна сверить их со своими формами до мерджа. Ни одна форма не выдумана
«похожей на правду»: чего в ТЗ не было, то помечено ниже.

Прогон (sandbox **без системного PostgreSQL** — см. «Как проверял»):
`pnpm lint`, `pnpm typecheck` (включая `gen:contracts:check` и `gen:api:check`
для web и admin), `pnpm build` — чисто. Миграции: на чистой базе применено **40**,
повторный прогон 0039/0040 — без ошибок (идемпотентность).

Тесты API в песочнице: **полный прогон снять не удалось** — PGlite-сервер
обрывает соединение и подвешивает часть сьютов, которые ходят в
`grants`/`admin_sessions` (подробно в «Не проверено», п. 1). Зелёные в песочнице:

| Спек | Результат |
|---|---|
| `admin-support.spec.ts` (новый) | **25/25** |
| `contract-errors.spec.ts` | **15/15** |
| `grants-access-guard.spec.ts` (включая новый тест бана) | **6/6** |
| `ops-alerts.spec.ts` (обновлён: девять алертов, порог `admin_login_failed`) | **16/16** |
| `billing-plans.spec.ts`, `plans-invoice-title.spec.ts` | зелёные |

Полный прогон (`68 файлов / 979 тестов`, было 67 / 953; +1 файл, +25 тестов
в нём и +1 тест в страже) — за CI: там обычный Postgres.

---

## Что и почему

Волна 40.1 дала панели вход и журнал. Работать поддержке было нечем: нельзя
найти человека, посмотреть его карточку, вернуть звёзды, заблокировать доступ,
перезапустить разбор или поменять цену. 40.2 закрывает ровно это.

1. **Цена живёт в одном месте — таблице `plans`.** Панель не «предлагает»
   цену, а меняет строку каталога: витрина, счёт и `pre_checkout_query` читают
   её же. Второй источник цены (конфиг, env, кэш панели) сделал бы «в панели
   499, а в счёте 399» вопросом времени.
2. **Смена цены — с версией, а не «последний победил».** Две вкладки панели
   или два админа иначе молча перетирают друг друга, и «почему тариф стоит
   столько» остаётся без ответа. Поэтому `base_version` и `409 price_changed`
   с актуальной ценой.
3. **Сумма возврата не приходит из панели.** `refundStarPayment` не умеет
   частичный возврат: сумма всегда `payments.total_amount`. Принять `amount` в
   теле и проигнорировать его — худший вариант (панель показала бы одно, ушло
   другое), поэтому такое поле — `422`.
4. **Список людей — без ПДн, карточка — под аудитом.** Дата рождения нужна
   поддержке, но она нужна *по одному человеку*, а не выгрузкой. Поэтому
   `GET /admin/users` не отдаёт ни даты/времени/места рождения, ни
   `telegram_id` при любом фильтре, а `GET /admin/users/{id}` пишет
   `user.card_view` **до** чтения данных: журнал недоступен — карточка не
   откроется.
5. **Бан — в единственной двери доступа.** Проверка живёт в
   `AccessService.hasAccess` и стоит **первой**, до `getEntitlements`: иначе
   забаненный с подпиской или подарком продолжал бы ходить в разбор, вопросы и
   прогноз. Бан не отменяет подписку и не удаляет покупки: это решение о
   человеке, а не о деньгах.
6. **Перезапуск разбора не создаёт второй платёж.** Это повтор уже оплаченной
   работы; `attempts` и `MAX_ATTEMPTS` не меняются, потому что лимит относится
   к генерации, а не к поддержке.

Что осознанно **не** делалось: `founders`, `partners`, `backup/run`, `webhook`,
`alerts/ack`, `payments` (см. последний раздел), отзыв чужих сессий
(`session.revoke`), отмена подписки при бане, автоотзыв доступа при возврате.

## Что сделано

### Миграции

| Файл | Что |
|---|---|
| `migrations/0039_plan_prices.sql` | `plans.version integer NOT NULL DEFAULT 1` + `CHECK plans_version_positive`; таблица `plan_price_history(id bigserial, plan_code → plans(code) ON DELETE CASCADE, price_stars, previous_price_stars, version, comment, actor_tg_id, actor_name, effective_from, created_at)` с `CHECK` на длину комментария и имени; индексы `(plan_code, effective_from DESC, id DESC)` и `(effective_from DESC, id DESC)`; append-only триггер `plan_price_history_no_change` |
| `migrations/0040_user_ban.sql` | `users.banned_at timestamptz`, `users.ban_reason text`, `CHECK users_ban_consistent` (оба NULL или оба заполнены, причина 5…500 символов), частичный индекс `users_banned_idx ... WHERE banned_at IS NOT NULL` |

`plans.updated_at` **не** добавлялся: он есть с миграции `0003_billing.sql`
(см. отдельный пункт ниже — это ровно то место, где панель ждала «новую»
колонку).

### Цены

* `GET /admin/plans` — все строки `plans` (и неактивные, и тестовые): панель
  показывает правду, а не витрину. Ответ — `{items: AdminPlan[]}`.
* `PATCH /admin/plans/{code}` — `{price_stars, comment, base_version}`.
  Внутри транзакции: `SELECT … FOR UPDATE` → сверка `version` →
  `UPDATE plans SET stars, version = version + 1, updated_at = now()` →
  `INSERT plan_price_history` → `admin_audit` (`plan.price_change`, `before`
  `{price_stars, version}`, `after` `{price_stars, version}`, `reason` =
  комментарий). `effective_from` ответа — `plan_price_history.effective_from`,
  то есть время, зафиксированное БД, а не время формирования ответа.
* `founder_month` закрыт на сервере: `403 founder_plan_locked` **до** разбора
  тела. Список — `FOUNDER_PLAN_CODES` из `packages/shared/src/plans.ts`
  (закрытый список кодов уже существует; второй источник правды не заводился).
* Неизвестное поле в теле — `422 unknown_field`: `test_only` и `is_active`
  этим маршрутом не меняются, и «лишнее поле молча проигнорировано» было бы
  худшим ответом, чем ошибка.

### Пользователи

* `GET /admin/users?telegram_id=|alias=|q=` — ровно один фильтр; ноль или два →
  `422 invalid_search`. `LIMIT 21` → 20 строк + `truncated` (без `COUNT(*)` по
  всей таблице). Состояние подписки берётся через
  `EntitlementsService.getSubscriptionState`: прямой `FROM subscriptions` вне
  `billing`/`entitlements`/`ops` запрещён стражем `grants-access-guard.spec.ts`.
* `GET /admin/users/{id}` — профиль (дата/время/место, `time_precision`), карта,
  подписка, права, до 50 платежей, счётчики (`reports`, `compatibility`,
  `questions`, `forecasts`) и `cost_rub` (сумма `reports.llm_cost_rub` +
  `daily_forecasts.cost_rub` + `questions.cost_rub`). Аудит `user.card_view`
  пишется **до** чтения ПДн, в своей транзакции.
* `POST /admin/users/{id}/refund` — проверки → `refundStarPayment` → только
  потом запись: `payments.status = 'refunded'`, `refunded_at`, `admin_audit`
  (`user.refund`). Ошибка Bot API — `502 telegram_refund_failed`, и платёж не
  меняется. **`entitlements` и `subscriptions` не трогаются** (см. отдельный
  пункт).
* `POST /admin/users/{id}/ban` — `{banned, reason}`; `UPDATE users` + аудит
  (`user.ban`/`user.unban`) в одной транзакции. Подписка не отменяется,
  `grants`/`entitlements` не меняются.
* `POST /admin/users/{id}/push` — заявка в `push_log` (`kind = 'test'`) и аудит
  (`user.push_test`) в одной транзакции, затем `sendPush`. Окно 08:00 и
  `last_seen_at` не проверяются; `push_enabled` — проверяется.

### Разборы

* `GET /admin/reports?status=&kind=&user_id=&limit=` — `LIMIT + 1` → `truncated`;
  текста разбора и вопросов в ответе нет.
* `POST /admin/reports/{id}/regenerate` — `SELECT … FOR UPDATE`, статус обязан
  быть `failed` иначе `409 report_not_regenerable`; затем `status = 'queued'`,
  `error_code = NULL`, `started_at`/`finished_at` = `NULL`, аудит
  `report.regenerate` — в одной транзакции. После коммита —
  `ReportsService.restart(reportId)` (новый публичный метод: `run` остался
  приватным, чтобы снаружи нельзя было запустить произвольный разбор в обход
  очереди). Ответ `202 {report_id, state: "queued", attempts}`, где `attempts`
  — `reports.attempts` как есть.

### Метрики и алерт

* `/admin/metrics` → `push_test_sent_24h` (по `push_log.kind = 'test'` с
  `sent` и без ошибки), `admin_login_failed_24h` (события `admin_login` с
  `props.ok = false`, включая заблокированные лимитом), `refunds_24h` (по
  `payments.refunded_at`, то есть и панельные, и телеграмные возвраты).
* `/admin/alerts` → правило `admin_login_failed` (warning, порог 20, `since`
  считается той же оконной суммой, что и остальные правила).

### Отклонения от ТЗ (по одной строке, все — вынужденные)

1. **`answers/admin-40.2-routes.md` отсутствует** — формы взяты из текста ТЗ;
   где ТЗ молчало, выбран минимальный вариант и он перечислен в «Контракт».
2. **Добавлена миграция `0039` с колонкой `plans.version`** — без неё
   невозможен `409 price_changed`: сверять нечего. `updated_at` при этом не
   добавлялся (уже был).
3. **`period_days` считается из `period_seconds`**, а не хранится: вторая
   колонка периода разошлась бы с первой при правке цены через SQL.
4. **`test_only` в ответе назван `test_only`, а не `is_test`** — прямое
   требование владельца; в БД то же имя.
5. **`time_precision` вместо `time_accuracy`** в карточке: колонка
   `profiles.time_accuracy` переименована в `time_mode` ещё в миграции `0006`,
   и API-имя приведено к контрактному `Chart.birth.time_precision`, а не к
   историческому.
6. **`GET /admin/users` не отдаёт `telegram_id`** даже когда фильтр — сам
   `telegram_id`: требование «без ПДн» сильнее удобства; `telegram_id` есть в
   карточке под аудитом.
7. **`alias` — производное от `users.id`** (`u-<8 hex>`): имени/username
   человека в базе нет вовсе, а придумывать колонку с ПДн ради поиска нельзя.
8. **`POST /admin/users/{id}/push` уважает `push_enabled`** (ТЗ этого не
   оговаривало): отправлять тест тому, кто отказался от пушей, — нарушение
   согласия, поэтому `409 push_disabled`.
9. **Возврат не отзывает доступ** — прямая формулировка ТЗ; отличие от
   вебхук-пути (`BillingRepository.registerRefund`, где доступ гасится) описано
   ниже.
10. **`PATCH /admin/plans/{code}` отвечает `200`, `POST …/regenerate` — `202`**:
    явные `@HttpCode`, иначе Nest по умолчанию отдал бы `201` на `PATCH`.

## Как проверял

**Важное ограничение песочницы: системного PostgreSQL нет** (`apt` не видит
пакета, докера нет). Поэтому интеграционные тесты гонялись против **PGlite**
(WASM-сборка Postgres 16), поднятой как настоящий сервер по TCP
(`@electric-sql/pglite` + `@electric-sql/pglite-socket`) на `127.0.0.1:5433`:
миграции накатывал штатный `globalSetup` тестов, клиент — штатный `pg`. Это не
полная замена Postgres (одно соединение, нет фоновых процессов), но SQL, схема,
транзакции и ограничения проверяются настоящим парсером и планировщиком
Postgres 16.

```
pnpm lint                  → чисто (eslint --max-warnings=0)
pnpm typecheck             → shared / api / web / ui / admin — Done, drift нет
pnpm build                 → api + web — зелёные
pnpm --filter @astro-soul/api exec vitest run
                           → в песочнице не завершается (PGlite); локально
                             зелёные: admin-support 25, contract-errors 15,
                             grants-access-guard 6, ops-alerts 16,
                             billing-plans и plans-invoice-title — полный
                             прогон из 68 файлов / 979 тестов — в CI
миграции на чистой базе    → применено 40; повторно 0039/0040 — без ошибок
PGlite-прогон SQL          → plans/users/refunds/ban/push/reports/metrics/alerts:
                             все запросы выполняются; append-only триггеры и
                             CHECK отклоняют UPDATE/DELETE истории и «бан без
                             причины»
```

Новый спек:

| Файл | Что проверяет |
|---|---|
| `apps/api/test/admin-support.spec.ts` (25) | `GET /admin/plans` (все тарифы, `test_only`, `founder_only`, отсутствие `is_test`), `PATCH` с верой/аудитом/историей и `409 price_changed` (цена не изменилась), `403 founder_plan_locked` (цена не изменилась), `422 unknown_field` для `test_only`, `422 invalid_search` на 0 и 2 фильтра, список без ПДн при всех трёх фильтрах, карточка с датой рождения и записью `user.card_view`, `404` на не-UUID, `422 refund_amount_not_allowed`, `404 charge_not_found`, успешный возврат (сумма из платежа, `entitlements` активны, аудит), `502 telegram_refund_failed` без изменения платежа, `409 already_refunded`, «забаненный теряет доступ при действующем гранте, разбан возвращает», `422` на бан без причины, «бан не отменяет подписку», тестовый пуш (log + аудит + окно), `409 push_test_sent_24h`, `409 push_disabled`, `202` перезапуска без второго платежа и с неизменными `attempts`, `409 report_not_regenerable`, лента без текста, три метрики, алерт `admin_login_failed` с порогом 20 |
| `apps/api/test/grants-access-guard.spec.ts` (+1) | «`users.banned_at` читается только в `AccessService`»: страж смотрит на SQL (`FROM`/`UPDATE`/`INSERT` по `users` рядом с `banned_at`) после вырезания комментариев, поэтому имя поля в DTO и в объяснениях не ловится, а второй запрос к флагу — ловится |

Служебные правки: `truncateAll` знает про `plan_price_history`, тестовое
приложение принимает подмену `sendPush` в фейке Bot API.

**Схема БД и SQL проверены дважды:** все 40 миграций прогонялись в PGlite,
затем отдельным скриптом выполнялись все новые запросы (`FOR UPDATE`, `UPDATE …
RETURNING`, `ON CONFLICT … DO NOTHING` для `push_log`, `INSERT … RETURNING
effective_from`, оконные функции алерта) на данных, вставленных вручную. Именно
этот прогон поймал два дефекта до ревью: `CHECK users_ban_consistent` проходил
при `ban_reason IS NULL` (NULL в `CHECK` — «истина»), и `profiles.time_accuracy`
не существует с миграции `0006` (колонка называется `time_mode`).

## Что проверять QA

1. **Смена цены.** `GET /admin/plans` → запомнить `version` тарифа `month_399`.
   `PATCH /admin/plans/month_399` `{price_stars: 599, comment: "подняли", base_version:
   <version>}` → `200`, в `GET /plans` (витрина) и в новом счёте — 599, в
   `plan_price_history` — строка с `previous_price_stars = 399`, в
   `admin_audit` — `plan.price_change`.
2. **Конфликт версий.** Повторить тот же `PATCH` с той же (старой)
   `base_version` → `409 price_changed`, `details.current.price_stars = 599`;
   цена в базе не изменилась.
3. **Тариф основателей.** `PATCH /admin/plans/founder_month` → `403
   founder_plan_locked`; `stars` = 199 (или как в сиде) не изменилась.
4. **`test_only` не правится.** Добавить `test_only: true` в тело → `422
   unknown_field`, в `plans.test_only` — прежнее значение.
5. **Список без ПДн.** `GET /admin/users?telegram_id=…`, `?alias=u-…`,
   `?q=…` — в любом ответе нет `birth_date`, `birth_time`, `place_name`,
   `telegram_id`; два фильтра сразу и ноль фильтров → `422 invalid_search`.
6. **Карточка и аудит.** `GET /admin/users/{id}` отдаёт дату рождения и
   `telegram_id`; после этого `GET /admin/audit?action=user.card_view` содержит
   запись с этим `entity_id`. Остановить `admin_audit` (триггер с ошибкой) →
   карточка отвечает `500`, данные не читаются.
7. **Возврат.** `POST /admin/users/{id}/refund` с `{charge_id, reason}` → `200`,
   `amount_stars` = сумма платежа, `access_revoked: false`; у человека
   **остался** доступ (право/подписка не тронуты). Тело с `amount` → `422
   refund_amount_not_allowed` и ноль вызовов Bot API. Повтор → `409
   already_refunded`. Неверный `charge_id` → `404 charge_not_found`.
8. **Возврат при отказе Telegram.** Отключить сеть/подменить токен →
   `502 telegram_refund_failed`; `payments.status` остался `processed`,
   `refunded_at IS NULL` — в панели «не получилось», а не «возвращено».
9. **Бан.** У человека с активной подпиской `POST /admin/users/{id}/ban
   {banned: true, reason}` → `200`; `POST /reports`, `/forecast/today`,
   `POST /questions` отвечают как без доступа (`402`), `subscriptions.status`
   остаётся `active`. `{banned: false}` → доступ вернулся без оплаты.
10. **Тестовый пуш.** `POST /admin/users/{id}/push` → `200`; в `push_log`
    строка `kind = 'test'`, `sent = true`; второй вызов в тот же день → `409
    push_test_sent_24h`; у `push_enabled = false` → `409 push_disabled`.
11. **Перезапуск разбора.** Упавший разбор → `202 {state: "queued",
    attempts}`; `payments` не выросло; готовый разбор → `409
    report_not_regenerable`; в журнале — `report.regenerate`.
12. **Дежурство.** 21 неудачный вход в панель за сутки → `/admin/metrics`
    `admin_login_failed_24h = 21`, `/admin/alerts` `admin_login_failed.fired =
    true`; тестовый пуш поднимает `push_test_sent_24h`; возврат —
    `refunds_24h`.
13. **Старые маршруты не сломались.** `GET/POST /admin/grants`,
    `GET/POST /admin/codes`, `GET /admin/metrics`, `GET /admin/alerts`,
    `GET /admin/audit` — те же формы и те же коды.

## Контракт

Версия **1.6.16** (`api.openapi.yaml`), изменения только аддитивные:

| Что | Изменение |
|---|---|
| `GET /api/v1/admin/plans` | новый; `AdminPlanPage {items: AdminPlan[]}` |
| `PATCH /api/v1/admin/plans/{code}` | новый; `{price_stars, comment, base_version}` → `200 {plan, effective_from}`, `403`/`404`/`409`/`422` |
| `GET /api/v1/admin/plans/{code}/history` | новый; `{items: AdminPlanHistoryEntry[]}`, до 100 записей |
| `GET /api/v1/admin/users` | новый; `telegram_id` \| `alias` \| `q`, `{items: AdminUserSummary[], truncated}` |
| `GET /api/v1/admin/users/{id}` | новый; `AdminUserCard` (профиль, карта, подписка, права, платежи, счётчики, `cost_rub`) |
| `POST /api/v1/admin/users/{id}/refund` | новый; `{charge_id, reason}` → `AdminRefundResult`, `404`/`409`/`422`/`502` |
| `POST /api/v1/admin/users/{id}/ban` | новый; `{banned, reason}` → `AdminBanResult` |
| `POST /api/v1/admin/users/{id}/push` | новый; `200 {user_id, sent, sent_at, kind: "test"}`, `409`/`502` |
| `GET /api/v1/admin/reports` | новый; фильтры `status`, `kind`, `user_id`, `limit` |
| `POST /api/v1/admin/reports/{id}/regenerate` | новый; `202 {report_id, state: "queued", attempts}`, `404`/`409` |
| `GET /admin/metrics` | `push_test_sent_24h`, `admin_login_failed_24h`, `refunds_24h` |
| `GET /admin/alerts` | правило `admin_login_failed` (warning, порог 20) в таблице правил |
| схемы | новые: `AdminPlan`, `AdminPlanPage`, `AdminPlanHistoryEntry`, `AdminUserSummary`, `AdminPayment`, `AdminUserCard`, `AdminRefundResult`, `AdminBanResult`, `AdminReportSummary`, `PriceChangeScope` (единственное значение `only_new_purchases`) |

Новые машинные причины в `Problem.details.reason` (коды `Problem.code` не
менялись): `invalid_search`, `unknown_field`, `price_changed`, `plan_not_found`,
`founder_plan_locked`, `user_not_found`, `charge_not_found`, `already_refunded`,
`nothing_to_refund`, `refund_amount_not_allowed`, `telegram_refund_failed`,
`push_disabled`, `push_test_sent_24h`, `telegram_push_failed`,
`report_not_found`, `report_not_regenerable`, `invalid_filter`.

**Что должен сделать фронт после мерджа** (не делал, это их зона): сверить
формы из ТЗ с этим разделом (особенно `GET /admin/users` — в ТЗ не было
сказано, какие поля в строке списка; `GET /admin/reports` — фильтры), и
перевести новые маршруты в `inContract: true` в `routes.ts` панели.

### Отдельной строкой: точные колонки `plans` и совпадение имён

`plans` после всех миграций: `code`, `kind`, `subscription_plan`, `stars`,
`period_seconds`, `title`, `description`, `price_label`, `paywall_title`,
`paywall_subtitle`, `grants`, `invoice_title`, `sort`, `is_active`, `test_only`,
`updated_at` (**был с 0003**), `version` (**новая, 0039**).

Совпадение с тем, что ждёт панель: **`price_stars` ≠ `stars`** (API отдаёт
`price_stars`, БД хранит `stars`); **`period_days` ≠ `period_seconds`** (API
считает дни из секунд, у разового товара — `null`); **`active` ≠ `is_active`**
(API отдаёт `active`, как и витрина); **`test_only` совпадает** с БД;
**`version` и `updated_at` есть**; **`founder_only` в БД отсутствует** и
считается по `FOUNDER_PLAN_CODES`; **`is_test` не существует и не вводится**.

### Отдельной строкой: что с доступом после возврата и почему

После `POST /admin/users/{id}/refund` доступ **остаётся**. Причина: возврат —
операция про деньги; `refundStarPayment` возвращает полную сумму, а отзыв
доступа (гашение `entitlements`, отмена подписки в Telegram) — отдельное
решение поддержки, которое принимается осознанно (`POST /admin/users/{id}/ban`)
и не должно срабатывать как побочный эффект кнопки «вернуть». Технически: в
`AdminUsersService.refund` обновляется **только** `payments` (`status`,
`refunded_at`) и пишется аудит; `entitlements` и `subscriptions` не трогаются —
это проверяет тест «успех: сумма из платежа, статус refunded, доступ не
отозван». Важное отличие: телеграмный путь возврата
(`BillingRepository.registerRefund`, вызывается из обработчика
`refunded_payment`) по-прежнему гасит доступ — там возврат инициирует Telegram,
и человек ожидает именно отмены. Два пути не смешиваются.

### Отдельной строкой: забаненный теряет доступ до проверки подписки

`AccessService.hasAccess` начинается с `if (await this.isBanned(userId)) return
false;` — это буквально первая строка тела, **до** `getEntitlements`, то есть
до чтения подписки, разовых прав и грантов. Доказательство — тест «забаненный
теряет доступ раньше подписки и грантов, разбан возвращает»: человеку выдаётся
`grants.all_access` на 30 дней, `hasAccess('full_forecast')` = `true`, после
`POST /admin/users/{id}/ban` — `false` (и для `ask`), строка гранта при этом
`revoked_at IS NULL`, после разбана — снова `true` без оплаты. Порядок
дополнительно закреплён статическим тестом «`users.banned_at` читается только в
`AccessService`» и тестом «бан не отменяет подписку» (`subscriptions.status`
остаётся `active`). Если бы проверка стояла после `getEntitlements`, любой
будущий рефакторинг ветки `reportAccess` мог бы вернуть `true` в обход бана;
сейчас отказ — первое, что происходит.

## Не проверено

1. **Настоящий PostgreSQL.** Песочница без Postgres: тесты и миграции гонялись
   на PGlite (WASM Postgres 16, один сервер по TCP). Конкурентность, `FOR
   UPDATE` под нагрузкой, поведение пула и реальные планы запросов на объёмах
   проверяются на staging/CI с обычным Postgres — это первое, что стоит
   повторить.

   Отдельно про честность цифр: **полный прогон `vitest run` в песочнице не
   завершается**, а `admin-grants.spec.ts`, `admin-auth.spec.ts` и
   `admin-audit.spec.ts` там же падают по инфраструктуре
   (`Test timed out`, `Hook timed out`, `Connection terminated unexpectedly`).
   Это не регрессия итерации 41: `admin-grants.spec.ts` воспроизведён на базовом
   коммите `6000b71` с отложенным (`git stash`) диффом 41 — те же таймауты.
   Причина — PGlite: один сервер, оборванные транзакции упавших тестов держат
   блокировки и подвешивают следующие. Поэтому «0 падений» по этим файлам здесь
   не заявляется: их гоняет CI на обычном Postgres.
2. **Реальный Bot API.** `refundStarPayment` и `sendMessage` подменены фейком:
   проверены наши ветки (`true`/`false`/исключение), но не ответы Telegram
   (`CHARGE_ID_INVALID`, `PHOTO_…`, `429 retry_after` на пуш).
3. **Формы панели.** `answers/admin-40.2-routes.md` в репозитории нет; панель
   может ждать другие имена/поля (особенно в карточке и ленте разборов).
   Сверка — до мерджа обеих частей.
4. **Частичный возврат** — не реализован намеренно (Bot API не умеет).
5. **Отмена подписки при бане** — не реализована намеренно: это отдельное
   решение, и «забанить» не должно списывать/отменять деньги.
6. **Отложенные цены.** `effective_from` в 1.6.16 всегда «сейчас»; сценарий
   «поднять цену с 1-го числа» не поддержан (нужен планировщик и второй
   источник правды о цене).
7. **Совместимость со старым клиентом панели**: панель ещё не знает новых
   маршрутов, поэтому живые экраны поддержки проверяются после её PR.

## Отдельной строкой: какие маршруты §5 остаются нереализованными

Из §5 «Панель» в этой волне **не** сделаны: `GET /admin/founders`
(список/освобождение мест основателей), `GET /admin/partners` (партнёрские
коды), `POST /admin/backup/run` (ручной дамп), `GET/POST /admin/webhook`
(регистрация вебхука и его проверка), `POST /admin/alerts/{id}/ack`
(подтверждение алерта) и `GET /admin/payments` (лента платежей: `payments`
нужны поддержке отдельно от карточки — сейчас платёж виден только в карточке
человека или по `charge_id`). Все остальные маршруты §5 — `plans`, `users`,
`reports` — реализованы выше.
