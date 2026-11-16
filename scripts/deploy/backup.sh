#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

OUT_PATH=""
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod] [output.sql.gz]"
      exit 0
      ;;
    *)
      if [[ -z "$OUT_PATH" ]]; then
        OUT_PATH="$arg"
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

backup_dir="$ROOT_DIR/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
target="${OUT_PATH:-$backup_dir/${pg_db}_${ts}.sql.gz}"
mkdir -p "$(dirname "$target")"
tmp_file="${target}.tmp.$$"
trap 'rm -f "$tmp_file"' EXIT

if [[ -z "$(run_compose ps --status running -q postgres)" ]]; then
  echo "ОШИБКА: контейнер postgres не запущен" >&2
  exit 1
fi

run_compose exec -T postgres \
  pg_dump --clean --if-exists --no-owner --no-privileges -U "$pg_user" -d "$pg_db" \
  | gzip -9 > "$tmp_file"

if [[ ! -s "$tmp_file" ]] || ! gzip -t "$tmp_file"; then
  echo "ОШИБКА: дамп БД повреждён или пуст" >&2
  exit 1
fi

chmod 600 "$tmp_file"
mv "$tmp_file" "$target"
cp -f "$target" "$backup_dir/latest.sql.gz"
chmod 600 "$backup_dir/latest.sql.gz"

echo "Бэкап создан: $target"
