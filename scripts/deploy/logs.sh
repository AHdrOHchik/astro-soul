#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

services=()
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod] [service...]"
      exit 0
      ;;
    *) services+=("$arg") ;;
  esac
done

require_docker
run_compose logs --tail=200 -f "${services[@]}"
