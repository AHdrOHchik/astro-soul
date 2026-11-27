# DEPLOY — что делает владелец

CI собирает образы и выкладывает их; этот файл — только настройка вокруг и
действия человека. Полный runbook VPS здесь не дублируется.

## GitHub Secrets

| Имя | Что это и как получить |
|---|---|
| `SSH_HOST` | Имя хоста или IP VPS без `ssh://` и без пользователя. Берётся у провайдера. |
| `SSH_PORT` | Порт SSH (обычно `22`), число. |
| `SSH_USER` | Пользователь с доступом к `/srv/astro-soul` и Docker (`deploy`). Создаётся на bootstrap. |
| `SSH_KEY` | Приватный ключ ed25519 **без пароля**: `ssh-keygen -t ed25519 -f deploy_ci -N ''`. Публичная половина — в `~deploy/.ssh/authorized_keys` на сервере. |
| `SSH_KNOWN_HOSTS` | Готовый отпечаток хоста: владелец один раз выполняет `ssh-keyscan -H -p <SSH_PORT> <SSH_HOST>` в доверенном канале и кладёт вывод в секрет. CI `ssh-keyscan` **не запускает**, `StrictHostKeyChecking=yes`. |
| `GHCR_READ_TOKEN` | PAT с `read:packages` и доступом ко всем трём пакетам (`astro-soul-api`, `astro-soul-web`, `astro-soul-admin`). Для private-пакетов — доступ аккаунта к пакетам и SSO, если репозиторий в организации. Логин при `docker login` — пользователь, запустивший `deploy` (`github.actor`), поэтому токен должен принадлежать ему или иметь доступ от его имени. |

## GitHub Variables (`vars`)

Публичные значения: они запекаются в бандл, поэтому держать их в Secrets
бессмысленно и опасно (создаётся второе хранилище прод-секретов).

| Имя | Значение |
|---|---|
| `VITE_API_BASE_URL` | **Пусто.** API и мини-апп на одном origin; непустое значение release блокирует. |
| `VITE_BOT_USERNAME` | Имя бота из BotFather без `@`. Используется мини-аппом и (как `VITE_TG_BOT_USERNAME`) сборкой админки. |
| `VITE_SUPPORT_CONTACT` | `@username` или `https://…` для кнопки поддержки. |
| `VITE_SUBSCRIPTIONS` | `enabled`, `off` или пусто. Другое значение release блокирует. |
| `VITE_NOTIFICATIONS_UI` | `0` по умолчанию; `1` — вместе с `PUSH_ENABLED=1` в `.env` на сервере и **после** его рестарта. С 1.6.19 флаг доезжает до сборки (Б-1 исправлен). |

## Переменные: build-time и runtime (Б-7, 1.6.19)

Разница не косметическая: build-time переменная попадает в файлы при сборке
образа, и «поправить .env и перезапустить» её **не** меняет. Runtime читается
процессом при старте — рестарта контейнера достаточно.

| Переменная | Где задаётся | Когда читается | Что будет, если поменять .env без пересборки |
|---|---|---|---|
| `VITE_API_BASE_URL` | `vars` → `build.args` web | **build-time** | ничего: в бандле останется старое значение |
| `VITE_BOT_USERNAME` | `vars` → `build.args` web | **build-time** | мини-апп продолжит звать старого бота |
| `VITE_SUPPORT_CONTACT` | `vars` → `build.args` web | **build-time** | кнопка поддержки останется прежней |
| `VITE_SUBSCRIPTIONS` | `vars` → `build.args` web | **build-time** | витрина подписок не изменится |
| `VITE_NOTIFICATIONS_UI` | `vars` → `build.args` web | **build-time** (Б-1) | экран согласия не появится сам: нужна пересборка web |
| `PUSH_ENABLED` | `.env` на сервере | runtime (API) | **работает** после `docker compose up -d api` |
| `BACKUP_DUMP_MODE` | `.env`/cron на сервере | runtime (скрипт) | работает со следующего запуска cron (Б-3) |
| `ADMIN_HTTP_PORT` | `.env` на сервере | runtime (compose) | работает после `docker compose --profile admin up -d admin` |

Порядок для пары `PUSH_ENABLED`+`VITE_NOTIFICATIONS_UI` описан в
`.env.example` и `docs/PUSH.md`: сначала API (иначе пуши приходят, а отказаться
негде), потом пересборка web.

## Админка: что осталось за деплоем

Образ публикуется релизом (`ghcr.io/<owner>/astro-soul-admin:<tag>`), сервис
`admin` есть в `docker-compose.yml`/`docker-compose.prod.yml`, но `remote-release.sh`
тянет и поднимает только `api web` (и `migrate`); отсутствующий образ `admin`
он пропускает с пометкой в логе, а не требует его. Это **осознанно**: релиз
мини-аппа не должен зависеть от панели, а панель сейчас выкладывается отдельно.

Чтобы перевести панель на общий путь (задача деплоя, не репозитория):

