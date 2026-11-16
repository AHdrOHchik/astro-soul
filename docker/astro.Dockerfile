# syntax=docker/dockerfile:1.7

FROM python:3.11-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY packages/astro/pyproject.toml ./
COPY packages/astro/astro ./astro

RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir .

FROM python:3.11-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=UTC \
    PATH="/opt/venv/bin:$PATH" \
    ASTRO_HOST=0.0.0.0 \
    ASTRO_PORT=8001

RUN groupadd -g 10001 -r astro \
 && useradd -u 10001 -g astro -r -s /sbin/nologin -d /app astro \
 && mkdir -p /app \
 && chown 10001:10001 /app

COPY --from=builder --chown=10001:10001 /opt/venv /opt/venv

WORKDIR /app
USER 10001:10001

EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD python3 -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('ASTRO_PORT', '8001') + '/health', timeout=2).read()" || exit 1

CMD ["python3", "-m", "astro.service"]
