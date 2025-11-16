# syntax=docker/dockerfile:1.6
ARG DEBIAN_RELEASE=bookworm
FROM debian:${DEBIAN_RELEASE} AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG NIM_VERSION=2.2.4
ARG QUICKJS_VERSION=2025-04-26
ARG QUICKJS_SHA256=2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf
ARG LGPIO_REPO=https://github.com/joan2937/lg.git
ARG LGPIO_VERSION=v0.2.2
ARG TARGET_NAME=pios-${DEBIAN_RELEASE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      pkg-config \
      python3 \
      xz-utils \
      openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN mkdir -p /artifacts

# ───────────────────────────────────────────────────────────────────
# Build Nim from source so the binaries match the target architecture
# ───────────────────────────────────────────────────────────────────
RUN set -euxo pipefail \
    && curl -fsSL -o nim.tar.xz "https://nim-lang.org/download/nim-${NIM_VERSION}.tar.xz" \
    && tar -xf nim.tar.xz \
    && rm nim.tar.xz \
    && cd nim-${NIM_VERSION} \
    && sh build.sh \
    && ./bin/nim c koch \
    && ./koch boot -d:release \
    && ./koch tools \
    && mkdir -p /artifacts/nim \
    && ./install.sh /artifacts/nim \
    && cd /build \
    && rm -rf nim-${NIM_VERSION}

# ───────────────────────────────────────────────────────────────────
# Build QuickJS static library + headers
# ───────────────────────────────────────────────────────────────────
RUN set -euxo pipefail \
    && curl -fsSL -o quickjs.tar.xz "https://bellard.org/quickjs/quickjs-${QUICKJS_VERSION}.tar.xz" \
    && echo "${QUICKJS_SHA256}  quickjs.tar.xz" | sha256sum -c - \
    && tar -xf quickjs.tar.xz \
    && rm quickjs.tar.xz \
    && cd quickjs-${QUICKJS_VERSION} \
    && make libquickjs.a \
    && mkdir -p /artifacts/quickjs/lib /artifacts/quickjs/include/quickjs \
    && cp libquickjs.a /artifacts/quickjs/lib/ \
    && cp quickjs.h quickjs-libc.h /artifacts/quickjs/include/quickjs/ \
    && cd /build \
    && rm -rf quickjs-${QUICKJS_VERSION}

# ───────────────────────────────────────────────────────────────────
# Build lgpio from source (v0.2.2)
# ───────────────────────────────────────────────────────────────────
RUN set -euxo pipefail \
    && git clone --depth=1 --branch "${LGPIO_VERSION}" "${LGPIO_REPO}" lgpio-src \
    && cd lgpio-src \
    && make \
    && make DESTDIR=/tmp/lgpio install \
    && mkdir -p /artifacts/lgpio/lib /artifacts/lgpio/include \
    && cp -r /tmp/lgpio/usr/local/include/. /artifacts/lgpio/include/ \
    && cp -r /tmp/lgpio/usr/local/lib/. /artifacts/lgpio/lib/ \
    && rm -rf /tmp/lgpio \
    && cd /build \
    && rm -rf lgpio-src

RUN set -euxo pipefail \
    && printf '{\n  "target": "%s",\n  "debian_release": "%s",\n  "platform": "%s",\n  "nim_version": "%s",\n  "quickjs_version": "%s",\n  "lgpio_version": "%s"\n}\n' \
         "${TARGET_NAME}" "${DEBIAN_RELEASE}" "${TARGETPLATFORM}" \
         "${NIM_VERSION}" "${QUICKJS_VERSION}" "${LGPIO_VERSION}" \
         > /artifacts/metadata.json \
    && find /artifacts -type f -print0 | xargs -0 chmod 0644 \
    && find /artifacts -type d -print0 | xargs -0 chmod 0755

FROM scratch AS artifacts
COPY --from=builder /artifacts /
