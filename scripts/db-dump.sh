#!/usr/bin/env bash
# scripts/db-dump.sh — дамп PostgreSQL и выгрузка с сервера (итерация 36).
#
# Что делает, по шагам и без сюрпризов:
#   1) проверяет настройки и свободное место;
#   2) делает `pg_dump -Fc` во временный файл (`.<имя>.partial`), чтобы
#      недописанный дамп никогда не выглядел готовым;
#   3) переименовывает временный файл в датированный (атомарный `mv` в той же
#      директории);
#   4) выгружает файл с сервера (S3-совместимое хранилище через `aws s3 cp`
#      или отдельный хост через `scp`);
#   5) только после успешной выгрузки переписывает файл-маркер
#      `BACKUP_STATE_FILE` — по его mtime алерт `backup_stale` в
#      `GET /admin/alerts` считает, что бэкапы живы;
#   6) удаляет дампы старше `BACKUP_RETENTION_DAYS` (по умолчанию 7 дней).
#
# Правило, ради которого всё написано именно так: **успех означает, что копия
# лежит вне сервера**. Локальный файл без выгрузки — не бэкап: он умирает
# вместе с диском. Поэтому отсутствие настроек выгрузки — это ошибка (код 2),
# а не «пропустим и продолжим».
#
# Секретов в репозитории нет: креденшелы S3 берутся из окружения/`~/.aws`
# (штатное поведение `aws`), `scp` — из `~/.ssh`. В скрипте и документации
# только имена переменных.
#
# Коды выхода (по ним настраивается алерт в cron/системном мониторинге):
#   0 — дамп сделал и выгрузил
#   2 — не настроено окружение / нет `pg_dump` / нет `DATABASE_URL`
#   3 — мало свободного места на диске
#   4 — `pg_dump` завершился ошибкой (файл удалён)
#   5 — выгрузка не удалась (локальный файл удалён: половина бэкапа хуже, чем
#       явная ошибка)
#   6 — не удалось переписать файл-маркер (дамп выгружен, но мониторинг об этом
#       не узнает — это тоже ошибка)
#
# ── Режим дампа: `BACKUP_DUMP_MODE=host|exec` (Б-3, итерация 45) ───────────
# `host` (по умолчанию) — `pg_dump` на самой машине подключается к
# `DATABASE_URL`. Так работает стенд и локальная разработка, где Postgres
# слушает порт.
#
# `exec` — `pg_dump` выполняется **внутри контейнера** Postgres:
#   docker compose exec -T <BACKUP_COMPOSE_SERVICE> sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -d "$POSTGRES_DB"'
# Зачем: на проде порт Postgres наружу не публикуется (`docker-compose.prod.yml`,
# сеть `internal`), и хост не может к нему подключиться — то есть режим `host`
# там падает с «connection refused», а не «нет бэкапа». Второй вариант в той же
# ситуации — публиковать 5432 на 127.0.0.1; это решение сервера, а не
# репозитория, и оно шире, чем бэкап. `exec` не требует ни открытого порта, ни
# `pg_dump` на хосте: нужен только `docker` и compose-файл.
#
# В режиме `exec` `DATABASE_URL` не нужен и не проверяется; `POSTGRES_USER`/
# `POSTGRES_DB` берутся из окружения самого контейнера, поэтому копия пароля в
# cron-окружении не появляется.
#
# Примеры запуска — в `docs/BACKUP.md`.

set -euo pipefail

readonly EXIT_CONFIG=2
readonly EXIT_DISK=3
readonly EXIT_DUMP=4
readonly EXIT_UPLOAD=5
readonly EXIT_STATE=6

log() {
  # Время в каждой строке: в cron-логах иначе не понять, что к чему.
  printf '%s db-dump: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  local code="$1"
  shift
  log "FAILED ($code): $*"
  exit "$code"
}

: "${DATABASE_URL:=}"
: "${BACKUP_DIR:=var/backups}"
: "${BACKUP_RETENTION_DAYS:=7}"
: "${BACKUP_MIN_FREE_MB:=512}"
: "${BACKUP_S3_URL:=}"
: "${BACKUP_REMOTE:=}"
: "${BACKUP_STATE_FILE:=}"
: "${PG_DUMP_BIN:=pg_dump}"
: "${BACKUP_DUMP_MODE:=host}"
: "${BACKUP_DOCKER_BIN:=docker}"
: "${BACKUP_COMPOSE_SERVICE:=postgres}"
: "${BACKUP_COMPOSE_FILE:=}"

case "$BACKUP_DUMP_MODE" in
  host)
    [ -n "$DATABASE_URL" ] || die "$EXIT_CONFIG" "не задан DATABASE_URL"
    command -v "$PG_DUMP_BIN" >/dev/null 2>&1 ||
      die "$EXIT_CONFIG" "не найден pg_dump ($PG_DUMP_BIN)"
    ;;
  exec)
    # `DATABASE_URL` здесь не нужен: подключение делает pg_dump внутри
    # контейнера, где переменные POSTGRES_* уже есть.
    command -v "$BACKUP_DOCKER_BIN" >/dev/null 2>&1 ||
      die "$EXIT_CONFIG" "BACKUP_DUMP_MODE=exec, но не найден $BACKUP_DOCKER_BIN"
    ;;
  *)
    die "$EXIT_CONFIG" "BACKUP_DUMP_MODE='$BACKUP_DUMP_MODE': допустимо host или exec"
    ;;
