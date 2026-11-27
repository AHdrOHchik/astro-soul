#!/usr/bin/env bash
# Выкладка на VPS. deploy.yml передаёт файл по stdin:
#   { printf '%s\n' "$GHCR_READ_TOKEN"; cat scripts/deploy/remote-release.sh; } | ssh ... 'bash -s -- ...'
# Первая строка stdin — токен чтения GHCR (в env GHCR_TOKEN), дальше — этот скрипт.
# Ничего не пишет в .env: прод-секреты живут только на сервере и только читаются.
set -euo pipefail

TAG="${1:-}"
# GHCR принимает только нижний регистр в имени репозитория: `ghcr.io/AHdrOHchik/…`
# — «invalid reference format», и pull падает до скачивания. `release.yml`
# поэтому считает имена образов в шелле (`${owner,,}`); деплой обязан делать то
# же — иначе сборка публикует `ghcr.io/ahdrohchik/astro-soul-api`, а деплой
# ищет `ghcr.io/AHdrOHchik/astro-soul-api` и не находит его.
OWNER_RAW="${2:-}"
OWNER="${OWNER_RAW,,}"
# Логин в GHCR регистронезависим (имя пользователя GitHub), поэтому берём
# переданное значение как есть и только подставляем владельца, если его нет.
GHCR_USER="${3:-$OWNER}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/astro-soul}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8081/api/v1/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
ROLLBACK_TIMEOUT="${ROLLBACK_TIMEOUT:-30}"
PULL_ATTEMPTS="${PULL_ATTEMPTS:-3}"
PULL_RETRY_DELAY="${PULL_RETRY_DELAY:-10}"
HEALTH_BODY="$(mktemp)"
# Токен GHCR живёт только на время deploy: docker login пишет его в config.json
# временного каталога, cleanup его удаляет. WARNING docker про «stored
# unencrypted» относится к этому временному файлу и безвреден.
DOCKER_CONFIG_DIR="$(mktemp -d)"
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"

health="unknown"
rollback="no"
rollback_health=""

die() {
  echo "ОШИБКА deploy: $*" >&2
  exit 1
}

# Маркеры разбирает deploy.yml для $GITHUB_STEP_SUMMARY.
report() {
  printf 'ASTRO_DEPLOY_RESULT tag=%s health=%s rollback=%s\n' "$TAG" "$health" "$rollback"
  if [[ -n "$rollback_health" ]]; then
    printf 'ASTRO_ROLLBACK_HEALTH %s\n' "$rollback_health"
  fi
}

cleanup() {
  docker logout ghcr.io >/dev/null 2>&1 || true
  rm -rf "$DOCKER_CONFIG_DIR"
  rm -f "$HEALTH_BODY"
  report
}
trap cleanup EXIT

[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "некорректный тег '$TAG'"
[[ "$OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "некорректный владелец репозитория '$OWNER'"
[[ -n "${GHCR_TOKEN:-}" ]] || die "GHCR_READ_TOKEN не передан в скрипт"
command -v docker >/dev/null 2>&1 || die "docker не найден в PATH"
docker compose version >/dev/null 2>&1 || die "плагин docker compose недоступен"
command -v curl >/dev/null 2>&1 || die "curl не найден в PATH"

cd "$DEPLOY_ROOT"

# CI читает прод-секрет из .env (проверяет наличие), но никогда его не меняет
# и никуда не выводит. Права и владельца файла задаёт человек на bootstrap.
[[ -f .env ]] || die "нет $DEPLOY_ROOT/.env — создай его по docs/DEPLOY.md"
secret_line="$(grep -E '^[[:space:]]*INTERNAL_JOB_SECRET=' .env | tail -n 1 || true)"
[[ -n "${secret_line#*=}" ]] || die "INTERNAL_JOB_SECRET пуст в .env (значение не выводится)"
env_mode="$(stat -c '%a' .env)"
[[ "$env_mode" == "600" ]] || die "права .env = $env_mode, ожидается 600; CI их не меняет — исправь вручную"
unset secret_line

# host-edge.yml — host-specific файл владельца, не часть репозитория. Он должен
# пережить git checkout/git pull как untracked-файл.
[[ -f deploy/host-edge.yml ]] || die "нет deploy/host-edge.yml — создай его по docs/DEPLOY.md (образы GHCR и порт health)"

# Не перезаписываем чужие правки в отслеживаемых файлах.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "в $DEPLOY_ROOT есть изменённые отслеживаемые файлы — сначала разберись с ними вручную"
fi

git fetch --prune --tags origin

# Тег из main (в том числе короткий SHA из push-релиза) → checkout точного
# коммита. Иначе → главная ветка с обычным fast-forward pull.
tag_commit="$(git rev-parse --verify -q "${TAG}^{commit}" || true)"
if [[ -n "$tag_commit" ]] && git merge-base --is-ancestor "$tag_commit" origin/main; then
  echo "Репозиторий: checkout $TAG (коммит из main)"
  git checkout --detach "$tag_commit"
else
  echo "ВНИМАНИЕ: '$TAG' не найден как коммит в main — git pull --ff-only origin main"
  echo "ВНИМАНИЕ: compose-файлы будут из main, образы — из '$TAG'; проверь, что это один релиз"
  current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ "$current_branch" == "main" ]] || git checkout main
  git pull --ff-only origin main
fi

export RELEASE_TAG="$TAG"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml -f deploy/host-edge.yml)

