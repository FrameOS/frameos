# syntax=docker/dockerfile:1.4
ARG BASE_IMAGE=debian:bookworm
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

ARG TOOLCHAIN_PACKAGES="build-essential \
    ca-certificates \
    curl \
    git \
    make \
    pkg-config \
    python3 \
    python3-pip \
    unzip \
    xz-utils \
    zlib1g-dev \
    libffi-dev \
    libssl-dev \
    libjpeg-dev \
    libfreetype6-dev \
    libevdev-dev"

RUN set -eu \
    && apt-get update \
    && SSL_PACKAGE="libssl3" \
    && if ! apt-cache show "$SSL_PACKAGE" >/dev/null 2>&1; then \
        if apt-cache show libssl3t64 >/dev/null 2>&1; then \
            SSL_PACKAGE="libssl3t64"; \
        else \
            SSL_PACKAGE=""; \
        fi; \
    fi \
    && apt-get install -y --no-install-recommends $TOOLCHAIN_PACKAGES ${SSL_PACKAGE:+$SSL_PACKAGE} \
    && rm -rf /var/lib/apt/lists/*
