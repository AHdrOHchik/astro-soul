.DEFAULT_GOAL := help

COMPOSE_DEV := docker compose -f docker-compose.yml
COMPOSE_PROD := docker compose -f docker-compose.yml -f docker-compose.prod.yml
IMAGE_TAG ?= local

.PHONY: help check check-prod check-syntax build build-web build-prod \
	up up-prod down down-prod ps ps-prod logs logs-prod \
	migrate migrate-prod backup backup-prod restore restore-prod audit-secrets

help:
	@echo "Доступные цели (dev по умолчанию, *-prod для production overlay):"
	@echo "  check / check-prod   — проверить .env, сертификат НУЦ и docker compose config"
	@echo "  build / build-prod   — собрать образы (VITE_* читаются на этапе сборки)"
	@echo "  build-web            — пересобрать web без кэша (после смены VITE_*)"
	@echo "  up / up-prod         — проверить конфиг и поднять контейнеры"
	@echo "  down / down-prod     — остановить контейнеры (тома сохраняются)"
	@echo "  ps / ps-prod         — статус контейнеров и healthcheck"
	@echo "  logs / logs-prod     — логи сервисов (можно SERVICE=api)"
	@echo "  migrate / migrate-prod — накатить миграции и сид планов (one-shot)"
	@echo "  backup / backup-prod — сделать gzip-дамп БД в backups/ (можно FILE=...)"
	@echo "  restore / restore-prod — восстановить БД из дампа (по умолчанию backups/latest.sql.gz)"
	@echo "  audit-secrets        — проверить слои образов на утечки токенов/ключей"

check:
	./scripts/deploy/check.sh --dev

check-prod:
	./scripts/deploy/check.sh --prod

check-syntax:
	./scripts/deploy/check.sh --syntax-only

build:
	$(COMPOSE_DEV) build

build-web:
	$(COMPOSE_DEV) build --no-cache web

build-prod:
	./scripts/deploy/check.sh --prod
	$(COMPOSE_PROD) build

up:
	./scripts/deploy/up.sh --dev

up-prod:
	./scripts/deploy/up.sh --prod

down:
	./scripts/deploy/down.sh --dev

down-prod:
	./scripts/deploy/down.sh --prod

ps:
	./scripts/deploy/ps.sh --dev

ps-prod:
	./scripts/deploy/ps.sh --prod

logs:
	./scripts/deploy/logs.sh --dev $(SERVICE)

logs-prod:
	./scripts/deploy/logs.sh --prod $(SERVICE)

migrate:
	./scripts/deploy/migrate.sh --dev

migrate-prod:
	./scripts/deploy/migrate.sh --prod

backup:
	./scripts/deploy/backup.sh --dev $(FILE)

backup-prod:
	./scripts/deploy/backup.sh --prod $(FILE)

restore:
	./scripts/deploy/restore.sh --dev $(FILE)

restore-prod:
	./scripts/deploy/restore.sh --prod $(FILE)

audit-secrets:
	@for img in astro-soul/api:$(IMAGE_TAG) astro-soul/astro:$(IMAGE_TAG) astro-soul/web:$(IMAGE_TAG); do \
		echo "=== Checking $$img ==="; \
		if docker history --no-trunc "$$img" | grep -iE 'bot_token|gigachat_auth_key|pseudonym_pepper|internal_job_secret|webhook_secret|vite_dev_init_data'; then \
			echo "ОШИБКА: обнаружено подозрительное упоминание секрета в слоях $$img" >&2; \
			exit 1; \
		fi; \
	done
	@echo "Слои образов чисты от секретов."