# Если в host-edge.yml не те образы, которые publish'ит release, откат по image id
# не сработает — проверяем это до каких-либо действий с контейнерами.
# GHCR и docker требуют нижний регистр в имени образа: владелец «AHdrOHchik»
# пишется «ahdrohchik» — как в host-edge.yml и как в release.yml. Без этой
# нормализации проверка и docker tag на откате падают на регистре имени.
owner_lc="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
api_ref="ghcr.io/${owner_lc}/astro-soul-api:${TAG}"
web_ref="ghcr.io/${owner_lc}/astro-soul-web:${TAG}"
mapfile -t compose_images < <("${COMPOSE[@]}" config --images)
# Сравниваем без учёта регистра: host-edge.yml может быть написан и с большой
# буквы, compose всё равно нормализует имя в нижний регистр.
compose_images_lc="$(printf '%s\n' "${compose_images[@]}" | tr '[:upper:]' '[:lower:]')"
require_compose_image() {
  grep -Fxq "$1" <<< "$compose_images_lc" || \
    die "в compose нет образа $1 — поправь deploy/host-edge.yml (имя GHCR в нижнем регистре, тег версии, не latest); compose видит: $(printf '%s ' "${compose_images[@]}")"
}
require_compose_image "$api_ref"
require_compose_image "$web_ref"
# У migrate в базовом compose своё поле image: без оверлея миграции полезли бы
# в astro-soul/api:<IMAGE_TAG> из Docker Hub. compose config --images не даёт
# привязать образ к сервису, поэтому смотрим сам оверлей.
migrate_image_line="$(grep -A8 -E '^[[:space:]]+migrate:[[:space:]]*$' deploy/host-edge.yml \
  | grep -m1 -E '^[[:space:]]+image:[[:space:]]*ghcr\.io/' || true)"
[[ -n "$migrate_image_line" ]] || \
  die "deploy/host-edge.yml должен переопределить image сервиса migrate на GHCR api-образ"

# --password-stdin: токен не попадает ни в аргументы процесса, ни в логи.
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
echo "GHCR: логин выполнен ($GHCR_USER)"

# Запоминаем image id до обновления: после up старый образ перестанет быть
# текущим, но останется на месте и будет использован для отката. {{.Image}} у
# контейнера — id образа; {{.Id}} дал бы id контейнера, его docker tag не примет.
prev_api_id=""
prev_web_id=""
api_cid="$("${COMPOSE[@]}" ps -q api || true)"
web_cid="$("${COMPOSE[@]}" ps -q web || true)"
[[ -z "$api_cid" ]] || prev_api_id="$(docker inspect -f '{{.Image}}' "$api_cid")"
[[ -z "$web_cid" ]] || prev_web_id="$(docker inspect -f '{{.Image}}' "$web_cid")"
echo "Предыдущие image id: api=${prev_api_id:-нет}, web=${prev_web_id:-нет}"

# Образы скачиваем заранее и с повторами: compose run/up сами лезут в registry
# посреди деплоя (у migrate postgres приходит через depends_on), а Docker Hub
# и его CDN иногда отвечают таймаутом. Тянем только недостающее; миграции при
# этом НЕ повторяются — их перезапуск вслепую небезопасен.
pull_with_retry() {
  local img="$1" attempt
  for ((attempt = 1; attempt <= PULL_ATTEMPTS; attempt++)); do
    if docker pull "$img"; then
      return 0
    fi
    if (( attempt < PULL_ATTEMPTS )); then
      echo "ВНИМАНИЕ: не удалось скачать $img (попытка $attempt из $PULL_ATTEMPTS), повтор через ${PULL_RETRY_DELAY}с" >&2
      sleep "$PULL_RETRY_DELAY"
    fi
  done
  return 1
}

