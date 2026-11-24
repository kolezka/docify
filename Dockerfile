# syntax=docker/dockerfile:1
# Docify: Bun CLI and web UI with the embedding model and Graphify baked in.
# The build needs network access (bun install, uv sync, model download); the image runs offline.

FROM oven/bun:1.4.4-slim AS bun

FROM python:3.12-slim-bookworm AS runtime

# Bun runs the app and Graphify needs a Python 3.12 interpreter. The slim Python
# base already carries ca-certificates and libstdc++, which is all Bun and the
# onnxruntime binary need on Linux.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /usr/local/bin/

ENV NODE_ENV=production \
    HOME=/home/docify \
    DOCIFY_HOME=/data \
    DOCIFY_MODELS_DIR=/opt/docify/models \
    DOCIFY_GRAPHIFY_BIN=/opt/docify/graphify-venv/bin/graphify \
    DOCIFY_HOST=0.0.0.0 \
    DOCIFY_PORT=4747 \
    DOCIFY_SOURCE_ROOTS=/sources \
    UV_PYTHON_PREFERENCE=system \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

# The app must not run as root; the uid matches the default compose user.
RUN groupadd --gid 10001 docify \
 && useradd --uid 10001 --gid docify --create-home --home-dir /home/docify --shell /bin/sh docify

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tools/graphify ./tools/graphify
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Bake the bge-small model and the pinned Graphify venv into /opt/docify. The venv points at
# the system Python because UV_PYTHON_DOWNLOADS=never; a uv-managed interpreter would live
# under /root and the non-root runtime user could not execute it.
RUN UV_CACHE_DIR=/tmp/uv-cache DOCIFY_HOME=/opt/docify bun src/cli.ts setup \
 && rm -rf /tmp/uv-cache /root/.cache/uv /opt/docify/docify.sqlite*

# /data belongs to the app user so a fresh named volume is writable; /sources is the
# default mount point for local documentation. The baked /opt/docify tree only has to
# be readable.
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /sources \
 && chown -R docify:docify /data /home/docify /sources \
 && chmod -R a+rX /opt/docify

# Repository sources invoke Git during preparation, not during application setup.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

USER docify
RUN git --version
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.DOCIFY_PORT||'4747')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
