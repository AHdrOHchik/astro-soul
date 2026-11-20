# Docker и запуск окружения «Разбор личности»

Руководство по контейнеризации проекта (dev и production), проверкам безопасности, бэкапам и передаче окружения агенту деплоя (`init-vps`).

---

## 1. Архитектура сервисов

| Сервис | Образ / Dockerfile | Назначение | Внутренний порт | Наружу |
|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` | Основная БД (плюс `astro_soul_test` в dev) | `5432` | dev: `5432`, prod: **закрыт** |
| `redis` | `redis:7-alpine` | Redis (зарезервирован под rate-limit/локи) | `6379` | dev: `6379`, prod: **закрыт** |
| `astro` | `docker/astro.Dockerfile` | Python-сайдкар (`packages/astro`, FastAPI + `pyswisseph`) | `8001` | **закрыт** |
| `api` | `docker/api.Dockerfile` | NestJS API + Telegram webhook + Bot API клиент | `8080` | **закрыт** |
| `web` | `docker/web.Dockerfile` | Vite-сборка + `nginx` (статика Mini App + прокси `/api/*`) | `8080` | `80` (и `443` с TLS) |
| `migrate` | `docker/api.Dockerfile` (`profiles: [tools]`) | Одноразовый шаг миграций (`migrate.js` + `seed-plans.js`) | — | — |

> **Примечание о боте (`apps/bot`).** В текущей кодовой базе отдельного приложения `apps/bot/` ещё нет (в `README.md` оно помечено как «следующие итерации»). Приём апдейтов Telegram (`POST /api/v1/internal/telegram/webhook/:secret`), обработка `/start chart_<id>`, платежи Stars (`pre_checkout_query`, `successful_payment`) и отправка пушей/сообщений реализованы внутри `apps/api`. Выносить расчёты карт на Python потребовалось отдельно — для этого добавлен контейнер `astro` (`docker/astro.Dockerfile`), без него `/api/v1/health` отдаёт `status: degraded` (`astro: down`), а `POST /api/v1/charts` отвечает `503`.

Во всех контейнерах принудительно выставлен часовой пояс `TZ=UTC` (локальное время пользователя рассчитывается в коде по таймзоне места рождения).

---

## 2. Быстрый старт (dev)

1. Создай `.env` из единственного шаблона `.env.example` и заполни минимум переменных:

   ```bash
   cp .env.example .env
   ```

   Обязательный минимум для запуска `api`:
   - `TELEGRAM_BOT_TOKEN` — токен тестового бота от `@BotFather`
   - `PSEUDONYM_PEPPER` — случайная строка длиной от 32 символов (не менять после запуска)

   Для сборки фронта в `.env` также можно задать build-переменные (см. `apps/web/.env.example`):
   - `VITE_API_BASE_URL=` (пусто = тот же origin через nginx `/api/*`)
   - `VITE_BOT_USERNAME=`
   - `VITE_SUPPORT_CONTACT=`
   - `VITE_SUBSCRIPTIONS=` (`enabled` | `off` | пусто)

2. Проверь конфигурацию, подними стек и накати миграции:

   ```bash
   make check
   make up
   make migrate
   make ps
   ```

3. Проверь работоспособность:

   ```bash
   curl -fsS http://localhost/api/v1/health
   # Ожидаемый ответ: {"status":"ok","version":"0.1.0","db":"ok","llm":"unknown","astro":"ok"}
   ```

> Локальная разработка на хосте (`docker compose up -d postgres redis` → `pnpm dev:astro` / `pnpm dev:api`) продолжает работать без изменений: dev-порты `5432` и `6379` сохранены в `docker-compose.yml`, а внутри сети compose контейнеры `api` и `migrate` ходят к `postgres:5432`, `redis:6379` и `astro:8001` независимо от `localhost` в `.env`.

### `pnpm dev:api` не читает `.env` — прочитай это до того, как искать «почему переменная не работает»

Два способа запуска ведут себя по-разному, и это главный источник
расхождения «локально работает, на VPS нет»:

| Запуск | Откуда `api` берёт окружение |
|---|---|
| `make up` / `docker compose up` | `.env` в корне → подстановка в `docker-compose.yml` → `process.env` контейнера. Попадают **только** переменные, перечисленные в `environment:` сервиса `api` |
| `pnpm dev:api` / `node dist/main.js` | ничего не читается: Node сам `.env` не загружает. Переменные должны быть в шелле или в префиксе команды |

Поэтому переменная, добавленная в `.env`, для `pnpm dev:api` не существует,
пока её не передать явно:

```bash
PAYMENTS_TEST_PLANS=1 pnpm dev:api      # пример: флаг тестовых тарифов
```

И наоборот: строка в `.env` включает флаг только потому, что
`docker-compose.yml` перечисляет её в `environment:` — если переменной там
нет, `.env` для контейнера остаётся текстом. Практический вывод один: после
любой правки `.env` пересоздай контейнер (`docker compose up -d
--force-recreate api`), а не `restart`, — иначе окружение останется прежним.

---

## 3. Production (VPS overlay)

В проде поверх `docker-compose.yml` всегда накладывается `docker-compose.prod.yml`:
- `restart: unless-stopped` на всех долгоживущих сервисах;
- ротация логов (`json-file`, `max-size: 10m`, `max-file: 5`);
- лимиты CPU и памяти (`deploy.resources.limits`);
- `ports: !reset []` на `postgres` и `redis` — наружу открыт только `web` (`80`/`443`);
- `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, непривилегированные пользователи (`10001` у `api`/`astro`, `101` у `web`).

Запуск:

```bash
make check-prod
make build-prod
make up-prod
make migrate-prod
make ps-prod
```

Обязательный минимум в prod `.env`:
- уникальный `POSTGRES_PASSWORD` (запрещено оставлять `astro_local_only`);
- `TELEGRAM_BOT_TOKEN`, `PSEUDONYM_PEPPER` (≥ 32 байт), `TELEGRAM_WEBHOOK_SECRET` (≥ 8 символов), `INTERNAL_JOB_SECRET` (≥ 8 символов);
- `BOT_USERNAME`, `MINI_APP_URL`, `ADMIN_TG_ID`, `GIGACHAT_AUTH_KEY`;
- `VITE_SUBSCRIPTIONS`, `VITE_BOT_USERNAME`, `VITE_SUPPORT_CONTACT` (для сборки `web`);
- **отсутствующая** переменная `TELEGRAM_API_BASE_URL` (см. §5).

---

## 4. КРИТИЧНО: `VITE_*` — это build-time переменные

Переменные фронтенда (`VITE_API_BASE_URL`, `VITE_BOT_USERNAME`, `VITE_SUPPORT_CONTACT`, `VITE_SUBSCRIPTIONS`) **не читаются контейнером `web` при старте** — Vite подставляет их статически в JS-бандл во время `pnpm --filter @astro-soul/web build` внутри `docker/web.Dockerfile` через `ARG`.

**Типовая ошибка:** поменять `VITE_SUBSCRIPTIONS=enabled` в `.env` и сделать `docker compose restart web` — внутри собранного бандла останется старое значение.

При изменении любой `VITE_*` переменной обязателен **пересбор образа**:

```bash
make build-web
make up          # или make up-prod в проде
```

Дополнительные правила:
- опечатка в `VITE_SUBSCRIPTIONS` (любое значение кроме `enabled`, `off` или пустой строки) намеренно валит сборку (`apps/web/scripts/buildSettings.ts`);
- `VITE_DEV_INIT_DATA` и `VITE_DEV_INVOICE` никогда не передаются в `docker/web.Dockerfile`, а `scripts/check-bundle.mjs` и `scripts/deploy/check.sh --prod` блокируют их попадание в продакшн.

---

## 5. КРИТИЧНО: `TELEGRAM_API_BASE_URL` запрещена в prod

Переменная `TELEGRAM_API_BASE_URL` перенаправляет запросы Bot API на тестовый QA-стаб (`e2e/qa/bot-stub.mjs`). Если она попадёт в prod-окружение, создание инвойсов, подтверждения `pre_checkout_query`, возвраты `refundStarPayment` и пуши будут молча уходить не в `https://api.telegram.org`, и платежи не пройдут.

**Правило:** при создании prod `.env` из `.env.example` **удали или закомментируй** строку `TELEGRAM_API_BASE_URL=...`.

Защита на двух уровнях:
1. `scripts/deploy/check.sh --prod` (вызывается из `make check-prod` / `make up-prod`) проверяет `.env` и окружение оболочки — если `TELEGRAM_API_BASE_URL` задана, выводит ошибку и завершается с кодом `1`.
2. `docker-compose.prod.yml` дополнительно сбрасывает `TELEGRAM_API_BASE_URL: ""`, а `docker/api-entrypoint.sh` снимает пустую переменную перед запуском Node, чтобы `TelegramClient` гарантированно использовал `https://api.telegram.org`.

---

## 6. GigaChat TLS и сертификат НУЦ Минцифры

В приложении проверка TLS не отключается никогда (`apps/api/src/modules/llm/llm.client.ts`), а переменная `GIGACHAT_VERIFY_SSL=false` в проде **запрещена** (блокируется `scripts/deploy/check.sh --prod`).

- Публичная часть корневого сертификата НУЦ Минцифры лежит в `docker/certs/russian_trusted_root_ca.cer` (копия публичного сертификата из `infra/certs/russian_trusted_root_ca.cer`).
- Сертификат монтируется только на чтение (`:ro`) в `/etc/astro-soul/certs/russian_trusted_root_ca.cer` и вшит тем же публичным файлом в образ `api`.
- В `docker-compose.yml` и `docker-compose.prod.yml` `GIGACHAT_CA_BUNDLE` по умолчанию указывает на `/etc/astro-soul/certs/russian_trusted_root_ca.cer`.
- Приватные ключи (`*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*privkey*`) запрещены к попаданию в Git (`.gitignore`) и Docker-контекст (`.dockerignore`).

---

## 7. Миграции, бэкапы и восстановление

### Миграции (`make migrate`)

Автоприменение миграций при старте `api` **запрещено** (защита от гонки при нескольких репликах). Миграции выполняются явной командой:

```bash
make migrate        # dev
make migrate-prod   # prod
```

Сервис `migrate` имеет `profiles: [tools]`, запускает `docker/migrate/run.sh` (`migrate.js` с `pg_advisory_lock` + `seed-plans.js`) и завершается. Последняя миграция в репозитории — `0020_reports_chart_facts_version.sql`.

### Бэкап и восстановление (`make backup` / `make restore`)

```bash
make backup                              # создаст backups/astro_soul_<UTC>.sql.gz и backups/latest.sql.gz
make restore                             # восстановит из backups/latest.sql.gz
make restore FILE=backups/my-dump.sql.gz # восстановление из указанного файла
```

В проде используй `make backup-prod` и `make restore-prod`. Восстановление кратковременно останавливает `api`, накатывает дамп с `ON_ERROR_STOP=1` (работает как на пустую, так и на существующую БД) и снова поднимает `api`.

---

## 8. Проверка перед релизом (чеклист)

```bash
# 1. Инициализация .env и сборка
cp .env.example .env && make up

# 2. Все сервисы healthy
make ps

# 3. Миграции и планы применены
make migrate

# 4. Health API через nginx
curl -fsS http://localhost/api/v1/health

# 5. Бот и вебхук: getMe + состояние вебхука (регистрирует сам API, см. §10)
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
pnpm payments:diagnose

# 6. Сохранность данных при перезапуске
make down && make up

# 7. Чистый старт с нуля (удалит том postgres-data!)
docker compose down -v && make up && make migrate

# 8. Бэкап и восстановление на пустую БД
make backup
docker compose exec -T postgres psql -U "${POSTGRES_USER:-astro}" -d "${POSTGRES_DB:-astro_soul}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
make restore

# 9. Аудит слоёв на утечку секретов
make audit-secrets
```

---

## 9. Тестовые тарифы за 1 ⭐ (только стенд)

Два тарифа за одну звезду: `test_1` (подписка на 30 дней) и `test_report_1`
(разовый разбор одной карты). Оба существуют **только** при
`PAYMENTS_TEST_PLANS=1`; без флага `POST /billing/invoice` отвечает `422` так
же, как на несуществующий тариф.

### Витрина: что продаётся, решает сервер (`GET /billing/plans`)

С контракта 1.5.9 список тарифов отдаёт `GET /billing/plans`: код, вид
(подписка или разовый товар), цену в звёздах, период, название, подзаголовок,
состав и признак `test`. Клиент рисует этот ответ и цену из вёрстки не берёт.

Отсюда две вещи, которые надо знать, прежде чем искать «почему 149 ⭐»:

- при выключенном флаге в ответе **нет** ни `test_1`, ни `test_report_1` —
  не «серых», не скрытых, никак; поэтому блок «Тестовые» в приложении не
  появляется сам собой;
- пока экран пейволла в сборке **этого клиента** рисует список из
  `apps/web/src/lib/plans.ts` (релиз фронта на `GET /billing/plans` идёт
  отдельным заданием), флаг меняет ответ API, но не вид кнопок. Проверить без
  фронта можно тем же эндпоинтом:

```bash
curl -sS http://localhost/api/v1/billing/plans \
  -H "X-Telegram-Init-Data: $INIT_DATA" | grep -c test_report_1
# 0 — флаг выключен; 1 — тестовый тариф в витрине есть
```

Ответ не кэшируется (`Cache-Control: no-store`): он зависит от флага, и
прокси с кэшем показал бы либо старый список, либо тестовые после выключения.

### Где читается флаг

Флаг читает только API, в `apps/api/src/config/env.ts`
(`PAYMENTS_TEST_PLANS: '0' | '1'`), и только из окружения процесса. Дальше он
передаётся по цепочке:

1. `.env` в корне репозитория — для `docker compose` это источник подстановок;
2. `docker-compose.yml`, сервис `api`, строка
   `PAYMENTS_TEST_PLANS: ${PAYMENTS_TEST_PLANS:-}` — compose отдаёт в контейнер
   **только** перечисленные в `environment:` переменные. Без этой строки флаг
   из `.env` до контейнера не доедет, и `POST /billing/invoice` продолжит
   отвечать `422`;
3. контейнер `api` — `process.env.PAYMENTS_TEST_PLANS` для Node.

Без Docker (`pnpm dev:api`, `node dist/main.js`) `.env` не читается вообще —
это разобрано в §2 «`pnpm dev:api` не читает `.env`», до этого раздела
намеренно: расхождение двух способов запуска объясняет больше, чем сам флаг.
Там же префикс команды, если стенд поднят без Docker.

### Включить на стенде

```bash
# 1. Флаг в корневой .env (один флаг на оба тарифа)
printf '\nPAYMENTS_TEST_PLANS=1\n' >> .env

# 2. Пересоздать api: у работающего контейнера окружение уже зафиксировано
docker compose up -d --force-recreate api
#    (при overlay prod-файла — тот же флаг -f docker-compose.yml -f docker-compose.prod.yml)

# 3. Убедиться, что флаг доехал именно до процесса
docker compose logs api | head -3
#   api_started{... "test_plans":true}
#   test_plans_enabled{"plans":["test_1","test_report_1"], ...}

# 4. И что планы есть в БД: тестовые тарифы кладёт сид, а не миграция
make migrate && pnpm db:seed     # ожидаемо: plans синхронизированы: 8
```

Если в логах `"test_plans":false` — флаг не дошёл: проверь строку в
`docker-compose.yml` (шаг 2 этого раздела) и что `.env` лежит в том же
каталоге, из которого запускается `docker compose`.

Третий способ убедиться — метрика: `GET /admin/metrics` отдаёт
`test_plans_active`. В логах видно, что было при старте процесса, а метрика
отвечает, что включено прямо сейчас, — это же и есть сигнал «включил и
забыл», если её видно на проде.

### Выставить счёт за 1 ⭐

Нужны `chart_id` своей карты и `initData` mini-app (другой авторизации в API
нет). `initData` подписывается токеном бота — скрипт `scripts/qa/init-data.mjs`
делает это локально и ничего не пишет на диск:

```bash
# 1. подпись initData для своего telegram id (токен — из .env, не из чата)
INIT_DATA=$(node scripts/qa/init-data.mjs --token "$TELEGRAM_BOT_TOKEN" --user <ваш_tg_id>)

# 2. id своей карты (наружу в проде смотрит nginx на WEB_HTTP_PORT, по умолчанию 80)
curl -sS http://localhost/api/v1/charts/current \
  -H "X-Telegram-Init-Data: $INIT_DATA"

# 3. счёт на разбор за 1 ⭐ для этой карты
curl -sS -X POST http://localhost/api/v1/billing/invoice \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Init-Data: $INIT_DATA" \
  -d '{"plan_code":"test_report_1","chart_id":"<chart_id>"}'
```

В ответе — `stars: 1` и `invoice_link`; ссылку открывают в Telegram, платят
одну звезду, дальше всё как у `one_149`: доступ `report` появляется только на
этой карте, на второй карте остаётся цена. Повторный счёт на уже купленную
карту — `422 report_already_owned` (и для `test_report_1`, и для `one_149`).
Подписка — то же самое с `"plan_code":"test_1"` и без `chart_id`.

Стоимость настоящего разбора при этом не тестовая: ~17,5–23 ₽ за прогон при
выручке 1,2 ₽. Если проверяется только путь оплаты, поставь `LLM_FAKE=1`,
чтобы разбор не ходил в GigaChat.

### Выключить и не забыть

```bash
# 1. Убрать строку из .env (или поставить PAYMENTS_TEST_PLANS=0)
# 2. Пересоздать контейнер — иначе старое окружение останется жить
docker compose up -d --force-recreate api
```

`make check-prod` (`scripts/deploy/check.sh --prod`) считает флаг в `.env`
ошибкой и не даёт собрать прод с ним; `./check.sh --prod` блокирует запуск,
если флаг попал в окружение процесса. Два независимых сторожа — потому что
`docker-compose.yml` пробрасывает флаг, и одного «мы помним» тут мало.

---

## 10. Типовые ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `EnvValidationError` при старте `api` | Пустой или короткий `TELEGRAM_BOT_TOKEN` (< 10) / `PSEUDONYM_PEPPER` (< 32) | Заполни переменные в `.env` и перезапусти `make up` |
| `/api/v1/health` отдаёт `status: degraded`, `astro: down` | Контейнер `astro` не поднялся или недоступен | Проверь `make logs SERVICE=astro` и `make ps` |
| Сменили `VITE_SUBSCRIPTIONS`, но экран не изменился | Использован `restart` вместо пересбора `web` | Выполни `make build-web && make up` |
| Ошибка `VITE_SUBSCRIPTIONS is «...»` при сборке | Опечатка в значении `VITE_SUBSCRIPTIONS` | Допустимо только `enabled`, `off` или пусто |
| `422 consent.version` у части пользователей после релиза | Старый `index.html` закэширован прокси | Убедись, что прокси не перетирает `Cache-Control: no-cache, must-revalidate` из `docker/conf.d/default.conf` |
| `webhook` отвечает `403` | Не задан или не совпадает `TELEGRAM_WEBHOOK_SECRET` в URL и заголовке `X-Telegram-Bot-Api-Secret-Token` | Задай `TELEGRAM_WEBHOOK_SECRET` в `.env`, пересоздай `api` и повтори `setWebhook` |
| Включил `PAYMENTS_TEST_PLANS=1`, а в приложении по-прежнему 149 ⭐ | Сборка клиента ещё рисует пейволл из `apps/web/src/lib/plans.ts`, а не из `GET /billing/plans` | Проверь ответ API (§9): `test_report_1` там есть — значит флаг работает, ждём релиз фронта |
| `GET /billing/plans` отдаёт кэш без тестовых тарифов после включения флага | Прокси кэширует витрину | Витрина отдаётся с `Cache-Control: no-store`; проверь, что кэш не перетирается перед `api` |
| `POST /billing/invoice` с `test_report_1` даёт `422`, хотя флаг в `.env` | `docker-compose.yml` не перечисляет переменную в `environment:` или контейнер не пересоздан | Проверь `test_plans` в `api_started` (§9, шаг 3) |
| `500 invoices_plan_code_fkey` на счёте тестового тарифа | В БД нет строки `plans` для тестового тарифа | `pnpm db:seed` после `make migrate` |
| `gigachat: TLS-ошибка` | Повреждён или не подключён `GIGACHAT_CA_BUNDLE` | Проверь наличие `docker/certs/russian_trusted_root_ca.cer` и путь `/etc/astro-soul/certs/russian_trusted_root_ca.cer` |

---

## 11. Памятка для следующего агента (`init-vps`)

1. **TLS и домен (`web`):** возьми `docker/conf.d/ssl.conf.example`, подставь домен, сохрани как `docker/conf.d/ssl.conf`, раскомментируй проброс `443:8443` и монтирование `/etc/letsencrypt` + `ssl.conf` в `docker-compose.prod.yml`. При редиректе `80 → 443` перенастрой `healthcheck` сервиса `web` на `http://127.0.0.1:8080/nginx-health`.
2. **Крон-джобов (`infra/systemd/`):** в проде порт `api:8080` наружу не публикуется, поэтому в `/etc/astro-soul/jobs.env` укажи `ASTRO_JOBS_URL=http://127.0.0.1/api/v1/internal/jobs/run` (или HTTPS-адрес домена) и точный `INTERNAL_JOB_SECRET`. В `docker/conf.d/default.conf` для `/api/v1/internal/jobs/` уже выставлен `proxy_read_timeout 330s`.
3. **Что нельзя менять/переопределять:**
   - не открывай порты `postgres`, `redis`, `api` и `astro` наружу в `docker-compose.prod.yml`;
   - не добавляй `TELEGRAM_API_BASE_URL`, `GIGACHAT_VERIFY_SSL=false` и `PAYMENTS_TEST_PLANS=1` в prod `.env`;
   - не меняй `PSEUDONYM_PEPPER` после первых пользователей (сломает связь подписок и платежей);
   - не редактируй применённые файлы в `migrations/` и не переноси миграции в entrypoint `api`.
4. **Тома и бэкапы:** данные БД лежат в именованном томе Docker `astro-soul_postgres-data` (`/var/lib/postgresql/data`). Настрой регулярный cron на `make backup-prod` и выгрузку `./backups/*.sql.gz` во внешнее хранилище.
5. **Откат релиза:** перед обновлением сними `make backup-prod`; при откате верни предыдущий коммит/тег (`IMAGE_TAG=<prev>`), выполни `make build-prod && make up-prod` (с теми же `VITE_*` build-args), а при необходимости отката схемы БД — `make restore-prod FILE=backups/<пре-релизный>.sql.gz`.

---

## 10. Вебхук Telegram и диагностика оплаты

### Вебхук регистрируется сам

Раньше адрес вебхука регистрировал человек — строкой `curl` из чеклиста выше.
Это была самая тихая поломка в продукте: если адрес забыли, указывает на
старый домен или секрет в `.env` сменился, Telegram просто **не присылает**
`pre_checkout_query` — окно оплаты открывается, лоадер крутится, человек видит
«ошибка оплаты», а в логах API нет ни одной строки о запросе (итерация 25).

Теперь при старте API (`TelegramWebhookService`):

```text
getWebhookInfo → адрес ≠ ожидаемому → setWebhook → getWebhookInfo (проверка)
```

Ожидаемый адрес собирается из окружения:

| Переменная | Что делает |
|---|---|
| `MINI_APP_URL` | публичный адрес мини-аппа; вебхук — `<MINI_APP_URL>/api/v1/internal/telegram/webhook/<secret>` (nginx проксирует `/api/` в API) |
| `TELEGRAM_WEBHOOK_SECRET` | секрет в пути **и** в заголовке `X-Telegram-Bot-Api-Secret-Token` (одинаковое значение, как требует Bot API) |
| `TELEGRAM_WEBHOOK_AUTO` | `1` (по умолчанию) — сверять и перерегистрировать; `0` — только проверять, адрес ведёт кто-то снаружи |

`drop_pending_updates` не выставляется никогда: в очереди могут лежать
платежи. Секрет в логах маскируется (`***6789`). Состояние пишется в лог
`telegram_webhook_state`: `ok`, `registered`, `mismatch`, `not_configured`,
`unreachable`, `failed` — ненулевой признак проблемы виден сразу после
рестарта, а не через жалобу «оплата не проходит».

#### Почему «зарегистрировали один раз» недостаточно (итерация 26)

`setWebhook` на **нерезолвящийся** адрес Telegram принимает молча: `ok: true`,
а потом `pre_checkout_query` не приходит — бот не может достучаться до нашего
домена. Ровно это происходит после каждого перезапуска quick-туннеля
`cloudflared`: адрес новый, старый уже не резолвится, а в логах тишина.

Поэтому теперь перед вызовом Bot API API резолвит хост `MINI_APP_URL` (таймаут
2 с) и при провале пишет не «ошибка», а причину и лечение:

```text
WARN telegram_webhook_unreachable
  hint: адрес MINI_APP_URL (abc-def.trycloudflare.com) не резолвится: getaddrinfo ENOTFOUND.
        Telegram не сможет доставить pre_checkout_query — оплата в Telegram работать
        не будет. Запусти туннель (cloudflared tunnel --url http://localhost:3000),
        проверь MINI_APP_URL и перезапусти API: pnpm payments:diagnose --set-webhook
```

Состояние вебхука видно снаружи, без ssh в контейнер:

| Где | Поле | Значения |
|---|---|---|
| `GET /api/v1/health` | `telegram_webhook` | `ok` — адрес подтверждён, проверка моложе суток; `stale` — проверки не было или она старше суток; `unreachable` — не резолвится адрес, Bot API недоступен или `setWebhook` не подтвердился |
| `GET /admin/metrics` | `telegram_webhook_ok`, `telegram_webhook_checked_at` | то же число и время проверки — для мониторинга |

**После каждого запуска туннеля — `pnpm payments:diagnose --set-webhook`.**
Иначе адрес в Telegram остаётся от прошлого запуска, и оплата не проходит при
живом API. Для разработки правильнее **именованный** туннель (постоянный
адрес): тогда `MINI_APP_URL` не меняется, и перерегистрация нужна только после
смены домена. Quick-туннель (`cloudflared tunnel --url …`) — для разовой
проверки, не для ежедневной работы: он выдаёт новый адрес при каждом старте.

### `pnpm payments:diagnose`

```bash
pnpm payments:diagnose                # бот, вебхук, каталог, деньги за 24 часа
pnpm payments:diagnose --periods      # + живой createInvoiceLink по периодам
pnpm payments:diagnose --set-webhook  # перерегистрировать вебхук
pnpm payments:diagnose --json         # машиночитаемый отчёт
```

Что показывает: `getMe` (какой бот отвечает за токен), `getWebhookInfo` +
ожидаемый адрес + вердикт + строку «что делать», если адрес не резолвится;
все тарифы с **названием счёта** `invoice_title`, его длиной (`17/32`) и
периодом подписки (лимит — 2 592 000 секунд); живую таблицу
«период → ответ → текст ошибки» и деньги за сутки: счета и платежи по
статусам, зависшие платежи, события `pre_checkout_*` и причины отказов.
Работает и на продовых переменных — это только чтение (кроме `--set-webhook`).

В счёт Telegram уходит **`invoice_title`** (`plans.invoice_title`, 1–32
символа, `CHECK` в БД), а не название тарифа и не название на витрине. Правится
без релиза:

```bash
pnpm plans:set-titles --code=month_399 --title="Подписка на месяц"
# 33 символа скрипт не запишет: покажет длину и предложит сокращённый вариант
```

Если `invoice_title` окажется вне лимита, `POST /billing/invoice` отвечает
`409 CONFLICT` (`details.reason = plan_invoice_title_invalid`), а не `502`:
это наша ошибка данных, а не отказ платёжной системы, и человеку предлагается
другой тариф. `setWebhook` при этом не вызывается вовсе.

`/admin/metrics` (контракт 1.6.2) отдаёт ту же картину числами:
`pre_checkout_total_24h`, `pre_checkout_rejected_24h`,
`pre_checkout_timeout_24h`, `successful_payment_total_24h`,
`payment_failed_24h`, а состояние доставки — `telegram_webhook_ok` и
`telegram_webhook_checked_at`.

Совместимость видна там же числами (контракт 1.6.3):
`compat_sections_trimmed_24h` — сколько разделов пришлось сократить по длине,
`compat_sections_dropped_24h` — сколько выброшено. Второе обязано быть близко
к нулю: раздел теряется только на пустом или неразобранном ответе модели, а не
на длине.

### Если оплата всё равно не проходит

| Что видно | Где смотреть | Что значит |
|---|---|---|
| `pre_checkout_total_24h = 0`, попытки были | `pnpm payments:diagnose` | вебхук не доставляет: адрес, домен, секрет или блокировка Telegram |
| `pre_checkout_rejected_24h` растёт | лог `pre_checkout_rejected` (`reason`) | доставка работает, отказ у нас: сумма, счёт, план |
| `pre_checkout_timeout_24h` > 0 | лог `pre_checkout_timeout`, `pre_checkout_slow` | не уложились в 10 секунд: база или таймауты |
| `payment_failed_24h` растёт | `payments.reject_reason`, `payment_grant_failed` | деньги пришли, доступ не выдан |
| счёт не создаётся, в логе `invoice_title_invalid`, ответ `409 plan_invoice_title_invalid` | `plans.invoice_title` (`pnpm plans:set-titles`) | наша ошибка данных: название счёта вне 1–32, Bot API не вызывался |
| счёт не создаётся, в логе `invoice_params_invalid` | `plans.description`/`price_label` | данные каталога вне лимитов Bot API |
| `telegram_webhook: stale` в `/health` | перезапустить API, `pnpm payments:diagnose --set-webhook` | проверки не было или она старше суток — про адрес ничего не известно |
| `telegram_webhook: unreachable` в `/health` | строка `hint` в логе `telegram_webhook_unreachable` | `MINI_APP_URL` не резолвится (туннель перезапущен) или Bot API недоступен |
| `409 plan_period_unsupported` | `payments.md` §3.6 | тариф-подписка с периодом, которого Telegram не принимает |
