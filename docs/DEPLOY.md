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
| `GHCR_READ_TOKEN` | PAT с `read:packages` и доступом к обоим пакетам (`astro-soul-api`, `astro-soul-web`). Для private-пакетов — доступ аккаунта к пакетам и SSO, если репозиторий в организации. Логин при `docker login` — пользователь, запустивший `deploy` (`github.actor`), поэтому токен должен принадлежать ему или иметь доступ от его имени. |

## GitHub Variables (`vars`)

Публичные значения: они запекаются в бандл, поэтому держать их в Secrets
бессмысленно и опасно (создаётся второе хранилище прод-секретов).

| Имя | Значение |
|---|---|
| `VITE_API_BASE_URL` | **Пусто.** API и мини-апп на одном origin; непустое значение release блокирует. |
| `VITE_BOT_USERNAME` | Имя бота из BotFather без `@`. Используется мини-аппом и (как `VITE_TG_BOT_USERNAME`) сборкой админки. |
| `VITE_SUPPORT_CONTACT` | `@username` или `https://…` для кнопки поддержки. |
| `VITE_SUBSCRIPTIONS` | `enabled`, `off` или пусто. Другое значение release блокирует. |
| `VITE_NOTIFICATIONS_UI` | `0` по умолчанию; `1` только после исправления Б-1 (см. конец файла) и включения `PUSH_ENABLED=1` в `.env` на сервере. |

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
   `.env` с правами `600`; образ `astro-soul/astro:<IMAGE_TAG>` — он должен быть уже
   доставлен на VPS на bootstrap (CI его не собирает и в GHCR не публикует);
   reverse-proxy для
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
       image: ghcr.io/<owner>/astro-soul-api:${RELEASE_TAG}
     migrate:
       image: ghcr.io/<owner>/astro-soul-api:${RELEASE_TAG}
     web:
       image: ghcr.io/<owner>/astro-soul-web:${RELEASE_TAG}
       ports:
         - '127.0.0.1:8081:8080'
   ```
   `migrate` переопределён отдельно: в базовом compose у него своё поле `image`,
   и без этой строки миграции полезли бы в Docker Hub. compose при deploy
   собирается из трёх файлов: `docker-compose.yml`, `docker-compose.prod.yml`,
   `deploy/host-edge.yml`. Файл остаётся untracked и переживает
   `git checkout` / `git pull`.
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

## Известные зазоры

- **Б-1:** в `docker/web.Dockerfile` пока нет `ARG VITE_NOTIFICATIONS_UI`.
  При `vars.VITE_NOTIFICATIONS_UI=1` release падает с внятным сообщением —
  silent-сборки без флага не будет. Минимальная правка Dockerfile — отдельным
  пунктом в PR владельцу.
- **Б-2:** `admin.Dockerfile` и сервиса `admin` в compose нет, поэтому админка
  выкладывается rsync'ом. Когда появится Dockerfile — заменить этот шаг на
  сервис compose.
- `deploy/host-edge.yml` живёт только на сервере (host-specific), в репозитории
  его нет; `compose pull` тянет только `api`/`web`, образ `astro` остаётся
  локальным с bootstrap.
