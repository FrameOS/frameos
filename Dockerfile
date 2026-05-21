# syntax=docker/dockerfile:1.6

ARG PYTHON_IMAGE=python:3.12-slim-bookworm

FROM ${PYTHON_IMAGE} AS nim-toolchain

ARG NIM_VERSION=2.2.4
ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    . /etc/os-release; \
    distro="${ID}"; \
    release="${VERSION_CODENAME:-${VERSION_ID:-}}"; \
    case "${distro}" in \
      raspios|raspbian) distro="debian" ;; \
      debian|ubuntu) ;; \
      *) echo "Unsupported prebuilt Nim distro: ${distro}" >&2; exit 1 ;; \
    esac; \
    case "${distro}" in \
      debian) \
        case "${release}" in \
          bullseye|bookworm|trixie) ;; \
          *) echo "Unsupported prebuilt Nim release: ${distro}-${release}" >&2; exit 1 ;; \
        esac ;; \
      ubuntu) \
        case "${VERSION_ID}" in \
          22.04|24.04) release="${VERSION_ID}" ;; \
          *) echo "Unsupported prebuilt Nim release: ${distro}-${VERSION_ID}" >&2; exit 1 ;; \
        esac ;; \
    esac; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64|arm64|armhf) ;; \
      *) echo "Unsupported prebuilt Nim architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    nim_target="${distro}-${release}-${arch}"; \
    mkdir -p /opt/nim /tmp/nim-download; \
    echo "${nim_target}" > /opt/nim/.frameos-prebuilt-target; \
    curl -fsSL "${FRAMEOS_ARCHIVE_BASE_URL}/prebuilt-deps/${nim_target}/nim-${NIM_VERSION}.tar.gz" -o /tmp/nim.tar.gz; \
    tar -xzf /tmp/nim.tar.gz -C /tmp/nim-download; \
    rm -rf "/tmp/nim-download/nim-${NIM_VERSION}/nim/bin"; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/bin" /opt/nim/bin; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/nim/." /opt/nim/; \
    rm -rf /tmp/nim-download /tmp/nim.tar.gz

ENV PATH="/opt/nim/bin:${PATH}"

RUN nim --version && nimble --version

FROM nim-toolchain AS app-builder

ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net
ARG QUICKJS_VERSION=2025-04-26
ARG QUICKJS_SHA256=2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      gnupg \
      make \
      pkg-config \
      xz-utils \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@10.27.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml versions.json ./
COPY frontend/package.json frontend/package.json
COPY frameos/frontend/package.json frameos/frontend/package.json
RUN pnpm install --frozen-lockfile

COPY frameos/frameos.nimble frameos/nimble.lock frameos/nim.cfg frameos/config.nims frameos/
WORKDIR /app/frameos
RUN nimble install -d -y && nimble setup

COPY frameos/agent/frameos_agent.nimble frameos/agent/nimble.lock frameos/agent/config.nims /app/frameos/agent/
WORKDIR /app/frameos/agent
RUN nimble install -d -y && nimble setup

WORKDIR /app
COPY frontend frontend
COPY repo/apps repo/apps
COPY repo/scenes repo/scenes
COPY frameos frameos

WORKDIR /app/frameos
RUN nimble assets -y

RUN set -eux; \
    mkdir -p /tmp/quickjs-source /app/frameos/quickjs/include/quickjs; \
    curl -fsSL "${FRAMEOS_ARCHIVE_BASE_URL}/source/vendor/quickjs-${QUICKJS_VERSION}.tar.xz" -o /tmp/quickjs-source.tar.xz; \
    echo "${QUICKJS_SHA256}  /tmp/quickjs-source.tar.xz" | sha256sum -c -; \
    tar -xf /tmp/quickjs-source.tar.xz -C /tmp/quickjs-source; \
    quickjs_source_root="/tmp/quickjs-source/quickjs-${QUICKJS_VERSION}"; \
    make -C "${quickjs_source_root}" qjs libquickjs.a; \
    cp -a "${quickjs_source_root}/quickjs.h" /app/frameos/quickjs/quickjs.h; \
    cp -a "${quickjs_source_root}/quickjs-libc.h" /app/frameos/quickjs/quickjs-libc.h; \
    cp -a "${quickjs_source_root}/quickjs.h" /app/frameos/quickjs/include/quickjs/quickjs.h; \
    cp -a "${quickjs_source_root}/quickjs-libc.h" /app/frameos/quickjs/include/quickjs/quickjs-libc.h; \
    cp -a "${quickjs_source_root}/libquickjs.a" /app/frameos/quickjs/libquickjs.a; \
    cp -a "${quickjs_source_root}/qjs" /app/frameos/quickjs/qjs; \
    chmod +x /app/frameos/quickjs/qjs; \
    strip /app/frameos/quickjs/qjs; \
    /app/frameos/quickjs/qjs -e 'console.log("quickjs ok")'; \
    rm -rf /tmp/quickjs-source /tmp/quickjs-source.tar.xz

WORKDIR /app/frontend
RUN pnpm run build

RUN find /app/frameos -path '*/tests' -type d -prune -exec rm -rf {} + \
    && rm -rf \
      /app/frameos/frontend \
      /app/frameos/build \
      /app/frameos/nimcache \
      /app/frameos/testresults \
      /app/frameos/tmp \
      /app/frameos/agent/build \
      /app/frameos/agent/tmp

FROM ${PYTHON_IMAGE} AS python-deps

ENV DEBIAN_FRONTEND=noninteractive
ENV VIRTUAL_ENV=/app/backend/.venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

WORKDIR /app/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/requirements.docker.in ./
RUN pip install --no-cache-dir --upgrade uv \
    && uv venv \
    && sed -E 's/^fastapi\[standard\]==/fastapi==/' requirements.txt > /tmp/requirements.constraints.txt \
    && uv pip install --no-cache-dir -c /tmp/requirements.constraints.txt -r requirements.docker.in \
    && find "${VIRTUAL_ENV}" -type f \( -name '*.so' -o -name '*.so.*' \) -exec strip --strip-unneeded {} + \
    && find "${VIRTUAL_ENV}" -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find "${VIRTUAL_ENV}" -type f -name '*.pyc' -delete

FROM ${PYTHON_IMAGE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV VIRTUAL_ENV=/app/backend/.venv
ENV PATH="/opt/nim/bin:${VIRTUAL_ENV}/bin:${PATH}"

WORKDIR /app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg iputils-ping redis-server; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
    chmod a+r /etc/apt/keyrings/docker.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

COPY --from=nim-toolchain /opt/nim /opt/nim
COPY --from=app-builder /root/.nimble /root/.nimble
COPY --from=python-deps /app/backend/.venv /app/backend/.venv

COPY docker-entrypoint.sh versions.json ./
COPY backend backend
COPY repo/apps repo/apps
COPY repo/scenes repo/scenes
COPY tools/prebuilt-deps/manifest.json tools/prebuilt-deps/manifest.json
COPY --from=app-builder /app/frontend/dist frontend/dist
COPY --from=app-builder /app/frontend/schema frontend/schema
COPY --from=app-builder /app/frameos frameos

RUN mkdir -p /app/db

EXPOSE 8989

CMD ["./docker-entrypoint.sh"]
