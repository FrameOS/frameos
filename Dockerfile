# Use the official Python 3.12 image as the base
FROM python:3.12-slim-bookworm

# Set the working directory
WORKDIR /app

ARG NIM_VERSION=2.2.4
ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net

# Install Node.js based on platform
RUN apt-get update && apt-get install -y curl build-essential libffi-dev redis-server ca-certificates gnupg openssh-client git \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && NODE_MAJOR=22 \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y nodejs docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Install the matching prebuilt Nim toolchain for this base image instead of
# rebuilding Nim from source on every clean Docker build.
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
    curl -fsSL "${FRAMEOS_ARCHIVE_BASE_URL}/prebuilt-deps/${nim_target}/nim-${NIM_VERSION}.tar.gz" -o /tmp/nim.tar.gz; \
    tar -xzf /tmp/nim.tar.gz -C /tmp/nim-download; \
    rm -rf "/tmp/nim-download/nim-${NIM_VERSION}/nim/bin"; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/bin" /opt/nim/bin; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/nim/." /opt/nim/; \
    rm -rf /tmp/nim-download /tmp/nim.tar.gz

ENV PATH="/opt/nim/bin:${PATH}"

RUN nim --version && \
    nimble --version

# frameos/frontend asset compilation depends on the pnpm workspace root too.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /app/
COPY frontend/package.json /app/frontend/package.json

# frameos/frontend needs files from the backend frontend/
COPY frontend/src /app/frontend/src
COPY frontend/schema /app/frontend/schema
COPY versions.json /app/versions.json

# Install frameos nim deps
WORKDIR /app/frameos

COPY frameos/frameos.nimble ./
COPY frameos/nimble.lock ./
COPY frameos/nim.cfg ./

RUN nimble install -d -y && nimble setup

# Install frameos agent nim deps
WORKDIR /app/frameos/agent

COPY frameos/agent/frameos_agent.nimble ./
COPY frameos/agent/nimble.lock ./

# Cache nimble deps for when deploying on frame
RUN nimble install -d -y && nimble setup

# Copy the requirements file and install using pip
WORKDIR /app/frameos
COPY frameos/ ./

# Seed compiled assets and the freshness manifest before copying the rest of the repository
RUN nimble assets -y

# Copy the requirements file and install using pip
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip3 install --upgrade uv \
    && uv venv \
    && uv pip install --no-cache-dir -r requirements.txt

# Change the working directory for pnpm install
WORKDIR /tmp

# Install pnpm and a standalone esbuild package for backend JS-app compilation
RUN npm install -g pnpm@10.27.0 esbuild@0.27.3
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /tmp/
COPY frontend/package.json /tmp/frontend/package.json
COPY frameos/frontend/package.json /tmp/frameos/frontend/package.json
RUN pnpm install --filter @frameos/frontend --frozen-lockfile

# Copy frontend source files and run build
COPY frontend/ /tmp/frontend/
COPY versions.json /tmp/versions.json
RUN pnpm --dir frontend run build

# Delete all files except the dist and schema folders
RUN cd /tmp/frontend && find . -maxdepth 1 ! -name 'dist' ! -name 'schema' ! -name '.' ! -name '..' -exec rm -rf {} \;

# Change back to the main directory
WORKDIR /app

# Copy the rest of the application to the container
COPY . .

RUN rm -rf /app/frontend && mv /tmp/frontend /app/

EXPOSE 8989

CMD ["./docker-entrypoint.sh"]
