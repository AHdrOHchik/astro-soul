# Итерация 40, волна 40.1 — вход в админ-панель: сессии, CSRF и аудит (контракт 1.6.15)

Контракт **1.6.14 → 1.6.15**, аддитивно. `required` нигде не тронут, существующие
поля не переименованы; формы `GET/POST /admin/grants`, `POST /admin/codes`,
`GET /admin/codes`, `/admin/metrics`, `/admin/alerts` остались прежними — это
закреплено отдельным тестом.

Прогон (sandbox, Postgres 5433 / `astro_soul_test`): API **67 файлов / 953 теста**
(было 65 / 918), web **51 / 920** (без изменений: в web меняется только
сгенерированная схема), astro **118** (pytest) — без изменений. `pnpm lint`,
`pnpm typecheck` (включая `gen:contracts:check` и `gen:api:check` для web и admin)
и `ruff` — чисто; `pnpm build` — зелёный, web **130.0 kB gzip** из бюджета 350 kB.
Миграции: на чистой базе применено **38**, повторный прогон — «0 applied,
38 skipped».

---

## Что и почему

Панель живёт в обычном браузере, где `initData` нет, а мини-апп ходит только по
`initData`. Нужен второй вход, который **не ломает первый** и который можно
отозвать.

1. **Сессия — строка в базе, а не JWT.** Требование владельца: «Выйти» должно
   означать «выйти». Подписанный токен отозвать нельзя, и скопированный из
   DevTools идентификатор продолжает работать до истечения срока. Здесь
   `admin_sessions.revoked_at`, поэтому выход мгновенный (проверено тестом:
   старая cookie после `logout` даёт `401`).
2. **Два входа — один гард.** `initData` (подпись на каждом запросе) и cookie
   `__Host-admin_session` (CSRF на изменяющих методах) сходятся в
   `req.adminActor`. Ручки админки не знают, откуда пришёл человек: иначе
   третий способ входа однажды появился бы не в каждой ручке.
3. **CSRF обязателен именно потому, что cookie уезжает сама.** `HttpOnly`
   защищает от чтения токена из JS, но не от отправки запроса чужим сайтом.
   Поэтому токен отдаётся в `GET /admin/me` (JS его прочитает только оттуда),
   а изменяющие запросы без `X-Admin-CSRF` не выполняются вовсе.
4. **Аудит обязателен.** «Кто отозвал доступ» должно отвечаться запросом, а не
   восстановлением из логов. Запись журнала идёт **в той же транзакции**, что и
   изменение: отказ журнала откатывает действие.
5. **Вход ограничен по попыткам.** Строку входа можно перебирать; 10 неудач за
   15 минут с одного IP закрывают окно `429`, причём подпись при этом **не
   считается** — перебор не должен быть вычислительной работой сервера.

Что осознанно **не** делалось (волна 40.2+): пользователи, возвраты звёзд,
перегенерация разборов, редактирование тарифов, бэкапы, вебхуки.

## Что сделано

### Миграции

| Файл | Что |
|---|---|
| `migrations/0037_admin_sessions.sql` | `admin_sessions(id uuid pk, tg_id bigint, name text, csrf_token text, created_at, expires_at, revoked_at, last_seen_at)`, `CHECK expires_at > created_at`, индексы `(tg_id)`, `(expires_at)` |
| `migrations/0038_admin_audit.sql` | `admin_audit(id bigserial, at, actor_tg_id, actor_name, action, entity, entity_id, before jsonb, after jsonb, reason, request_id)`, индексы `(at DESC, id DESC)`, `(entity, entity_id)`, `(actor_tg_id)`, триггер `admin_audit_no_change` (append-only), функция `admin_audit_append_only()` |

`admin_audit` защищена **триггером**, а не `REVOKE`: приложение ходит в базу
одной ролью (в тестах — владельцем), и `REVOKE` такой роли ничего не запрещает,
а триггер срабатывает независимо от прав. Снять его можно только явной
миграцией — она останется в истории. Тест `append-only` проверяет и `UPDATE`, и
`DELETE`. Партиционирования нет: объём — единицы строк в день.

### Вход, сессия, выход

* `POST /admin/auth/telegram` — подпись `secret = SHA256(bot_token)`,
  `data_check_string` из отсортированных `k=v` через `\n`, сравнение
  constant-time, `id` принимается строкой и числом, окно `auth_date` — **300
  секунд** (`>` а не `>=`: ровно 300 — годен; закреплено тестом на границе).
  Ответы: `200 {ok:true}` + cookie, `401 invalid_hash`, `401 auth_stale`,
  `422 missing_hash | missing_fields | malformed`, `403 forbidden`
  (`id ≠ ADMIN_TG_ID` — **без** строки сессии и **без** `session.login`),
  `429` с `details.retry_after`.
