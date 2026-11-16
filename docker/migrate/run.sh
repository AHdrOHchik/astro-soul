#!/bin/sh
set -eu

# Отдельный шаг применения миграций и синхронизации таблицы plans.
# Идемпотентен: повторный запуск безопасен (advisory lock + schema_migrations + UPSERT plans).
node /app/apps/api/dist/db/migrate.js
node /app/apps/api/dist/db/seed-plans.js
