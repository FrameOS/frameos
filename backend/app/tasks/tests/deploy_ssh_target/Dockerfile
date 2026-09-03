FROM debian:bookworm-slim

ARG FRAMEOS_E2E_USER=frame
ARG FRAMEOS_E2E_PASSWORD=framepass

RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        caddy \
        findutils \
        gzip \
        hostapd \
        libssl-dev \
        make \
        ntpsec \
        openssh-server \
        procps \
        sudo \
        tar \
        wget \
        xz-utils; \
    useradd -m -s /bin/bash "${FRAMEOS_E2E_USER}"; \
    echo "${FRAMEOS_E2E_USER}:${FRAMEOS_E2E_PASSWORD}" | chpasswd; \
    echo "${FRAMEOS_E2E_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${FRAMEOS_E2E_USER}"; \
    chmod 0440 "/etc/sudoers.d/${FRAMEOS_E2E_USER}"; \
    mkdir -p /run/sshd /boot /srv/frameos/vendor/quickjs /etc/systemd/system; \
    touch /boot/config.txt; \
    sed -ri 's/^#?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config; \
    sed -ri 's/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config; \
    wget -q -O /tmp/quickjs.tar.xz https://archive.frameos.net/source/vendor/quickjs-2026-06-04-quickts.1.tar.xz; \
    echo "94a94f5229ead78f585280b5d41c7b45ab5c53eaf3500e493a5da05f32030e9f  /tmp/quickjs.tar.xz" | sha256sum -c -; \
    tar -xf /tmp/quickjs.tar.xz -C /tmp; \
    cp -a /tmp/quickjs-2026-06-04-quickts.1 /srv/frameos/vendor/quickjs/quickjs-2026-06-04-quickts.1; \
    make -C /srv/frameos/vendor/quickjs/quickjs-2026-06-04-quickts.1 libquickjs.a; \
    chown -R "${FRAMEOS_E2E_USER}:${FRAMEOS_E2E_USER}" /srv/frameos; \
    rm -rf /tmp/quickjs.tar.xz /tmp/quickjs-2026-06-04-quickts.1; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    printf '%s\n' \
        '#!/bin/sh' \
        'case "$1" in' \
        '  is-enabled|is-active) exit 1 ;;' \
        'esac' \
        'mkdir -p /srv/frameos' \
        'echo "systemctl $*" >> /srv/frameos/deploy-e2e-commands.log' \
        'exit 0' \
        > /usr/local/bin/systemctl; \
    printf '%s\n' \
        '#!/bin/sh' \
        'mkdir -p /srv/frameos' \
        'echo "service $*" >> /srv/frameos/deploy-e2e-commands.log' \
        'exit 0' \
        > /usr/local/bin/service; \
    printf '%s\n' \
        '#!/bin/sh' \
        'mkdir -p /srv/frameos' \
        'echo "reboot $*" >> /srv/frameos/deploy-e2e-commands.log' \
        'exit 0' \
        > /usr/local/bin/reboot; \
    chmod +x /usr/local/bin/systemctl /usr/local/bin/service /usr/local/bin/reboot

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
