# syntax=docker/dockerfile:1.4
FROM python:3.12-slim-bookworm

ARG NIM_VERSION=2.2.4
ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net
ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/frameos-python/bin:/opt/nim/bin:${PATH}"
ENV PYTHONUNBUFFERED=1
ENV FORCE_UNSAFE_CONFIGURE=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        bash \
        bc \
        bison \
        bzip2 \
        ca-certificates \
        cpio \
        curl \
        file \
        flex \
        g++ \
        gawk \
        gcc \
        git \
        gnupg \
        gzip \
        libcrypt-dev \
        libffi-dev \
        libjpeg-dev \
        libfreetype6-dev \
        libncurses-dev \
        libssl-dev \
        make \
        openssh-client \
        patch \
        perl \
        pkg-config \
        rsync \
        sed \
        tar \
        unzip \
        wget \
        xz-utils \
        zlib1g-dev; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*

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
    curl -fsSL "${FRAMEOS_ARCHIVE_BASE_URL}/prebuilt-deps/${nim_target}/nim-${NIM_VERSION}.tar.gz" \
        -o /tmp/nim.tar.gz; \
    tar -xzf /tmp/nim.tar.gz -C /tmp/nim-download; \
    rm -rf "/tmp/nim-download/nim-${NIM_VERSION}/nim/bin"; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/bin" /opt/nim/bin; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/nim/." /opt/nim/; \
    rm -rf /tmp/nim-download /tmp/nim.tar.gz; \
    nim --version; \
    nimble --version

COPY backend/requirements.txt /tmp/frameos-backend-requirements.txt
RUN set -eux; \
    python -m venv /opt/frameos-python; \
    /opt/frameos-python/bin/pip install --upgrade pip; \
    /opt/frameos-python/bin/pip install --no-cache-dir -r /tmp/frameos-backend-requirements.txt

RUN npm install -g pnpm@10.27.0

WORKDIR /tmp/frameos-pnpm-cache
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/package.json ./frontend/package.json
COPY frameos/frontend/package.json ./frameos/frontend/package.json
RUN pnpm install --filter @frameos/frame-frontend --frozen-lockfile

WORKDIR /tmp/frameos-nim-deps
COPY frameos/frameos.nimble frameos/nimble.lock frameos/nim.cfg frameos/config.nims ./
RUN nimble install -d -y && nimble setup

WORKDIR /workspace/frameos
CMD ["bash"]
