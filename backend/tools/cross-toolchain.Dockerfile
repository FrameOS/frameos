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
    libssl-dev \
    libffi-dev \
    libjpeg-dev \
    libfreetype6-dev \
    libevdev-dev"

RUN apt-get update \
    && apt-get install -y --no-install-recommends $TOOLCHAIN_PACKAGES \
    && rm -rf /var/lib/apt/lists/*
