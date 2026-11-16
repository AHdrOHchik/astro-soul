#!/bin/sh
set -eu

# Необязательные переменные в .env могут быть заданы как пустая строка (`VAR=`),
# однако Zod-схема в apps/api/src/config/env.ts отклоняет пустую строку для
# optional URL/secret (например, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_API_BASE_URL).
# Сбрасываем пустые значения в unset до запуска Node и передаём управление
# через `exec`, чтобы Node оставался PID 1 и напрямую получал SIGTERM.
for var in \
  TELEGRAM_WEBHOOK_SECRET \
  TELEGRAM_API_BASE_URL \
  ASTRO_SERVICE_URL \
  GIGACHAT_CA_BUNDLE \
  GIGACHAT_AUTH_KEY \
  GIGACHAT_SCOPE \
  BOT_USERNAME \
  MINI_APP_URL \
  ADMIN_TG_ID \
  INTERNAL_JOB_SECRET \
  SUPPORT_CONTACT \
  GEO_CONTACT_EMAIL \
  LLM_FAKE
do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    unset "$var"
  fi
done

exec "$@"
