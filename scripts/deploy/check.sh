#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/_common.sh
source "$SCRIPT_DIR/_common.sh"

SYNTAX_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_ENV="prod" ;;
    --dev) DEPLOY_ENV="dev" ;;
    --syntax-only) SYNTAX_ONLY=1 ;;
    -h|--help)
      echo "Использование: $0 [--dev|--prod] [--syntax-only]"
      exit 0
      ;;
    *)
      echo "ОШИБКА: неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done

errors=0
err() {
  echo "ОШИБКА: $*" >&2
  errors=$((errors + 1))
}

# 1. Проверка публичного корневого сертификата НУЦ Минцифры (без приватного ключа).
CA_FILE="$ROOT_DIR/docker/certs/russian_trusted_root_ca.cer"
if [[ ! -f "$CA_FILE" ]]; then
  err "не найден сертификат НУЦ Минцифры: docker/certs/russian_trusted_root_ca.cer"
elif grep -qi "PRIVATE KEY" "$CA_FILE"; then
  err "в docker/certs/russian_trusted_root_ca.cer обнаружен приватный ключ — запрещено"
elif ! grep -q "BEGIN CERTIFICATE" "$CA_FILE"; then
  err "docker/certs/russian_trusted_root_ca.cer не похож на PEM-сертификат"
fi

# 2. В режиме --syntax-only проверяем только сертификат и compose-конфигурацию.
if [[ "$SYNTAX_ONLY" -eq 0 ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    err "файл окружения не найден: $ENV_FILE (выполни: cp .env.example .env)"
  else
    if [[ "$DEPLOY_ENV" == "prod" ]]; then
      # Критическая проверка: TELEGRAM_API_BASE_URL в prod запрещена (переводит Bot API на QA-стаб).
      if [[ -n "${TELEGRAM_API_BASE_URL:-}" ]] || grep -Eq '^[[:space:]]*(export[[:space:]]+)?TELEGRAM_API_BASE_URL=' "$ENV_FILE"; then
        err "TELEGRAM_API_BASE_URL задана в prod — запрещено: удали эту переменную из $ENV_FILE и окружения"
      fi

      # Критическая проверка: тестовые тарифы за 1 ⭐ в prod запрещены —
      # при включённом флаге любой, кто знает код (test_1, test_report_1),
      # покупает за одну звезду. docker-compose.yml пробрасывает флаг из .env
      # в контейнер, поэтому проверять нужно и файл, а не только окружение.
      if [[ -n "${PAYMENTS_TEST_PLANS:-}" ]] || grep -Eq '^[[:space:]]*(export[[:space:]]+)?PAYMENTS_TEST_PLANS=' "$ENV_FILE"; then
        err "PAYMENTS_TEST_PLANS задана в prod — запрещено: тестовые тарифы test_1 и test_report_1 за 1 ⭐; удали строку из $ENV_FILE"
      fi

      # Критическая проверка: отключение TLS-проверки GigaChat в prod запрещено.
      verify_ssl="${GIGACHAT_VERIFY_SSL:-$(read_dotenv_var GIGACHAT_VERIFY_SSL "$ENV_FILE" || true)}"
      if [[ "${verify_ssl,,}" == "false" || "$verify_ssl" == "0" ]]; then
        err "GIGACHAT_VERIFY_SSL=false запрещено в prod — используй GIGACHAT_CA_BUNDLE (docker/certs/russian_trusted_root_ca.cer)"
      fi
    fi

    load_dotenv_if_present

    # Обязательный минимум для запуска API (env.ts).
    bot_token="${TELEGRAM_BOT_TOKEN:-}"
    pepper="${PSEUDONYM_PEPPER:-}"
    if [[ -z "$bot_token" || ${#bot_token} -lt 10 ]]; then
      err "TELEGRAM_BOT_TOKEN не задан или короче 10 символов"
    fi
    if [[ -z "$pepper" || ${#pepper} -lt 32 ]]; then
      err "PSEUDONYM_PEPPER не задан или короче 32 байт"
    fi

    # Проверка допустимости VITE_SUBSCRIPTIONS (если задана).
    vite_subs="${VITE_SUBSCRIPTIONS:-}"
    if [[ -n "$vite_subs" && "$vite_subs" != "enabled" && "$vite_subs" != "off" ]]; then
      err "VITE_SUBSCRIPTIONS должен быть enabled, off или пустым"
    fi

    if [[ "$DEPLOY_ENV" == "prod" ]]; then
      pg_pass="${POSTGRES_PASSWORD:-}"
      wh_secret="${TELEGRAM_WEBHOOK_SECRET:-}"
      job_secret="${INTERNAL_JOB_SECRET:-}"

      if [[ -z "$pg_pass" || "$pg_pass" == "astro_local_only" ]]; then
        err "POSTGRES_PASSWORD в prod не должен быть пустым или dev-значением по умолчанию"
      fi
      if [[ -z "$wh_secret" || ${#wh_secret} -lt 8 ]]; then
        err "TELEGRAM_WEBHOOK_SECRET обязателен в prod (минимум 8 символов)"
      fi
      if [[ -z "$job_secret" || ${#job_secret} -lt 8 ]]; then
        err "INTERNAL_JOB_SECRET обязателен в prod (минимум 8 символов)"
      fi
      if [[ -n "${VITE_DEV_INIT_DATA:-}" || -n "${VITE_DEV_INVOICE:-}" ]]; then
        err "VITE_DEV_INIT_DATA и VITE_DEV_INVOICE запрещены в prod"
      fi
      if [[ "${LLM_FAKE:-0}" == "1" ]]; then
        err "LLM_FAKE=1 запрещён в prod"
      fi
    fi
  fi
fi

# 3. Валидация итогового compose-конфига (если Docker установлен).
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if ! run_compose config -q; then
    err "docker compose config завершился с ошибкой (окружение: $DEPLOY_ENV)"
  fi
else
  echo "ПРЕДУПРЕЖДЕНИЕ: docker compose недоступен в среде — валидация YAML через docker compose пропущена" >&2
fi

if [[ "$errors" -gt 0 ]]; then
  echo "Проверка ($DEPLOY_ENV) не пройдена: ошибок $errors" >&2
  exit 1
fi

echo "Проверка окружения ($DEPLOY_ENV): ОК"