* Cookie: `__Host-admin_session=<uuid>; HttpOnly; Secure; SameSite=Lax; Path=/;
  Max-Age=43200` (`ADMIN_SESSION_TTL_HOURS * 3600`). `Secure` — по
  `COOKIE_SECURE` (`true` по умолчанию; `false` только для песочницы/`localhost`).
* `GET /admin/me` — `{tg_id, name, expires_at, csrf_token}`; `name` — снимок из
  сессии, для `initData`-пути `expires_at` и `csrf_token` — `null`.
* `POST /admin/auth/logout` — `200 {ok:true}`, `revoked_at`, `Max-Age=0`;
  идемпотентно (повтор — `200`, второй записи `session.logout` нет).
* `last_seen_at` — `UPDATE … WHERE last_seen_at IS NULL OR last_seen_at < now() -
  interval '1 minute'`, то есть «не чаще минуты» свойством запроса, а не
  памяти процесса; ошибка записи не роняет запрос.

### Гард (middleware)

`InitDataMiddleware` стал единой точкой входа для `/api/v1/admin/*`:

* есть cookie → сессия проверяется по базе; нет/просрочена/отозвана → `401`
  `admin_session_invalid` + cookie снимается; `tg_id ≠ ADMIN_TG_ID` → `403`;
  `POST/PATCH/PUT/DELETE` без `X-Admin-CSRF` → `403 csrf_missing`, с чужим →
  `403 csrf_mismatch` — **до** вызова ручки;
* нет cookie → прежний `initData` (`X-Telegram-Init-Data` **или**
  `Authorization: tma <initData>`), CSRF не требуется;
* `POST /admin/auth/logout` — исключение ровно в двух отношениях: доступен без
  авторизации (повторный выход обязан вернуть `200`) и живая сессия в нём всё
  равно требует CSRF (иначе чужой сайт разлогинивал бы админа формой).
* `/admin/auth/telegram` добавлен в закрытый список `isPublicPath` — и только он.

`/health` конструктор **не менялся** (по-прежнему пять зависимостей): число
живых сессий считается тем же `DbService`, отказ запроса даёт `0`, а не `500`.

### Аудит

`AdminAuditService.write(client, actor, entry)` принимает клиент транзакции:
журнал и изменение коммитятся вместе. Пишутся `session.login` (после —
`{expires_at}`), `session.logout`, `code.create` (`{code, kind, days,
expires_at}`), `grant.create` (`{kind, source, expires_at, code_id}`),
`grant.revoke` (`{revoked_at:null}` → `{revoked_at}`), `session.purge` (джоб,
`actor_tg_id = 0`). `before`/`after` — только изменённые поля; тест проверяет,
что в записи о выдаче права нет `birth_date`, `birth_time`, `birth_place`,
`telegram_id`, `user_id`.

Чтобы журнал попал в ту же транзакцию, `GrantsService.issue/revoke` и
`AccessCodesService.create` получили необязательный клиент транзакции. Повтор
после коллизии кода внутри чужой транзакции сделан через `SAVEPOINT` — иначе
`23505` перевёл бы транзакцию в `aborted` и вторая попытка была бы невозможна.

`GET /admin/audit` — `{items, next_cursor}`, фильтры `entity`, `entity_id`,
`action`, `actor_tg_id`, `limit` (по умолчанию 50, **> 200 → `422`**), курсор
`(at, id)` (сравнение кортежем: `at <` потерял бы строки, попавшие в одну
микросекунду — тест с одинаковым `at` это фиксирует).

### Остальное

* Джоб `admin_sessions_cleanup`: `DELETE … WHERE expires_at < now() - 7 days`
  + запись `session.purge` в той же транзакции; `JobRunResult.admin_sessions_purged`.
* `/health` → `flags.admin_auth {enabled, sessions_active}`.
* `/admin/metrics` → `admin_logins_24h`, `admin_audit_writes_24h`,
  `admin_sessions_purged_24h` (последняя — сумма `after.purged` по
  `session.purge`: отдельный счётчик в памяти обнулялся бы при рестарте).
* Лог `admin_session` одной строкой: `action=login|logout tg_id=… ip_hash=… ok=…`
  (IP — только HMAC-хэш с `PSEUDONYM_PEPPER`, никогда сам адрес).
