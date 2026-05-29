# syntax=docker/dockerfile:1.4

ARG BASE_IMAGE=debian:bookworm
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

ARG BUILDROOT_VERSION=2025.02.13
ARG BUILDROOT_APT_DEPS="bc bison build-essential ca-certificates cpio curl file flex g++ gfortran git libncurses-dev libssl-dev make perl python3 rsync unzip wget xdg-utils xz-utils"

RUN set -eu \
    && apt-get update \
    && apt-get install -y --no-install-recommends ${BUILDROOT_APT_DEPS} \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /frameos-buildroot \
    && curl -fsSL -o /frameos-buildroot/buildroot-${BUILDROOT_VERSION}.tar.gz \
      https://buildroot.org/downloads/buildroot-${BUILDROOT_VERSION}.tar.gz \
    && printf '%s\n' "${BUILDROOT_VERSION}" > /frameos-buildroot/.frameos-buildroot-version
