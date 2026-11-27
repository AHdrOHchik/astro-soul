# syntax=docker/dockerfile:1.7
#
# Админ-панель (Б-2, итерация 45): до этой итерации у панели был `pnpm build`
# и артефакт в CI, но **не было образа** — то есть задеплоить её тем же
# способом, что api/web, было нельзя, и на сервере она либо не стояла, либо
# стояла «руками». Это тот же контейнерный контракт: статика под
# nginx-unprivileged, непривилегированный пользователь, healthcheck.
#
# Панель ходит относительными путями (`/api/v1/...`), поэтому `VITE_API_BASE_URL`
# по умолчанию пустой: один origin, никакого CORS. Если панель когда-нибудь
# поставят на отдельный origin, значение придёт build-аргументом.

FROM node:22-bookworm-slim AS builder

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /workspace

# `api.openapi.yaml` нужен шагу `gen:api:check` внутри `pnpm run typecheck`:
# сборка панели падает, если типы разошлись с контрактом. Это намеренно —
# панель, собранная по старому контракту, врёт о полях ответа.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json api.openapi.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/admin/package.json ./apps/admin/
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/tsconfig.build.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY apps/admin ./apps/admin

# Build-time: панель — SPA, переменные Vite попадают в бандл только при сборке.
ARG VITE_API_BASE_URL=""

# `build` включает `check-no-mock.mjs`: в артефакте не должно быть мокера.
# Здесь тот же страж, что и в CI, — образ нельзя собрать «в обход» него.
RUN pnpm --filter @astro-soul/shared build \
 && VITE_API_BASE_URL="${VITE_API_BASE_URL}" \
    pnpm --filter @astro-soul/admin build \
 && test -s apps/admin/dist/index.html

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

ENV TZ=UTC

# Общий `nginx.conf` (формат логов, маска секрета вебхука) + конфиг панели:
# SPA-fallback, прокси `/api/` на api, запрет встраивания в iframe.
COPY --chmod=0644 docker/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0644 docker/conf.d/admin.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=101:101 /workspace/apps/admin/dist /usr/share/nginx/html

USER 101:101

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

ENTRYPOINT ["nginx", "-g", "daemon off;"]