* Серверные события `admin_login` (`{ok, reason}`), `admin_logout`,
  `admin_audit_write_failed` (`{action, entity}`) — без ПДн, best-effort.
* `.env.example`: `ADMIN_SESSION_TTL_HOURS=12`, `COOKIE_SECURE=true`,
  `ADMIN_LOGIN_MAX_ATTEMPTS=10`, `ADMIN_LOGIN_WINDOW_MINUTES=15`.
* `docs/ADMIN.md` — BotFather/`setdomain`, cookie и CSRF, лимит попыток,
  разбор «вход недоступен» по `reason`, пост-деплойные `curl`, чтение журнала.

### Отклонения от ТЗ (по одной строке, все — вынужденные)

1. **В `admin_sessions` добавлена колонка `name`.** ТЗ требует отдавать имя «из
   снимка сессии», но в перечне колонок его нет — без колонки требование
   невыполнимо. Имя пишется при входе и больше не читается из `users`.
2. **`apps/admin/src/api/schema.gen.d.ts` и `apps/web/src/api/schema.gen.d.ts`
   перегенерированы** (`pnpm --filter … run gen:api`). Это артефакты
   генератора из `api.openapi.yaml`, а не правка фронтового кода: гейт
   `gen:api:check` в `typecheck` иначе красный. Руками в `apps/web` и
   `apps/admin` ничего не менялось.
3. **`trust proxy = 1` в `main.ts` и в тестовом приложении.** Иначе `req.ip` за
   прокси — адрес прокси, и лимит входа стал бы общим на всех. Доверяем одному
   хопу; остальное в `X-Forwarded-For` клиент пишет сам.
4. **`admin_audit` защищена триггером, а не `REVOKE`** — причина выше.
5. **Счётчик неудач входа считает неудачи, а не запросы**, и обнуляется
   успешным входом: иначе дежурный, трижды промахнувшийся мимо виджета, к обеду
   закрыл бы себе вход.

## Как проверял

```
pnpm lint                  → чисто (eslint --max-warnings=0)
pnpm typecheck             → shared / api / web / ui / admin — Done, drift нет
pnpm build                 → api + web, 130.0 kB gzip (бюджет 350)
pnpm --filter @astro-soul/api exec vitest run
                           → 67 файлов / 953 теста, 0 падений
cd apps/web && NODE_ENV=test pnpm exec vitest run
                           → 51 файл / 920 тестов, 0 падений
packages/astro: pytest -q  → 118 passed;  ruff check → All checks passed
db:migrate на чистой базе  → применено 38; повторно → 0 applied, 38 skipped
```

Новые спеки:

| Файл | Что проверяет |
|---|---|
| `apps/api/test/telegram-login-fixture.ts` | независимая подпись виджета для тестов (алгоритм повторён, а не импортирован из продакшн-кода) |
| `apps/api/test/admin-auth.spec.ts` (24) | границы окна 300/301, `id` строкой и числом, подмена поля, пустой токен, `auth_stale`, `missing_hash`, отсутствие сессии и журнала у не-админа, 10 неудач → `429` и «верная строка тоже блокируется», лимит по IP (`X-Forwarded-For`), атрибуты cookie, `Secure` по флагу, `GET /admin/me`, `last_seen_at` не чаще минуты, `Authorization: tma`, настоящий выход (старая cookie → `401`), повторный выход `200` без второй записи, `csrf_missing`/`csrf_mismatch` с проверкой базы, `initData`-путь без CSRF, отказ журнала → `500 admin_audit_write_failed` и **нет** строки кода, `grant.create`/`grant.revoke` в журнале, событие `admin_login` без ПДн, `flags.admin_auth` |
| `apps/api/test/admin-audit.spec.ts` (11) | сортировка ленты, фильтры, курсор на одинаковом `at`, `limit=201` и мусорный курсор → `422`, `403` не-админу, append-only (`UPDATE`/`DELETE`), отсутствие ПДн в записи о выдаче, джоб уборки (удаляет 8-дневную, не трогает вчерашнюю, пишет `session.purge`), три метрики, неизменность форм 1.6.14 |

Существующие спеки `/admin/*` (`admin-grants.spec.ts`, `ops.spec.ts`,
`ops-alerts.spec.ts`) прошли **без правок**: все они ходят по `initData`, и этот
путь остался прежним. В служебных файлах правки ровно две и обе механические:
`truncateAll` знает про `admin_sessions`/`admin_audit`, а тестовое приложение
повторяет `trust proxy` из `main.ts`.

