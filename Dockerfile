# Use the official Python 3.12 image as the base
FROM python:3.12-slim-bookworm
ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net
ARG FRAMEOS_PREBUILT_DISTRO=debian
ARG FRAMEOS_PREBUILT_RELEASE=bookworm
ARG NIM_VERSION=2.2.4
ARG QUICKJS_VERSION=2025-04-26
ARG LGPIO_VERSION=v0.2.2

# Set the working directory
WORKDIR /app

# Install Node.js based on platform
RUN apt-get update && apt-get install -y curl build-essential libffi-dev redis-server ca-certificates gnupg openssh-client \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && NODE_MAJOR=22 \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y nodejs docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Install Nim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl xz-utils gcc openssl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/nim && \
    nim_slug="${FRAMEOS_PREBUILT_DISTRO}-${FRAMEOS_PREBUILT_RELEASE}-$(dpkg --print-architecture)" && \
    curl -fsSL --retry 3 --retry-all-errors "${FRAMEOS_ARCHIVE_BASE_URL%/}/prebuilt-deps/${nim_slug}/nim-${NIM_VERSION}.tar.gz" -o /tmp/nim.tar.gz && \
    tar -xzf /tmp/nim.tar.gz -C /opt/nim --strip-components=1 && \
    if [ -d /opt/nim/nim ]; then \
      rm -rf /opt/nim/nim/bin && \
      mv /opt/nim/nim/* /opt/nim/ && \
      rmdir /opt/nim/nim; \
    fi && \
    rm -f /tmp/nim.tar.gz

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

# Install pnpm and seed the workspace manifests for dependency caching
RUN npm install -g pnpm@10.27.0
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
