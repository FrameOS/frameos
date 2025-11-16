# syntax=docker/dockerfile:1.6
ARG DEBIAN_RELEASE=bookworm
FROM debian:${DEBIAN_RELEASE} AS builder
ARG DEBIAN_RELEASE
ENV DEBIAN_RELEASE=${DEBIAN_RELEASE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG NIM_VERSION=2.2.4
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

RUN set -euxo pipefail \
    && curl -fsSL -o nim.tar.xz "https://nim-lang.org/download/nim-${NIM_VERSION}.tar.xz" \
    && tar -xf nim.tar.xz \
    && rm nim.tar.xz \
    && cd nim-${NIM_VERSION} \
    && sh build.sh \
    && ./bin/nim c koch \
    && ./koch boot -d:release \
    && ./koch tools \
    && ./install.sh /artifacts \
    && cd /build \
    && rm -rf nim-${NIM_VERSION}

RUN set -euxo pipefail \
    && find /artifacts -type f -print0 | xargs -0 chmod 0644 \
    && find /artifacts -type d -print0 | xargs -0 chmod 0755

FROM scratch AS artifacts
COPY --from=builder /artifacts /