**Что защищает от обхода CSRF и каким тестом:** cookie-путь принимает
изменяющий запрос только если заголовок `X-Admin-CSRF` совпал с
`csrf_token` сессии (constant-time, в middleware, до вызова ручки); проверяют
два теста в `admin-auth.spec.ts` — «нет заголовка → 403 csrf_missing, код не
создан» и «чужой токен → 403 csrf_mismatch; свой → 201 и запись code.create»,
причём оба смотрят в базу (`SELECT 1 FROM access_codes`), а не только на код
ответа.

**Что будет, если запись аудита не удалась:** действие не выполняется.
`AdminAuditService.write` бросает `500` с `details.reason =
admin_audit_write_failed` внутри транзакции изменения, транзакция откатывается,
в лог уходит `admin_audit_write_failed` и серверное событие с тем же именем.
Тест с падающим триггером на `admin_audit` подтверждает: ответ `500`, а
`access_codes` пуста.

**Какие маршруты понадобятся волне 40.2 и надо ли менять форму сессии:**
`GET /admin/users?query=`, `GET /admin/users/{id}`, `POST /admin/users/{id}/refund`,
`POST /admin/users/{id}/ban`, `POST /admin/users/{id}/push`, `GET /admin/reports`,
`POST /admin/reports/{id}/regenerate`, `GET /admin/payments`, `GET /admin/plans`,
`PATCH /admin/plans/{code}` (с `comment` и `409 price_changed`),
`GET /admin/plans/{code}/history`, `GET /admin/founders`, `GET /admin/partners`.
**Форму сессии менять не придётся**: все они закрыты тем же гардом, читают
`tg_id` из `req.adminActor`, а изменяющие автоматически получают требование
`X-Admin-CSRF` — оно живёт в middleware, а не в ручках. Понадобится добавить
только новые имена `action` в аудит (`plan.price_update`, `session.revoke`,
`user.refund`, …) и, для `PATCH`-ов, `reason`/`comment` в `before`/`after`.

## Что проверять QA

1. **Вход без заголовка не меняет данные.** Войти, взять cookie, отправить
   `POST /api/v1/admin/codes` с cookie и без `X-Admin-CSRF` → `403
   csrf_missing`; в базе (`SELECT count(*) FROM access_codes`) — ноль новых.
   Повторить с чужим токеном → `403 csrf_mismatch`.
2. **Выход настоящий.** `POST /admin/auth/logout` с cookie и CSRF → `200` и
   `Set-Cookie` с `Max-Age=0`; затем `GET /admin/me` со старой cookie → `401`;
   повторный `logout` со старой cookie → `200`.
3. **CSRF в `/admin/me`.** `GET /admin/me` с cookie отдаёт `csrf_token` (64 hex)
   и `expires_at` ≈ +12 часов; `tg_id` — строкой; `name` — из сессии.
4. **Граница окна.** Подпись с `auth_date = now - 300` → `200`; с
   `now - 301` → `401 auth_stale`; без `hash` → `422`; подпись от другого
   бота → `401 invalid_hash`.
5. **Не-админ.** Подпись виджета с чужим `id` → `403`, в `admin_sessions` и
   `admin_audit` — ноль строк.
6. **Лимит попыток.** 10 запросов с неверной подписью → все `401`; 11-й, уже с
   **верной** подписью → `429` с `details.retry_after > 0`; с другого
   `X-Forwarded-For` — `200`.
7. **Старая cookie после выхода → `401`** (отдельным пунктом: именно это
   отличает сессию-строку от JWT).
8. **Журнал.** После входа, создания кода и отзыва права
   `GET /admin/audit` содержит `session.login`, `code.create`, `grant.create`,
   `grant.revoke` в порядке `at desc`; `?action=grant.revoke` фильтрует;
   `?limit=201` → `422`; в записи о выдаче нет ни даты рождения, ни `user_id`.
9. **Append-only.** `UPDATE admin_audit SET actor_name = 'x'` и
   `DELETE FROM admin_audit` из psql → ошибка `restrict_violation`.
10. **Уборка.** Вставить сессию с `expires_at = now() - 8 days`, вызвать
    `POST /internal/jobs/run?job=admin_sessions_cleanup` с `X-Jobs-Secret` →
    `202`, `admin_sessions_purged = 1`, в журнале `session.purge`, в
    `/admin/metrics` — `admin_sessions_purged_24h` вырос.
