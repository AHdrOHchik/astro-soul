# Админ-панель: вход, сессия, журнал (итерация 40, контракт 1.6.15)

Что здесь: как панель входит, почему это не JWT, что делать, если «вход
недоступен», как читать журнал и какие цифры смотреть в `/health` и
`/admin/metrics`.

Панель живёт на `admin.<домен>` и ходит относительными путями; `/api/*`
проксируется на backend **без срезания префикса**. Никакого CORS нет и не
должно быть: один origin.

## Вход: два независимых способа

| Кто | Чем входит | CSRF |
|---|---|---|
| Мини-апп (и старые ручки владельца) | `X-Telegram-Init-Data: <initData>` или `Authorization: tma <initData>` | не нужен: подпись проверяется на каждом запросе |
| Браузерная панель | cookie `__Host-admin_session` | обязателен `X-Admin-CSRF` на `POST`/`PATCH`/`DELETE` |

Обе двери ведут к одному гарду: он достаёт `tg_id`, сверяет с `ADMIN_TG_ID` и
кладёт «кто действует» в запрос. Ручки админки не знают, откуда пришёл
человек — иначе третий способ входа пришлось бы добавлять в каждой ручке.

### Почему сессия — строка в базе, а не JWT

Кнопка «Выйти» обязана означать «выйти». Подписанный токен нельзя отозвать:
после выхода он остаётся валидным до истечения срока, и скопированный из
DevTools идентификатор продолжает работать. Здесь сессия — строка
`admin_sessions` с `revoked_at`, поэтому выход мгновенный.

Идентификатор сессии хранится в открытом виде (`admin_sessions.id`, uuid).
Обоснование: срок 12 часов и **один** админ; хэш добавил бы слой «как
отозвать, не зная id» и ничего не защитил бы — утечка базы уже означает
полный доступ.

### Что именно ставится

```
Set-Cookie: __Host-admin_session=<uuid>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200
```

* `__Host-` — префикс, который браузер сам проверяет: `Secure`, `Path=/`, **без
  `Domain`**. Поддомен не может подложить свою cookie.
* `HttpOnly` — идентификатор не читается из JS: XSS в панели не превращается в
  украденную сессию.
* `SameSite=Lax` — панель не принимает запросы с чужих сайтов; переход по
  ссылке из Telegram при этом работает.
* `Max-Age` = `ADMIN_SESSION_TTL_HOURS * 3600` (по умолчанию 12 часов) — ровно
  срок строки в базе, чтобы «cookie жива, а сессии нет» не случалось.

**Песочница и localhost.** В проде `COOKIE_SECURE=true`. Браузер не сохранит
`Secure`-cookie на `http://<ip>` (исключение — `http://localhost`), поэтому в
песочнице ставьте `COOKIE_SECURE=false`. Это единственное место, где флаг
меняется; с `false` в проде cookie поедет по http — не делать.

## CSRF

Токен приходит в `GET /admin/me` (`csrf_token`) и уходит заголовком
`X-Admin-CSRF` на каждом изменяющем запросе. Cookie `HttpOnly`, поэтому у
панели нет другого способа его получить.

* Токен **ротируется при входе**, а не при каждом запросе: иначе две открытые
  вкладки гасили бы токен друг другу.
* Заголовка нет → `403 csrf_missing`; не совпал → `403 csrf_mismatch`. Оба
  ответа формируются **до** любого эффекта: проверка стоит в гарде, а не в
  ручке.
* Путь `initData` CSRF не требует — там чужая подпись невозможна.
* `POST /admin/auth/logout` с живой сессией CSRF требует (иначе чужой сайт
  разлогинивал бы админа формой), а повторный вызов без cookie — нет: кнопка,
  нажатая дважды, не должна показывать ошибку.

## Настройка Telegram Login Widget

1. `@BotFather` → `/setdomain` → `admin.<домен>` (без схемы и без пути).
   Домен должен совпадать с тем, с которого грузится панель: виджет проверяет
   его сам.
2. В окружении API: `ADMIN_TG_ID=<telegram id владельца>`, `TELEGRAM_BOT_TOKEN`,
   `COOKIE_SECURE=true`, `ADMIN_SESSION_TTL_HOURS=12`.
3. Перезапустить API: `GET /health` → `flags.admin_auth.enabled = true`.

