# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /workspace

# api.openapi.yaml нужен шагу gen:api:check внутри pnpm --filter @astro-soul/web build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json api.openapi.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/tsconfig.build.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY apps/api/src ./apps/api/src
COPY apps/web ./apps/web

# Переменные фронта попадают в бандл на этапе сборки (build-time), а не в runtime-ENV.
ARG VITE_API_BASE_URL=""
ARG VITE_BOT_USERNAME=""
ARG VITE_SUPPORT_CONTACT=""
ARG VITE_SUBSCRIPTIONS=""
# Б-1 (итерация 45): флаг UI уведомлений. Он тоже build-time: без ARG значение
# из `.env`/vars оставалось за бортом сборки, и PUSH_ENABLED=1 включал рассылку
# при выключенном (и невключаемом) экране согласия в приложении.
ARG VITE_NOTIFICATIONS_UI="0"

RUN pnpm --filter @astro-soul/shared build \
 && VITE_API_BASE_URL="${VITE_API_BASE_URL}" \
    VITE_BOT_USERNAME="${VITE_BOT_USERNAME}" \
    VITE_SUPPORT_CONTACT="${VITE_SUPPORT_CONTACT}" \
    VITE_SUBSCRIPTIONS="${VITE_SUBSCRIPTIONS}" \
    VITE_NOTIFICATIONS_UI="${VITE_NOTIFICATIONS_UI}" \
    pnpm --filter @astro-soul/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

ENV TZ=UTC

COPY --chmod=0644 docker/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0644 docker/conf.d/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=101:101 /workspace/apps/web/dist /usr/share/nginx/html

USER 101:101

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

ENTRYPOINT ["nginx", "-g", "daemon off;"]
