#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod]"
      exit 0
      ;;
    *)
      echo "ОШИБКА: неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done

require_docker
load_dotenv_if_present

# Запускаем postgres (если ещё не поднят) и ждём healthy, затем выполняем one-shot migrate.
run_compose up -d --wait postgres
run_compose run --rm migrate