Виджет присылает подписанный набор полей; сервер проверяет
`hash = HMAC_SHA256(SHA256(bot_token), data_check_string)`, где
`data_check_string` — отсортированные `k=v`, склеенные `\n`. Окно —
**300 секунд** от `auth_date` (ровно 300 — ещё годен). `id` может прийти
строкой или числом — принимаются обе формы.

## Лимит попыток

10 неудач за 15 минут с одного IP (`ADMIN_LOGIN_MAX_ATTEMPTS`,
`ADMIN_LOGIN_WINDOW_MINUTES`) → `429` с `details.retry_after` в секундах.

* Считаются **неудачи**; успешный вход обнуляет счётчик.
* Проверка стоит **до** вычисления подписи: заблокированный запрос не тратит
  HMAC.
* Счётчики в памяти процесса. При нескольких экземплярах API лимит умножается
  на их число — так же, как у общего rate-limit; выносить в Redis до
  горизонтального масштабирования.
* IP берётся из `X-Forwarded-For` (доверяем одному хопу — прокси,
  `trust proxy = 1` в `main.ts`). В лог и журнал попадает **только хэш**
  (`ip_hash`, HMAC с `PSEUDONYM_PEPPER`), никогда сам адрес.

## «Вход недоступен» — что смотреть

Порядок диагностики (сверху вниз, каждый шаг отсекает половину причин):

1. `GET /health` → `flags.admin_auth`. `enabled: false` — не задан
   `ADMIN_TG_ID`: вход закрыт для всех, и это не ошибка кода.
2. Лог API: строка `admin_session: …` есть? Смотрите `reason`:
   * `not_admin` — `id` из виджета не равен `ADMIN_TG_ID` (частая причина:
     панель открыта под другим аккаунтом Telegram);
   * `invalid_hash` — не сошлась подпись: `TELEGRAM_BOT_TOKEN` не от того бота,
     с которым настроен домен в BotFather, либо домен в `/setdomain` другой;
   * `auth_stale` — строка старше 5 минут. Не «сломалось»: обновите страницу,
     виджет подпишет заново;
   * `missing_hash` — виджет не прислал подпись (обычно домен настроен неверно,
     и Telegram не подписывает);
   * `throttled` — сработал лимит. Ждите `retry_after`; проверить, не
     пробрасывает ли прокси `X-Forwarded-For` (иначе лимит общий на всех).
3. `GET /health` → `flags.admin_auth.sessions_active`. Растёт, а вход «не
   держится» — смотрите cookie в DevTools: имя `__Host-admin_session`,
   `Secure`, `Path=/`, и что панель и `/api` на **одном** origin.
4. `401` на каждом запросе при живой cookie — сессия отозвана или истекла.
   Проверка:
   `SELECT id, expires_at, revoked_at FROM admin_sessions ORDER BY created_at DESC LIMIT 5`.
5. `403 csrf_missing` — панель не прислала `X-Admin-CSRF` (обычно после
   перезагрузки страницы токен не перечитан: нужен `GET /admin/me`).
   `403 csrf_mismatch` — токен от другой сессии (перезашли в другой вкладке).

## Проверка после деплоя

```bash
# 1. Панель знает, что вход включён
curl -s https://api.<домен>/api/v1/health | jq '.flags.admin_auth'
# → {"enabled": true, "sessions_active": 0}

# 2. Вход закрыт без подписи (и не 500)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.<домен>/api/v1/admin/auth/telegram \
  -H 'Content-Type: application/json' -d '{"id":"1","auth_date":1}'
# → 422 (нет hash)

# 3. Админские ручки закрыты для всех, кроме владельца
curl -s -o /dev/null -w '%{http_code}\n' https://api.<домен>/api/v1/admin/audit
# → 401

# 4. Уборка сессий ходит (крон)
curl -s -X POST 'https://api.<домен>/api/v1/internal/jobs/run?job=admin_sessions_cleanup' \
  -H "X-Jobs-Secret: $INTERNAL_JOB_SECRET" | jq '.admin_sessions_purged'
# → 0 (или сколько удалилось)
```

Ручная проверка панели: войти, `GET /admin/me` в DevTools (должны быть
`expires_at` и `csrf_token`), создать код доступа, нажать «Выйти», обновить
страницу — должен быть экран входа, а в `admin_sessions` у строки —
`revoked_at`.

