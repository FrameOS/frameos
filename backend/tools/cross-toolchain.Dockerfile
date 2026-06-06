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
ARG TARGET_CROSS_DPKG_ARCHS=""
ARG TARGET_CROSS_PACKAGES=""
RUN set -eu \
    && apt-get update \
    && for arch in $TARGET_CROSS_DPKG_ARCHS; do \
            dpkg --add-architecture "$arch"; \
        done \
    && if [ -n "$TARGET_CROSS_DPKG_ARCHS" ] && grep -qi '^ID=ubuntu' /etc/os-release; then \
            native_arch="$(dpkg --print-architecture)"; \
            codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"; \
            if [ -z "$codename" ]; then \
                codename="$(awk -F= '/^UBUNTU_CODENAME=/{print $2}' /etc/os-release)"; \
            fi; \
            if [ -z "$codename" ]; then \
                echo "Unable to determine Ubuntu codename for cross-architecture apt sources" >&2; \
                exit 1; \
            fi; \
            foreign_archs="$TARGET_CROSS_DPKG_ARCHS"; \
            for source_file in /etc/apt/sources.list.d/ubuntu.sources; do \
                if [ -f "$source_file" ] && ! grep -q '^Architectures:' "$source_file"; then \
                    awk -v arch="$native_arch" ' \
                        /^Signed-By:/ { print; print "Architectures: " arch; next } \
                        { print } \
                    ' "$source_file" > "$source_file.tmp"; \
                    mv "$source_file.tmp" "$source_file"; \
                fi; \
            done; \
            if [ -f /etc/apt/sources.list ]; then \
                sed -i -E "s#^deb (http://(archive|security)\\.ubuntu\\.com/ubuntu/)#deb [arch=${native_arch}] \\1#" /etc/apt/sources.list; \
            fi; \
            printf '%s\n' \
                'Types: deb' \
                'URIs: http://ports.ubuntu.com/ubuntu-ports/' \
                "Suites: ${codename} ${codename}-updates ${codename}-backports ${codename}-security" \
                'Components: main universe restricted multiverse' \
                "Architectures: ${foreign_archs}" \
                'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
                > /etc/apt/sources.list.d/ubuntu-ports.sources; \
        fi \
    && if [ -n "$TARGET_CROSS_DPKG_ARCHS" ]; then \
            apt-get update; \
        fi \
    && SSL_PACKAGE="" \
    &&  if apt-cache show libssl3t64 >/dev/null 2>&1; then \
            SSL_PACKAGE="libssl3t64"; \
        elif apt-cache show libssl3 >/dev/null 2>&1; then \
            SSL_PACKAGE="libssl3"; \
        elif apt-cache show libssl1.1 >/dev/null 2>&1; then \
            SSL_PACKAGE="libssl1.1"; \
        fi \
    && apt-get install -y --no-install-recommends $TOOLCHAIN_PACKAGES $TARGET_CROSS_PACKAGES ${SSL_PACKAGE:+$SSL_PACKAGE} \
    && rm -rf /var/lib/apt/lists/*
