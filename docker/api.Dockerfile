# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /workspace

# Копируем манифесты workspace для кэширования слоя зависимостей.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/tsconfig.build.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm --filter @astro-soul/shared build \
 && pnpm --filter @astro-soul/api build \
 && pnpm --filter @astro-soul/api --prod deploy /app/apps/api \
 && rm -rf /app/apps/api/src \
           /app/apps/api/test \
           /app/apps/api/tsconfig.json \
           /app/apps/api/tsconfig.build.json \
           /app/apps/api/vitest.config.ts \
           /app/apps/api/node_modules/.bin

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=UTC \
    PORT=8080

# Каталог приватного хранилища создаётся здесь и уже принадлежит appuser:
# docker инициализирует владельца тома из образа, и без этого шага named volume
# `files-data` оказался бы root-owned — первая же сборка PDF упала бы на записи.
RUN groupadd -g 10001 -r appgroup \
 && useradd -u 10001 -g appgroup -r -s /sbin/nologin -d /app appuser \
 && mkdir -p /app /etc/astro-soul/certs /var/lib/astro-soul/files \
 && chown 10001:10001 /app /var/lib/astro-soul/files

WORKDIR /app

COPY --from=builder --chown=10001:10001 /app/apps/api /app/apps/api
# resolveMigrationsDir() ищет вверх по дереву оба: pnpm-workspace.yaml и migrations/
COPY --chown=10001:10001 pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --chown=10001:10001 migrations /app/migrations
COPY --chmod=0444 docker/certs/russian_trusted_root_ca.cer /etc/astro-soul/certs/russian_trusted_root_ca.cer
COPY --chmod=0755 docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
COPY --chmod=0755 docker/migrate/run.sh /usr/local/bin/migrate-run.sh

USER 10001:10001

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/v1/health').then(async (r) => { if (!r.ok) process.exit(1); const b = await r.json(); process.exit(b.db === 'ok' ? 0 : 1); }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
CMD ["node", "/app/apps/api/dist/main.js"]