## Поддержка и цены (1.6.16)

Три группы маршрутов под тем же гардом, что и остальная панель (`initData`
владельца или cookie `__Host-admin_session` + `X-Admin-CSRF` на изменяющих).

### Тарифы

| Маршрут | Что делает |
|---|---|
| `GET /admin/plans` | все строки `plans`, включая неактивные и тестовые; цена — `price_stars`, период — `period_days` |
| `PATCH /admin/plans/{code}` | `{price_stars, comment (5…500), base_version}` → `200 {plan, effective_from}` |
| `GET /admin/plans/{code}/history` | история цены из `plan_price_history` |

* **`founder_month` менять нельзя** — `403 founder_plan_locked`. Это цена,
  обещанная первым 50; список «тарифов основателей» — `FOUNDER_PLAN_CODES` в
  `packages/shared/src/plans.ts`, а не сравнение строки в коде.
* **Версия — оптимистическая блокировка**: панель присылает `base_version`,
  которую видела. Устарела — `409 price_changed` с `details.current
  {price_stars, version}`. Две вкладки больше не перетирают друг друга молча.
* **Меняются цена и флаг тестового режима** (флаг — с 1.6.17, см. ниже).
  `is_active`, `grants`, `subscription_plan` через `PATCH` не правятся:
  неизвестное поле — `422 unknown_field`.
* **Только новые покупки** (`price_change_scope: only_new_purchases`): у уже
  выставленных счетов цена — снимок `invoices.stars`, он не пересчитывается.
* **`test_only` — двумя шагами** (1.6.17). Включить тестовый режим можно одной
  правкой (`{test_only: true, comment, base_version}`), снять — только с
  `confirm: "disable_test_plan"`, иначе `422 confirmation_required`. Это не
  формальность: `test_only: false` превращает тариф за 1 ⭐ в продаваемый всем,
  и заметить это некому. Флаг пишется отдельной записью аудита
  `plan.test_only_change` (цена — `plan.price_change`); в историю цены
  (`plan_price_history`) смена флага не попадает. Цену тарифа основателей менять
  по-прежнему нельзя (`403 founder_plan_locked`), а флаг — можно.

### Пользователи

| Маршрут | Что делает |
|---|---|
| `GET /admin/users?telegram_id=…\|alias=…\|q=…` | ровно один фильтр, 20 строк + `truncated`; **без ПДн** |
| `GET /admin/users/{id}` | карточка: профиль (дата/время/место), карта, подписка, права, платежи, счётчики, `cost_rub`; пишет `user.card_view` |
| `POST /admin/users/{id}/refund` | `{charge_id, reason}` → полный возврат |
| `POST /admin/users/{id}/ban` | `{banned, reason}` |
| `POST /admin/users/{id}/push` | тестовый пуш `kind = 'test'` |

* **Список не отдаёт ПДн ни при каком фильтре**: ни даты/времени/места
  рождения, ни `telegram_id`. `alias` — псевдоним `u-<8 hex>` от `users.id`;
  имени человека в базе нет вовсе. Дата рождения и `telegram_id` — только в
  карточке.
* **Карточка пишет `user.card_view` в аудит до чтения данных.** Журнал
  недоступен → `500 admin_audit_write_failed`, карточка не открывается.
* **Сумма возврата не приходит в запросе.** `refundStarPayment` не умеет
  частичный возврат, поэтому сумма — `payments.total_amount`, а поле
  `amount`/`stars`/`sum` в теле — `422 refund_amount_not_allowed`.
  `404 charge_not_found` (чужой/неизвестный), `409 already_refunded`,
  `409 nothing_to_refund`, `502 telegram_refund_failed` — и в последнем случае
  платёж **не** помечается возвращённым.
* **Возврат не отзывает доступ** (`access_revoked: false`). Покупка остаётся
  покупкой: закрыть доступ — это `ban`, а не побочный эффект возврата.
* **Бан проверяется в `AccessService.hasAccess` до подписки и грантов.**
  Забаненный теряет доступ даже с действующей подпиской и подарком; разбан
  возвращает доступ без повторной оплаты. Подписку бан **не** отменяет.