esac

if [ -z "$BACKUP_S3_URL" ] && [ -z "$BACKUP_REMOTE" ]; then
  die "$EXIT_CONFIG" "не настроена выгрузка: нужен BACKUP_S3_URL или BACKUP_REMOTE (локальная копия — не бэкап)"
fi

if [ -n "$BACKUP_S3_URL" ]; then
  command -v aws >/dev/null 2>&1 || die "$EXIT_CONFIG" "BACKUP_S3_URL задан, но не найден aws cli"
else
  command -v scp >/dev/null 2>&1 || die "$EXIT_CONFIG" "BACKUP_REMOTE задан, но не найден scp"
fi

[ "$BACKUP_RETENTION_DAYS" -ge 7 ] 2>/dev/null ||
  die "$EXIT_CONFIG" "BACKUP_RETENTION_DAYS должно быть числом ≥ 7 (иначе не наберётся неделя истории)"

mkdir -p "$BACKUP_DIR" || die "$EXIT_CONFIG" "не удалось создать каталог $BACKUP_DIR"

# Свободное место: 1 КБ-блоки в POSIX-выводе `df -P`. Запас в 1 МБ на округление.
avail_kb="$(df -P "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
avail_kb="${avail_kb:-0}"
need_kb=$(( BACKUP_MIN_FREE_MB * 1024 ))
if [ "$avail_kb" -lt "$need_kb" ]; then
  die "$EXIT_DISK" "мало места в $BACKUP_DIR: свободно $(( avail_kb / 1024 )) МБ, нужно $BACKUP_MIN_FREE_MB МБ"
fi

stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
readonly base="astro-soul-${stamp}.dump"
readonly final_path="${BACKUP_DIR}/${base}"
readonly partial_path="${BACKUP_DIR}/.${base}.partial"

cleanup_partial() {
  rm -f "$partial_path"
}
# Любой выход из скрипта убирает недописанный файл: наполовину записанный дамп
# опаснее отсутствующего — он выглядит как бэкап и восстанавливается с ошибкой.
trap cleanup_partial EXIT

if [ "$BACKUP_DUMP_MODE" = "exec" ]; then
  compose_args=(exec -T)
  if [ -n "$BACKUP_COMPOSE_FILE" ]; then
    compose_args+=(-f "$BACKUP_COMPOSE_FILE")
  fi
  compose_args+=("$BACKUP_COMPOSE_SERVICE" sh -c 'pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"')

  log "дамп контейнера $BACKUP_COMPOSE_SERVICE → $final_path"
  # Дамп идёт в stdout контейнера, а не в файл внутри него: файл обязан лежать
  # на хосте, иначе `docker compose down -v` уносит бэкап вместе с базой.
  if ! "$BACKUP_DOCKER_BIN" compose "${compose_args[@]}" > "$partial_path"; then
    die "$EXIT_DUMP" "pg_dump в контейнере завершился ошибкой"
  fi
else
  log "дамп $DATABASE_URL → $final_path"
  if ! "$PG_DUMP_BIN" --format=custom --no-owner --no-acl --file="$partial_path" "$DATABASE_URL"; then
    die "$EXIT_DUMP" "pg_dump завершился ошибкой"
  fi
fi

[ -s "$partial_path" ] || die "$EXIT_DUMP" "pg_dump создал пустой файл"

mv -f "$partial_path" "$final_path" || die "$EXIT_DUMP" "не удалось переименовать дамп"

size_bytes="$(wc -c < "$final_path" | tr -d ' ')"
log "готово: $base ($(( size_bytes / 1024 )) КБ)"

if [ -n "$BACKUP_S3_URL" ]; then
  log "выгрузка в $BACKUP_S3_URL/$base"
  if ! aws s3 cp --only-show-errors "$final_path" "${BACKUP_S3_URL%/}/${base}"; then
    rm -f "$final_path"
    die "$EXIT_UPLOAD" "aws s3 cp не удался; локальный файл удалён"
  fi
else
  log "выгрузка на $BACKUP_REMOTE"
  if ! scp -q -o BatchMode=yes "$final_path" "${BACKUP_REMOTE}:"; then
    rm -f "$final_path"
    die "$EXIT_UPLOAD" "scp не удался; локальный файл удалён"
  fi
fi

# Маркер только после выгрузки: его mtime — единственное доказательство, что
# копия лежит вне сервера.
if [ -n "$BACKUP_STATE_FILE" ]; then
  mkdir -p "$(dirname "$BACKUP_STATE_FILE")" || die "$EXIT_STATE" "не удалось создать каталог для маркера"
  printf 'file=%s\nsize_bytes=%s\nuploaded_at=%s\n' "$base" "$size_bytes" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    > "$BACKUP_STATE_FILE" || die "$EXIT_STATE" "не удалось записать $BACKUP_STATE_FILE"
fi

# Ротация — только локальных копий: на удалённой стороне жизненным циклом
# объекта управляет хранилище (S3 lifecycle), а не этот скрипт.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'astro-soul-*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete |
  while read -r old; do
    log "удалён старый дамп $old"
  done

log "OK: $base выгружен"
