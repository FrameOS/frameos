# Use the official Python 3.11 image as the base
FROM python:3.11-slim-bullseye

# Set the working directory
WORKDIR /app

# ------------------------------------------------------------------
# 1. Install system packages and Node.js
# ------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    curl build-essential libffi-dev redis-server ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && NODE_MAJOR=18 \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
       | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs

# ------------------------------------------------------------------
# 2. Install Nim from source
# ------------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y curl xz-utils gcc openssl ca-certificates git

RUN mkdir -p /opt/nim && \
    curl -L https://nim-lang.org/download/nim-2.2.2.tar.xz \
    | tar -xJf - -C /opt/nim --strip-components=1 && \
    cd /opt/nim && \
    sh build.sh && \
    bin/nim c koch && \
    ./koch boot -d:release && \
    ./koch tools

ENV PATH="/opt/nim/bin:${PATH}"

RUN nim --version && nimble --version

# ------------------------------------------------------------------
# 3. Add BOTH arm64 + armhf architectures & install cross toolchains
# ------------------------------------------------------------------
RUN dpkg --add-architecture arm64 \
    && dpkg --add-architecture armhf \
    && apt-get update \
    && apt-get install -y \
       crossbuild-essential-arm64 \
       crossbuild-essential-armhf \
       libc6-dev:arm64 \
       libc6-dev:armhf \
       libevdev-dev:arm64 \
       libevdev-dev:armhf \
       pkg-config \
       wget

# ------------------------------------------------------------------
# 4. Build + install liblgpio for ARM64 (aarch64) to DESTDIR
#    so we don't overwrite the default /usr/local/lib
# ------------------------------------------------------------------
# Build + install liblgpio for ARM64
RUN mkdir -p /tmp/lgpio-arm64 && cd /tmp/lgpio-arm64 && \
    wget -q -O v0.2.2.tar.gz https://github.com/joan2937/lg/archive/refs/tags/v0.2.2.tar.gz && \
    tar -xzf v0.2.2.tar.gz && cd lg-0.2.2 && \
    make clean && make CROSS_PREFIX=aarch64-linux-gnu- && \
    make DESTDIR=/tmp/install-arm64 install && \
    # Remove any /usr/local/lib stuff (if placed) and move final libs
    rm -f /usr/local/lib/liblg*.so* && \
    mkdir -p /usr/lib/aarch64-linux-gnu /usr/include/aarch64-linux-gnu && \
    cp /tmp/install-arm64/usr/local/lib/liblg*.so* /usr/lib/aarch64-linux-gnu/ && \
    cp /tmp/install-arm64/usr/local/include/lgpio.h /usr/include/aarch64-linux-gnu/ && \
    ldconfig && cd / && rm -rf /tmp/lgpio-arm64 /tmp/install-arm64

# ------------------------------------------------------------------
# 5. Build + install liblgpio for ARMHF (arm-linux-gnueabihf) to DESTDIR
# ------------------------------------------------------------------
    RUN mkdir -p /tmp/lgpio-armhf && cd /tmp/lgpio-armhf && \
    wget -q -O v0.2.2.tar.gz https://github.com/joan2937/lg/archive/refs/tags/v0.2.2.tar.gz && \
    tar -xzf v0.2.2.tar.gz && cd lg-0.2.2 && \
    make clean && make CROSS_PREFIX=arm-linux-gnueabihf- && \
    make DESTDIR=/tmp/install-armhf install && \
    rm -f /usr/local/lib/liblg*.so* && \
    mkdir -p /usr/lib/arm-linux-gnueabihf /usr/include/arm-linux-gnueabihf && \
    cp /tmp/install-armhf/usr/local/lib/liblg*.so* /usr/lib/arm-linux-gnueabihf/ && \
    cp /tmp/install-armhf/usr/local/include/lgpio.h /usr/include/arm-linux-gnueabihf/ && \
    ldconfig && cd / && rm -rf /tmp/lgpio-armhf /tmp/install-armhf

# ------------------------------------------------------------------
# 6. Install Python dependencies
# ------------------------------------------------------------------
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip3 install --upgrade uv \
    && uv venv \
    && uv pip install --no-cache-dir -r requirements.txt

# ------------------------------------------------------------------
# 7. Install and build frontend
# ------------------------------------------------------------------
WORKDIR /tmp/frontend
COPY frontend/package.json frontend/package-lock.json /tmp/frontend/
RUN npm install

COPY frontend/ ./
COPY version.json ../
RUN npm run build

# Delete all files except the dist and schema folders
RUN find . -maxdepth 1 ! -name 'dist' ! -name 'schema' ! -name '.' ! -name '..' -exec rm -rf {} \;

# ------------------------------------------------------------------
# 8. Clean up unneeded Nodejs & other packages
#    (Keeping crossbuild-essential-* and build-essential)
# ------------------------------------------------------------------
RUN apt-get remove -y nodejs curl libffi-dev ca-certificates gnupg \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /app/frontend/node_modules \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# ------------------------------------------------------------------
# 9. Prepare Nim environment
# ------------------------------------------------------------------
WORKDIR /app/frameos
COPY frameos/frameos.nimble ./
COPY frameos/nimble.lock ./
COPY frameos/nim.cfg ./

# Cache nimble deps for when deploying on frame
RUN nimble install -d -y && nimble setup

# ------------------------------------------------------------------
# 10. Move final built frontend into /app
# ------------------------------------------------------------------
WORKDIR /app
COPY . .
RUN rm -rf /app/frontend && mv /tmp/frontend /app/

EXPOSE 8989

CMD ["./docker-entrypoint.sh"]