* **Тестовый пуш** (`kind = 'test'`) идёт без окна 08:00–08:04 и без проверки
  `last_seen_at`, но уважает `push_enabled` (`409 push_disabled`). Один на
  местные сутки (`409 push_test_sent_24h`): ключ `(user_id, local_date, kind)`
  тот же, что у утренней рассылки.

### Разборы

`GET /admin/reports?status=&kind=&user_id=&limit=` — лента без текста разбора.
`POST /admin/reports/{id}/regenerate` — `202 {report_id, state: "queued",
attempts}`. Перезапускается только `failed` (`409 report_not_regenerable`),
новых платежей не создаётся, `attempts` и `MAX_ATTEMPTS` не меняются.

### Основатели, партнёры, платежи (1.6.17)

| Маршрут | Что делает |
|---|---|
| `GET /admin/founders?limit=50&cursor=` | места «первых 50» по дате заявки: `place`, `user_id`, `telegram_id`, `created_at`, `grant_kind`, `expires_at`, `code_activated` |
| `GET /admin/partners` | агрегаты по `access_codes.partner_name`: коды, активации, сколько людей, сколько заплатили, `revenue_stars` |
| `GET /admin/payments?charge_id=&user_id=&status=&limit=&cursor=` | лента платежей для поддержки; `charge_id` — главный сценарий |
| `POST /admin/backup/run` | `{reason}` → `202 {started, job_id}`; тот же `scripts/db-dump.sh`, что у cron |
| `POST /admin/telegram/webhook` | `{reason}` → `200 {url, ok:true, last_error_message:null}` или `502` с ответом Telegram дословно |
| `POST /admin/alerts/{id}/ack` | `{minutes}` 15…1440 → `200 {acked_until, alert}`; `GET /admin/alerts` отдаёт `acked_until` |

* **`code_activated`** — `true`, если у основателя есть строка в
  `access_code_activations`. «Пришёл сам» и «пришёл по коду» — разные ответы на
  вопрос «работает ли партнёрская ссылка», и склеивать их в одно число нельзя.
  **Имени в ответе нет** (1.6.18): в `users` нет колонки `username`, имя в
  Telegram мы не храним вовсе. В 1.6.17 поле `username` отдавалось всегда
  `null` «на будущее» — это обещание колонки, которой не будет, поэтому поле
  убрано из контракта, а не заполнено заглушкой.
* **Партнёры — только агрегаты.** Ни `user_id`, ни `telegram_id`, ни самих
  кодов в ответе нет; это проверяется тестом по подстрокам. `paid_users` —
  активировавшие код, у которых есть хоть один платёж; `revenue_stars` —
  **только оплаченные** платежи, возвраты не вычитаются (иначе «выручка»
  партнёра менялась бы от чужого возврата через месяц; размер возвратов виден в
  `GET /admin/payments?status=refunded`).
* **Бэкап не пишет маркер сам.** Порядок «локальный файл → выгрузка →
  маркер» живёт в `scripts/db-dump.sh`; кнопка только запускает его. Отказ
  выгрузки → код 5, маркера нет, локальный дамп удалён. `503
  UNAVAILABLE backup_not_configured` (в `details.missing` — имена
  незаданных переменных), `409 backup_in_progress` и `409 backup_too_frequent`
  (не чаще раза в 10 минут). **Оба** `409` несут `details.retry_after_seconds`
  (1.6.18), чтобы кнопка говорила «повтори через N», а не «нельзя»: у
  `too_frequent` это точный остаток окна, у `in_progress` — интервал опроса
  (30 с), потому что длительность идущего дампа неизвестна и обещать её
  окончание было бы выдумкой. Ограничители — в
  памяти процесса; при нескольких инстансах от двойного дампа защищает `flock`
  в самом скрипте.
* **Вебхук: `setWebhook`, никогда `deleteWebhook`.** Между `delete` и `set`
  Telegram успевает принять апдейты в никуда — поэтому маршрут только
  переустанавливает адрес и проверяет результат через `getWebhookInfo`. Успех =
  `getWebhookInfo().url` совпал с ожидаемым; иначе `502
  telegram_webhook_failed` с `last_error_message` из ответа Telegram.
  `409 webhook_url_not_configured` — не задан `MINI_APP_URL`/секрет.