1. в `deploy/host-edge.yml` (живёт только на сервере) добавить сервису `admin`
   `image: ghcr.io/<owner>/astro-soul-admin:<tag>` — как это сделано для `api`;
2. в `remote-release.sh` добавить `admin` в `pull` и `up -d --profile admin`
   отдельным шагом, чтобы падение панели не останавливало релиз мини-аппа;
3. наружу не открывать `8090`: только через nginx с TLS и авторизацией;
4. проверить: `curl -fsSI http://127.0.0.1:8090/` отдаёт `X-Frame-Options: DENY`.

## Что НЕ живёт в GitHub

`TELEGRAM_BOT_TOKEN`, `PSEUDONYM_PEPPER`, `TELEGRAM_WEBHOOK_SECRET`,
`GIGACHAT_AUTH_KEY` — только в `/srv/astro-soul/.env` на сервере (права `600`,
владелец `deploy`). Туда же: `INTERNAL_JOB_SECRET`, `POSTGRES_PASSWORD`,
`FILE_SIGNING_SECRET`. GitHub не должен становиться вторым хранилищем
прод-секретов: CI только **читает** наличие `INTERNAL_JOB_SECRET` в `.env`
и никогда его не перезаписывает.

## Первый раз: порядок

1. **Bootstrap вручную по runbook владельца:** VPS, пользователь `deploy`,
   Docker + compose v2, `curl`, `rsync`; `/srv/astro-soul` с клоном репозитория;
   `.env` с правами `600`; образ `astro-soul/astro:local` — доставь его по
   разделу «Доставка образа astro (bootstrap)» ниже (CI его не собирает и
   в GHCR не публикует); reverse-proxy для
   `tg-astrosoul.ru` и `admin.tg-astrosoul.ru`. На `admin.*` проксирует
   `/api/` на API **без обрезки префикса** (`proxy_pass http://api:8080;`,
   без завершающего `/`).
2. Создай environment `production` с обязательным подтверждением (required
   reviewers). Без этого шага оба workflow опасны. Добавь Secrets и Variables
   выше, убедись, что `GHCR_READ_TOKEN` видит оба пакета.
3. Создай на сервере `/srv/astro-soul/deploy/host-edge.yml` — host-specific
   файл, который не коммитится в репозиторий. Минимальное содержимое:
   ```yaml
   services:
     api:
       image: ghcr.io/<owner в нижнем регистре>/astro-soul-api:${RELEASE_TAG}
     migrate:
       image: ghcr.io/<owner в нижнем регистре>/astro-soul-api:${RELEASE_TAG}
     web:
       image: ghcr.io/<owner в нижнем регистре>/astro-soul-web:${RELEASE_TAG}
       ports:
         - '127.0.0.1:8081:8080'
   ```
   Имена GHCR — только в нижнем регистре: логин `AHdrOHchik` в имени образа
   пишется `ahdrohchik`. Release публикует образы под нижним регистром
   (см. шаг «Имена образов» в `release.yml`), deploy-скрипт сравнивает имена
   без учёта регистра, но `docker compose` требует нижний регистр в самом
   файле — иначе pull/ps не найдут образ.
   `migrate` переопределён отдельно: в базовом compose у него своё поле `image`,
   и без этой строки миграции полезли бы в Docker Hub. compose при deploy
   собирается из трёх файлов: `docker-compose.yml`, `docker-compose.prod.yml`,
   `deploy/host-edge.yml`. Файл остаётся untracked и переживает
   `git checkout` / `git pull`.
   С порта `127.0.0.1:8081` должен отвечать health-контракт (`status` и `db`)
   по `/api/v1/health`. В шаблоне выше это web-прокси; допустима и схема, где
   на 8081 выведен сам api (web — на 8080): контракт от этого не меняется.
4. Подготовь `/var/www/admin` (владелец `deploy`) — туда rsync'ится статика.
5. `make release TAG=<tag> BOOTSTRAP=1` → approve в environment → проверь в
   summary тег и отпечатки образов; артефакт `admin-dist` обязан пройти страж
   мока.
6. `make deploy TAG=<tag>` → approve → проверь summary: `health`, «Откат: нет».
7. Проверки после выкладки: `curl -fsS http://127.0.0.1:8081/api/v1/health`
   с телом `status == "ok"` **и** `db == "ok"`; на `admin.tg-astrosoul.ru` —
   `/api/v1/health` через тот же origin, `/admin/me` → `401` без cookie,
   изменение без `X-Admin-CSRF` → `403`; лог миграций
   `/srv/astro-soul/var/log/deploy/migrate-<tag>-*.log`.

## Доставка образа astro (bootstrap)

`astro` — единственный образ, который deploy не качает из registry: его нет
в GHCR (и в Docker Hub тоже), он готовится один раз на bootstrap. Deploy
проверяет его наличие до скачивания остального и останавливается с ошибкой
«образ astro-soul/astro:… не найден на сервере», если образа нет.