11. **Старые маршруты не сломались.** `GET/POST /admin/grants`,
    `GET/POST /admin/codes`, `GET /admin/metrics`, `GET /admin/alerts` по
    `initData` отвечают теми же формами (в ответе `POST /admin/codes` — те же
    10 полей).

## Контракт

Версия **1.6.15** (`api.openapi.yaml`), изменения только аддитивные:

| Что | Изменение |
|---|---|
| `POST /api/v1/admin/auth/telegram` | новый маршрут, `security: []`, тело — поля виджета (схема с `additionalProperties: true`), `200 {ok:true}` + `Set-Cookie`, `401`, `403`, `422`, `429` |
| `GET /api/v1/admin/me` | новый; `{tg_id, name, expires_at, csrf_token}`, оба последних — `string \| null` |
| `POST /api/v1/admin/auth/logout` | новый; `200 {ok:true}`, `Set-Cookie` с `Max-Age=0` |
| `GET /api/v1/admin/audit` | новый; `{items[], next_cursor}`, схема `AdminAuditEntry` |
| `securitySchemes.AdminSessionCookie` | новый (`apiKey`, `in: cookie`, `name: __Host-admin_session`) |
| `components.parameters.AdminCsrf` | новый заголовок, подключён к `POST /admin/grants` и `POST /admin/codes` |
| `/admin/grants`, `/admin/codes`, `/admin/metrics`, `/admin/alerts` | `security` стал списком из двух схем (initData **или** cookie); формы ответов не менялись |
| `GET /health` | `flags.admin_auth {enabled, sessions_active}` |
| `GET /admin/metrics` | `admin_logins_24h`, `admin_audit_writes_24h`, `admin_sessions_purged_24h` |
| `JobRunResult` | `admin_sessions_purged`; заодно добавлены пропущенные ранее `push_runs_purged`, `share_cards_purged`; в `enum` джобов — `push_share_retention` и `admin_sessions_cleanup` |
| `x-analytics-server-events` | `admin_login`, `admin_logout`, `admin_audit_write_failed` (с описанием `props`) |

Новые машинные причины лежат в `Problem.details.reason` — коды `Problem.code`
не менялись: `invalid_hash`, `auth_stale`, `missing_hash`, `missing_fields`,
`malformed`, `csrf_missing`, `csrf_mismatch`, `admin_session_invalid`,
`admin_login_throttled`, `admin_only`, `invalid_cursor`, `invalid_limit`,
`invalid_actor_tg_id`, `admin_audit_write_failed`.

**Что должен сделать фронт после мерджа** (не делал, это их зона):
`apps/admin/src/api/types.ts` — удалить `AdminMe` и `TelegramAuthPayload`,
перейти на выведенные из `paths` типы; в `routes.ts` перевести `authTelegram`,
`authMe`, `authLogout` в `inContract: true`; добавить маршрут `auditList`
(`GET /api/v1/admin/audit`).

## Не проверено

1. **Реальный Telegram Login Widget в браузере.** Подпись проверяется тестами
   на независимо посчитанном `hash`, но сам виджет (домен в BotFather, iframe,
   поведение `Secure`-cookie на боевом `https://admin.<домен>`) в песочнице не
   воспроизводится. Проверять на staging вручную по чек-листу `docs/ADMIN.md`.
2. **`__Host-` в Safari/Firefox.** Требование `Secure` у префикса эти браузеры
   трактуют одинаково по спеке, но фактическое поведение `SameSite=Lax` при
   возврате из Telegram-вебвью не измерялось.
3. **Лимит попыток при нескольких экземплярах API.** Счётчики в памяти
   процесса: лимит умножается на число подов. Записано в `docs/ADMIN.md`; Redis
   в этой волне не вводился.
4. **Прокси и `X-Forwarded-For` на бою.** `trust proxy = 1` проверен
   синтетически (supertest + заголовок), но конфигурация конкретного nginx
   (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) — на
   инфраструктуре, не в коде.
5. **Ротация и отзыв «второй» сессии.** `session.revoke` (отзыв чужой сессии
   владельцем) в 1.6.15 не реализован: нет маршрута, нет кнопки. Строка
   `revoked_at` готова, действие `session.revoke` появится в 40.2.
6. **Объём журнала и его чтение на больших данных.** Индексы под три реальных
   запроса есть, но на десятках тысяч строк лента не гонялась — это проверка
   эксплуатации, а не этой волны.
7. **Совместимость со старым клиентом панели.** Панель ещё не переключена на
   новые маршруты (её PR отдельный), поэтому «кнопка Выйти в живом интерфейсе»
   проверяется после мерджа обеих частей.