* **`ack` не «чинит» алерт.** Заглушение живёт отдельно от срабатывания: до
  `acked_until` панель показывает «скрыт до HH:MM», `value`/`threshold`/`since`
  не меняются, `fired` остаётся `false` до истечения срока, а после — снова
  виден, если причина не ушла. Заглушка — строка аудита `alert.ack`; её и
  читает `GET /admin/alerts` (`DISTINCT ON (entity_id)` по последней записи).
  `422 unknown_alert` для неизвестного id, `422` для `minutes` вне 15…1440.

### Переменные окружения ручного бэкапа

| Переменная | Смысл |
|---|---|
| `BACKUP_STATE_FILE` | файл-маркер «копия вне сервера есть» (его же читает алерт `backup_stale`) |
| `BACKUP_DIR` | куда `pg_dump` пишет локальный файл |
| `BACKUP_S3_URL` или `BACKUP_REMOTE` | куда выгружать; достаточно одной |
| `BACKUP_SCRIPT` | путь к скрипту (по умолчанию ищется `scripts/db-dump.sh`) |

Все — необязательные: без них `/admin/backup/run` отвечает `503` с перечнем
того, чего не хватает, а не «запущено».

### Что дежурный видит в цифрах

`/admin/metrics` → `push_test_sent_24h`, `admin_login_failed_24h`,
`refunds_24h`. Алерт `admin_login_failed` (warning) срабатывает при
`admin_login_failed_24h > 20`: серия неудачных входов — это подбор или
сломанный виджет входа.

## Журнал аудита

`GET /admin/audit?entity=&entity_id=&action=&actor_tg_id=&limit=50&cursor=`.

Пишутся: `session.login`, `session.logout`, `code.create`, `grant.create`,
`grant.revoke`, `session.purge` (джоб уборки, `actor_tg_id = 0`), а с 1.6.16 —
`plan.price_change`, `user.card_view`, `user.refund`, `user.ban`, `user.unban`,
`user.push_test`, `report.regenerate`, а с 1.6.17 — `plan.test_only_change`,
`backup.run`, `webhook.reinstall`, `alert.ack`.

* Запись идёт **в той же транзакции**, что и действие: нет записи — нет
  изменения. Ошибка записи видна как `500` с
  `details.reason = admin_audit_write_failed` и событием
  `admin_audit_write_failed` в логе.
* `actor_name` — снимок на момент действия (ник меняется, журнал — нет).
* `before`/`after` — только изменённые поля и без ПДн: карта — `chart_id`,
  платёж — `charge_id`, ни дат рождения, ни имён получателей.
* Таблица **append-only**: `UPDATE`/`DELETE` запрещены триггером
  (`admin_audit_append_only`), даже для владельца таблицы. Снять запрет можно
  только явной миграцией — и это останется в истории.
* Сортировка `at DESC, id DESC`, курсор `(at, id)`: `offset` на живой ленте
  теряет и дублирует строки.

## Наблюдаемость

| Где | Что |
|---|---|
| `/health` → `flags.admin_auth` | `enabled`, `sessions_active` |
| `/admin/metrics` | `admin_logins_24h`, `admin_audit_writes_24h`, `admin_sessions_purged_24h`, `push_test_sent_24h`, `admin_login_failed_24h`, `refunds_24h` |
| лог | `admin_session: action=login|logout tg_id=… ip_hash=… ok=…` (без initData, без cookie, без IP) |
| события | `admin_login`, `admin_logout`, `admin_audit_write_failed` — без ПДн |
| лог 1.6.17 | `backup_run_started` / `backup_run_finished` / `backup_run_failed` (код выхода и последняя строка stderr), `telegram_webhook_reinstalled` (url без секрета), `alert_acknowledged` (`minutes`, `acked_until`), `code_activation_throttled` (`user_id`, `retry_after_seconds`) |

Дежурные правила: `admin_audit_writes_24h = 0` при действиях админа значит,
что журнал сломан; `admin_sessions_purged_24h = 0` неделями — что джоб
`admin_sessions_cleanup` не запускается (таблица растёт, и это видно только
здесь).

## Уборка

Джоб `admin_sessions_cleanup` (в общем прогоне крона или отдельно) удаляет
сессии, у которых `expires_at < now() - 7 days`, и пишет `session.purge` с
числом удалённых. Неделя, а не «сразу»: `expires_at`/`revoked_at` нужны
дежурству ещё пару дней, чтобы ответить «почему разлогинило».
