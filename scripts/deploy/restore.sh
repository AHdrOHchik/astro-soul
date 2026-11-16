#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

BACKUP_FILE=""
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod] [backup.sql.gz]"
      exit 0
      ;;
    *)
      if [[ -z "$BACKUP_FILE" ]]; then
        BACKUP_FILE="$arg"
      else
        echo "ОШИБКА: лишний аргумент: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

require_docker
load_dotenv_if_present

pg_user="${POSTGRES_USER:-astro}"
pg_db="${POSTGRES_DB:-astro_soul}"
target="${BACKUP_FILE:-$ROOT_DIR/backups/latest.sql.gz}"

if [[ ! -f "$target" ]]; then
  echo "ОШИБКА: файл бэкапа не найден: $target" >&2
  exit 1
fi

if ! gzip -t "$target"; then
  echo "ОШИБКА: файл бэкапа не является валидным gzip: $target" >&2
  exit 1
fi

# Убеждаемся, что postgres поднят и healthy.
run_compose up -d --wait postgres

# Если API запущен — временно останавливаем, чтобы активные пулы не мешали DROP/CREATE.
api_was_running=0
if [[ -n "$(run_compose ps --status running -q api)" ]]; then
  api_was_running=1
  run_compose stop api
fi

restore_api() {
  if [[ "$api_was_running" -eq 1 ]]; then
    run_compose start api >/dev/null 2>&1 || true
  fi
}
trap restore_api EXIT

gunzip -c "$target" | run_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db"

if [[ "$api_was_running" -eq 1 ]]; then
  run_compose start api
  api_was_running=0
fi

echo "Восстановление завершено из: $target"