Тег: базовый compose ждёт `astro-soul/astro:local` (`IMAGE_TAG:-local`).
Если образ называется иначе — пропиши `IMAGE_TAG=<тег>` в `/srv/astro-soul/.env`.

Три способа доставить:

1. Образ уже есть, но с другим тегом:
   ```sh
   docker images 'astro-soul/astro'
   docker tag astro-soul/astro:<старый-тег> astro-soul/astro:local
   ```
2. Собрать один раз на сервере (ручной шаг bootstrap; CI так не делает):
   ```sh
   cd /srv/astro-soul
   docker build -f docker/astro.Dockerfile -t astro-soul/astro:local .
   ```
   Сборка качает `python:3.11-slim-bookworm` из Docker Hub — при таймаутах
   сети просто повтори команду.
3. Надёжнее при нестабильном Docker Hub: собери на любой машине с репозиторием
   и перенеси файлом:
   ```sh
   # на машине-источнике
   docker build -f docker/astro.Dockerfile -t astro-soul/astro:local .
   docker save astro-soul/astro:local | gzip > astro.tgz
   # на сервере
   docker load < astro.tgz
   ```

Проверка: `docker image inspect astro-soul/astro:local >/dev/null && echo ok`.
После этого повтори deploy с тем же тегом — новый release не нужен.

## Откат вручную

Предпочтительно: `make deploy TAG=<previous-tag>` — тот же путь с health и
автоматическим откатом. Если CI недоступен или его откат не сработал:

```sh
cd /srv/astro-soul
RELEASE_TAG=<previous-tag> docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml -f deploy/host-edge.yml \
  up -d --remove-orphans
curl -fsS http://127.0.0.1:8081/api/v1/health   # проверить тело: status и db
```

Откат образов **не откатывает миграции**: при изменении схемы БД восстановление
делается отдельно по runbook (бэкап до релиза обязателен).

## Типовые ошибки deploy

- «в compose нет образа ghcr.io/…» — в `deploy/host-edge.yml` другой регистр
  имени (нужен нижний) или другой тег (нужен именно тег версии, не `latest`).
  В конце сообщения deploy-скрипт показывает, какие образы реально видит
  compose.
- «не найден запуск release с коммитом …» / «RELEASE_TAG=…, ожидался …» —
  deploy запущен с тегом, для которого нет успешного release; сначала прогони
  release с этим тегом.
- `health=failed`, «Откат: да» — деплой откатился и завершился ошибкой;
  смотри лог миграций в `/srv/astro-soul/var/log/deploy/` и
  `health после отката` в summary.
- «не удалось скачать образ … (сеть/registry)» или в логе
  `failed to copy … timeout awaiting response headers` — сбой сети при
  скачивании из Docker Hub/GHCR. Deploy заранее качает недостающие образы
  (`postgres`, `redis`, `api`, `web`) с тремя попытками и останавливается до
  миграций и `up`; просто повтори deploy, а при повторах проверь сеть сервера
  или настрой зеркало registry. `astro` deploy не качает — см. раздел
  «Доставка образа astro (bootstrap)».
- «образ astro-soul/astro:… не найден на сервере» — это bootstrap-зазор, а не
  сбой сети: образ `astro` ниоткуда не скачивается, его готовят один раз.
  Доставь его одним из способов в разделе «Доставка образа astro (bootstrap)»
  и повтори deploy с тем же тегом. Образ `admin` deploy тоже не качает
  (сервис в профиле `admin`) — это нормально, в логе будет «Пропускаю …».
- WARNING `Your credentials are stored unencrypted in …/config.json` —
  безвредно: токен GHCR на время deploy кладётся во временный каталог
  и удаляется по завершении. Если deploy уже запускался старой версией —
  удали `~/.docker/config.json` у SSH-пользователя: там мог остаться токен
  от прежних запусков.

## Известные зазоры

- **Б-5 (Postgres tuning):** `shared_buffers`, `work_mem`, `max_connections`
  остаются дефолтными. Это настройка сервера (память конкретной VPS), в
  репозитории её менять нельзя — иначе значение «на глаз» уедет на все стенды.
  Задача деплоя: после замера `pg_stat_statements` выставить параметры и
  записать их в `/etc/astro-soul/postgres.env`, который читает compose.
- **Б-8 (`X-Forwarded-For`):** в репозитории `proxy_set_header
  X-Forwarded-For $remote_addr` (перезапись, а не дописывание). Если перед
  контейнером появится ещё один прокси (CDN/балансировщик), доверенных
  источников станет два, и настройку надо будет пересмотреть — это решение
  сервера, а не кода. Пока правило одно: клиентский IP берётся из последнего
  хопа, подделанный заголовок не проходит.
- `deploy/host-edge.yml` живёт только на сервере (host-specific), в репозитории
  его нет. Deploy сам скачивает недостающие образы `api`/`web` (и `postgres`/
  `redis`) с повторами; `astro` остаётся локальным с bootstrap, `admin` —
  в профиле и деплоем не требуется.
