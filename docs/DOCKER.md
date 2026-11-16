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

# 5. Бот (getMe и тестовый setWebhook)
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${MINI_APP_URL}/api/v1/internal/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"

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

## 9. Типовые ошибки

| Симптом | Причина | Решение |
|---|---|---|
| `EnvValidationError` при старте `api` | Пустой или короткий `TELEGRAM_BOT_TOKEN` (< 10) / `PSEUDONYM_PEPPER` (< 32) | Заполни переменные в `.env` и перезапусти `make up` |
| `/api/v1/health` отдаёт `status: degraded`, `astro: down` | Контейнер `astro` не поднялся или недоступен | Проверь `make logs SERVICE=astro` и `make ps` |
| Сменили `VITE_SUBSCRIPTIONS`, но экран не изменился | Использован `restart` вместо пересбора `web` | Выполни `make build-web && make up` |
| Ошибка `VITE_SUBSCRIPTIONS is «...»` при сборке | Опечатка в значении `VITE_SUBSCRIPTIONS` | Допустимо только `enabled`, `off` или пусто |
| `422 consent.version` у части пользователей после релиза | Старый `index.html` закэширован прокси | Убедись, что прокси не перетирает `Cache-Control: no-cache, must-revalidate` из `docker/conf.d/default.conf` |
| `webhook` отвечает `403` | Не задан или не совпадает `TELEGRAM_WEBHOOK_SECRET` в URL и заголовке `X-Telegram-Bot-Api-Secret-Token` | Задай `TELEGRAM_WEBHOOK_SECRET` в `.env`, пересоздай `api` и повтори `setWebhook` |
| `gigachat: TLS-ошибка` | Повреждён или не подключён `GIGACHAT_CA_BUNDLE` | Проверь наличие `docker/certs/russian_trusted_root_ca.cer` и путь `/etc/astro-soul/certs/russian_trusted_root_ca.cer` |

---

## 10. Памятка для следующего агента (`init-vps`)

1. **TLS и домен (`web`):** возьми `docker/conf.d/ssl.conf.example`, подставь домен, сохрани как `docker/conf.d/ssl.conf`, раскомментируй проброс `443:8443` и монтирование `/etc/letsencrypt` + `ssl.conf` в `docker-compose.prod.yml`. При редиректе `80 → 443` перенастрой `healthcheck` сервиса `web` на `http://127.0.0.1:8080/nginx-health`.
2. **Крон-джобов (`infra/systemd/`):** в проде порт `api:8080` наружу не публикуется, поэтому в `/etc/astro-soul/jobs.env` укажи `ASTRO_JOBS_URL=http://127.0.0.1/api/v1/internal/jobs/run` (или HTTPS-адрес домена) и точный `INTERNAL_JOB_SECRET`. В `docker/conf.d/default.conf` для `/api/v1/internal/jobs/` уже выставлен `proxy_read_timeout 330s`.
3. **Что нельзя менять/переопределять:**
   - не открывай порты `postgres`, `redis`, `api` и `astro` наружу в `docker-compose.prod.yml`;
   - не добавляй `TELEGRAM_API_BASE_URL` и `GIGACHAT_VERIFY_SSL=false` в prod `.env`;
   - не меняй `PSEUDONYM_PEPPER` после первых пользователей (сломает связь подписок и платежей);
   - не редактируй применённые файлы в `migrations/` и не переноси миграции в entrypoint `api`.
4. **Тома и бэкапы:** данные БД лежат в именованном томе Docker `astro-soul_postgres-data` (`/var/lib/postgresql/data`). Настрой регулярный cron на `make backup-prod` и выгрузку `./backups/*.sql.gz` во внешнее хранилище.
5. **Откат релиза:** перед обновлением сними `make backup-prod`; при откате верни предыдущий коммит/тег (`IMAGE_TAG=<prev>`), выполни `make build-prod && make up-prod` (с теми же `VITE_*` build-args), а при необходимости отката схемы БД — `make restore-prod FILE=backups/<пре-релизный>.sql.gz`.
