#!/usr/bin/env bash
# Builds (or refreshes) the Incus VM image the runner pool launches from:
#   alias gha-runner-noble  — Ubuntu 24.04 cloud + docker + actions-runner.
# Re-run any time to pick up a newer runner/toolchain; running slots keep
# using the image they were launched from, new launches get the new one.
set -euo pipefail

POOL=${GHA_POOL:-parallaize-lvm}
ALIAS=${GHA_IMAGE_ALIAS:-gha-runner-noble}
BUILD=gha-image-build-$$
RUNNER_VERSION=${RUNNER_VERSION:-$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')}
[ -n "$RUNNER_VERSION" ] || { echo "could not resolve runner version" >&2; exit 1; }
echo "==> building $ALIAS with actions-runner $RUNNER_VERSION"

cleanup() { incus delete -f "$BUILD" 2>/dev/null || true; }
trap cleanup EXIT

incus launch images:ubuntu/24.04/cloud "$BUILD" --vm \
  -s "$POOL" -d root,size=40GiB -c limits.cpu=8 -c limits.memory=16GiB \
  -c security.secureboot=false

echo "==> waiting for the agent"
for _ in $(seq 1 120); do incus exec "$BUILD" -- true 2>/dev/null && break; sleep 2; done
incus exec "$BUILD" -- cloud-init status --wait >/dev/null 2>&1 || true

incus exec "$BUILD" -- env RUNNER_VERSION="$RUNNER_VERSION" DEBIAN_FRONTEND=noninteractive bash -s <<'PROVISION'
set -euxo pipefail
# Same shape as GitHub's ubuntu images where it matters for our workflows:
# a `runner` user with passwordless sudo and docker, git/curl/jq, build
# essentials. Toolchains (node, python, nim) come from setup-* actions.
apt-get update -q
apt-get install -yq --no-install-recommends \
  ca-certificates curl wget git git-lfs jq unzip zip zstd xz-utils tar rsync \
  build-essential pkg-config libssl-dev libffi-dev \
  python3 python3-venv python3-pip python3-dev \
  docker.io docker-buildx docker-compose-v2 \
  qemu-user-static binfmt-support \
  libicu74 libkrb5-3 zlib1g libssl3 \
  openssh-client sudo dnsutils iproute2 iputils-ping netcat-openbsd \
  software-properties-common gnupg lsb-release acl python-is-python3
apt-get autoremove -yq; apt-get clean
# The image must not decide to upgrade itself in the middle of a job.
systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.service apt-daily-upgrade.service || true

id runner 2>/dev/null || useradd -m -u 1001 -s /bin/bash -G sudo,docker runner
echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-runner; chmod 440 /etc/sudoers.d/90-runner
systemctl enable --now docker
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "2" },
  "features": { "containerd-snapshotter": true } }
JSON
systemctl restart docker

# actions-runner
install -d -o runner -g runner /home/runner/actions-runner
cd /home/runner/actions-runner
curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
tar xzf runner.tgz && rm runner.tgz
./bin/installdependencies.sh
# The runner exports every line of .env into each job step. GitHub's own
# Ubuntu images set PIP_BREAK_SYSTEM_PACKAGES so bare `pip install` works
# against the PEP 668 "externally managed" system Python — workflows written
# for GitHub-hosted runners assume it (frameos-cross broke without it).
# ImageOS helps setup-python/setup-ruby pick the right prebuilt binaries.
cat > /home/runner/actions-runner/.env <<'ENV'
PIP_BREAK_SYSTEM_PACKAGES=1
ImageOS=ubuntu24
ENV
chown -R runner:runner /home/runner
echo "$RUNNER_VERSION" > /home/runner/actions-runner/.version

# Mount point for the host-side persistent cache (see gha-slot.sh).
mkdir -p /mnt/cache
# Keep the image small and the boot clean.
cloud-init clean --logs || true
truncate -s 0 /etc/machine-id
journalctl --rotate --vacuum-time=1s || true
rm -rf /tmp/* /var/tmp/* /var/lib/apt/lists/*
PROVISION

echo "==> publishing"
incus stop "$BUILD"
# Replace the alias atomically-ish: publish new, then point the alias at it.
OLD=$(incus image list "$ALIAS" --format csv -c f 2>/dev/null | head -1 || true)
incus publish "$BUILD" --alias "$ALIAS" --reuse \
  description="GitHub Actions runner base (Ubuntu 24.04, runner $RUNNER_VERSION, $(date -u +%F))"
if [ -n "$OLD" ]; then
  NEW=$(incus image list "$ALIAS" --format csv -c f | head -1)
  [ "$OLD" != "$NEW" ] && incus image delete "$OLD" || true
fi
incus image list "$ALIAS"