for img in "${compose_images[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    continue
  fi
  case "$img" in
    astro-soul/astro|astro-soul/astro:*)
      die "образ $img не найден на сервере — astro не публикуется в GHCR и собирается только на bootstrap; доставь образ по docs/DEPLOY.md и повтори deploy (CI не собирает образы на сервере)"
      ;;
  esac
  echo "Скачиваю образ: $img"
  pull_with_retry "$img" || \
    die "не удалось скачать $img после $PULL_ATTEMPTS попыток (сеть/registry) — миграции и up не запускались, откат не требуется; проверь сеть сервера или зеркало registry и повтори deploy"
done

mkdir -p var/log/deploy
migrate_log="var/log/deploy/migrate-${TAG}-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "Миграции до рестарта API, лог: $DEPLOY_ROOT/$migrate_log"
if ! "${COMPOSE[@]}" --profile tools run --rm migrate 2>&1 | tee "$migrate_log"; then
  die "миграции не прошли (лог: $migrate_log); новый образ ещё не поднимался, откат не требуется"
fi

echo "Подъём сервисов: up -d --remove-orphans"
"${COMPOSE[@]}" up -d --remove-orphans

# Проверяем ТЕЛО ответа, а не только HTTP-код. 200 + status=degraded при
# db=ok — не успех, но и не откат: откат не починит астро/вебхук/пуш,
# а новая версия остаётся на месте и требует ручного разбора.
health_check() {
  local code body
  code="$(curl -sS --max-time 3 -o "$HEALTH_BODY" -w '%{http_code}' "$HEALTH_URL" || true)"
  body="$(cat "$HEALTH_BODY")"
  if [[ "$code" != "200" ]]; then
    printf 'http_%s\n' "$code"
    return
  fi
  if ! grep -Eq '"db"[[:space:]]*:[[:space:]]*"ok"' <<< "$body"; then
    printf 'db_down\n'
    return
  fi
  if grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<< "$body"; then
    printf 'ok\n'
    return
  fi
  if grep -Eq '"status"[[:space:]]*:[[:space:]]*"degraded"' <<< "$body"; then
    printf 'degraded\n'
    return
  fi
  printf 'bad_body\n'
}

wait_health() {
  local timeout="$1" result last_degraded=0
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    result="$(health_check)"
    case "$result" in
      ok)
        printf 'ok\n'
        return 0
        ;;
      degraded)
        last_degraded=1
        ;;
      *)
        last_degraded=0
        ;;
    esac
    sleep 3
  done
  if (( last_degraded == 1 )); then
    printf 'degraded\n'
  else
    printf 'failed\n'
  fi
}

health="$(wait_health "$HEALTH_TIMEOUT")"
echo "health после up: $health"

case "$health" in
  ok)
    ;;
  degraded)
    echo "ВНИМАНИЕ: HTTP 200, db=ok, status=degraded — НЕ считаем успехом и НЕ откатываем. Проверь /health вручную" >&2
    ;;
  *)
    rollback=yes
    echo "Отказ health — автоматический откат на прежние image id" >&2
    if [[ -n "$prev_api_id" ]]; then
      docker tag "$prev_api_id" "$api_ref"
    else
      echo "ВНИМАНИЕ: предыдущего api image id нет (первый деплой?) — откат api невозможен" >&2
    fi
    if [[ -n "$prev_web_id" ]]; then
      docker tag "$prev_web_id" "$web_ref"
    else
      echo "ВНИМАНИЕ: предыдущего web image id нет (первый деплой?) — откат web невозможен" >&2
    fi
    "${COMPOSE[@]}" up -d --remove-orphans
    rollback_health="$(wait_health "$ROLLBACK_TIMEOUT")"
    echo "health после отката: $rollback_health" >&2
    exit 1
    ;;
esac

# prune без -a трогает только dangling-слои: все теги (в том числе последние
# три и предыдущий для отката) остаются на месте.
docker image prune -f
echo "Готово: тег=$TAG, health=$health, откат=$rollback"
