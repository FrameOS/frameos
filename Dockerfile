# Use the official Python 3.12 image as the base
FROM python:3.12-slim-bookworm

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
RUN apt-get update && \
  apt-get install -y curl xz-utils gcc openssl ca-certificates git # &&

RUN mkdir -p /opt/nim && \
    curl -L https://nim-lang.org/download/nim-2.2.4.tar.xz | tar -xJf - -C /opt/nim --strip-components=1 && \
    cd /opt/nim && \
    sh build.sh && \
    bin/nim c koch && \
    ./koch boot -d:release && \
    ./koch tools

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

# ─── Install Nix (single-user, root, flakes on) ──────────────────────
ARG NIX_VERSION=2.30.2
RUN set -eux; \
    # helper tools + user/group utilities
    apt-get update && apt-get install -y --no-install-recommends \
        curl xz-utils gnupg procps sudo ; \
    \
    # 1. builder group *and* members that really appear in /etc/group
    groupadd -r nixbld ; \
    for i in $(seq 1 10); do \
        useradd -r -m -s /usr/sbin/nologin \
                -g nixbld        \
                -G nixbld        \
                nixbld$i ; \
    done ; \
    \
    # 2. run the no-daemon installer
    curl -L "https://releases.nixos.org/nix/nix-${NIX_VERSION}/install" \
      | sh -s -- --no-daemon --yes ; \
    \
    # 3. make nix usable in this layer
    export USER=root ; \
    . /root/.nix-profile/etc/profile.d/nix.sh ; \
    nix-store --optimise ; \
    nix --version
# keep nix visible for later layers and at runtime
ENV PATH="/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"
RUN mkdir /etc/nix && printf '%s\n' \
      "experimental-features = nix-command flakes" \
      "build-users-group = nixbld" \
    > /etc/nix/nix.conf
ENV USER=root

# Copy the requirements file and install using pip
WORKDIR /app/frameos
COPY frameos/ ./

# Precompile Nim assets before copying the rest of the repository
RUN nimble assets -y

# Reuse the precompiled FrameOS frontend assets for later deploy/cross-builds in this container.
ENV FRAMEOS_USE_PRECOMPILED_ASSETS=1

# Cache a build so that the nix libraries are already there
# RUN make nix-bin
# RUN make nix-update
# RUN rm -rf /app/frameos/result

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
