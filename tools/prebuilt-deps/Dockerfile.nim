# syntax=docker/dockerfile:1.6
ARG BASE_IMAGE=debian:bookworm
FROM ${BASE_IMAGE} AS builder
ARG BASE_IMAGE
ARG DISTRO_NAME=debian
ARG DISTRO_RELEASE=bookworm
ARG TARGET_NAME=${DISTRO_NAME}-${DISTRO_RELEASE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG NIM_VERSION=2.2.4

ENV DEBIAN_FRONTEND=noninteractive
# Debian 11 left the regular mirror when its LTS ended (2026-08-31): the
# index still lists bullseye-security packages that 404 there, so a bullseye
# build reads archive.debian.org.
RUN if [ "${DISTRO_NAME}-${DISTRO_RELEASE}" = "debian-bullseye" ]; then \
      printf '%s\n' \
        "deb http://archive.debian.org/debian bullseye main" \
        "deb http://archive.debian.org/debian bullseye-updates main" \
        "deb http://archive.debian.org/debian-security bullseye-security main" \
        > /etc/apt/sources.list \
      && rm -f /etc/apt/sources.list.d/*; \
    fi
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
    && mkdir -p /artifacts/bin \
    && cp -a ./bin/. /artifacts/bin/ \
    && cd /build \
    && rm -rf nim-${NIM_VERSION}

RUN set -euxo pipefail \
    && find /artifacts -type f -print0 | xargs -0 chmod 0644 \
    && find /artifacts/bin -type f -print0 | xargs -0 chmod 0755 \
    && find /artifacts -type d -print0 | xargs -0 chmod 0755

FROM scratch AS artifacts
COPY --from=builder /artifacts /
