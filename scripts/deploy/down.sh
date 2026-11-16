#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

VOLUMES_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    --volumes|-v) VOLUMES_FLAG="--volumes" ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod] [--volumes]"
      exit 0
      ;;
    *)
      echo "ОШИБКА: неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done

require_docker

if [[ -n "$VOLUMES_FLAG" ]]; then
  run_compose down --remove-orphans --volumes
else
  run_compose down --remove-orphans
fi
