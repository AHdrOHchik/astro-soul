#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

BUILD_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    --build) BUILD_FLAG="--build" ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod] [--build]"
      exit 0
      ;;
    *)
      echo "ОШИБКА: неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done

"$SCRIPT_DIR/check.sh" "--$DEPLOY_ENV"
require_docker

if [[ -n "$BUILD_FLAG" ]]; then
  run_compose up -d --build --remove-orphans
else
  run_compose up -d --remove-orphans
fi
