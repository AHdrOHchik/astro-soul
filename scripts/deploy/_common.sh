#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DEPLOY_ENV="${DEPLOY_ENV:-dev}"

compose_args() {
  local -a args=("-f" "$ROOT_DIR/docker-compose.yml")
  if [[ "$DEPLOY_ENV" == "prod" ]]; then
    args+=("-f" "$ROOT_DIR/docker-compose.prod.yml")
  fi
  printf '%s\n' "${args[@]}"
}

run_compose() {
  local -a args=()
  while IFS= read -r line; do
    args+=("$line")
  done < <(compose_args)
  docker compose "${args[@]}" "$@"
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ОШИБКА: docker не установлен или отсутствует в PATH" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "ОШИБКА: плагин docker compose недоступен" >&2
    exit 1
  fi
}

# Чтение значения из ENV_FILE без вывода значений в stdout/stderr.
read_dotenv_var() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  local line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  local val="${line#*=}"
  val="${val%$'\r'}"
  # Снимаем парные кавычки по краям, если есть.
  if [[ "$val" =~ ^\"(.*)\"$ ]]; then
    val="${BASH_REMATCH[1]}"
  elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
    val="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$val"
}

load_dotenv_if_present() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}
