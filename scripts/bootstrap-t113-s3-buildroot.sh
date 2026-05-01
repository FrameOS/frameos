#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDROOT_DIR="${BUILDROOT_DIR:-${ROOT_DIR}/build/buildroot}"
BUILDROOT_REPO="${BUILDROOT_REPO:-https://gitlab.com/buildroot.org/buildroot.git}"
BUILDROOT_REF="${BUILDROOT_REF:-2026.02.1}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $0

Environment:
  BUILDROOT_DIR     Destination checkout. Default: ${ROOT_DIR}/build/buildroot
  BUILDROOT_REPO    Buildroot git URL. Default: https://gitlab.com/buildroot.org/buildroot.git
  BUILDROOT_REF     Branch, tag, or commit to checkout. Default: 2026.02.1
  BUILDROOT_UPDATE  Set to 1 to fetch and checkout BUILDROOT_REF in an existing checkout.
EOF
  exit 0
fi

required_paths=(
  "Makefile"
  "support/kconfig/merge_config.sh"
  "package/rtl8189fs/Config.in"
  "package/rtl8723ds/Config.in"
  "package/wpa_supplicant/Config.in"
)

if [[ -d "${BUILDROOT_DIR}/.git" ]]; then
  echo "Using existing Buildroot checkout: ${BUILDROOT_DIR}"
  if [[ "${BUILDROOT_UPDATE:-0}" == "1" ]]; then
    git -C "${BUILDROOT_DIR}" fetch --depth 1 origin "${BUILDROOT_REF}"
    git -C "${BUILDROOT_DIR}" checkout --detach FETCH_HEAD
  fi
elif [[ -e "${BUILDROOT_DIR}" ]]; then
  echo "BUILDROOT_DIR exists but is not a git checkout: ${BUILDROOT_DIR}" >&2
  exit 1
else
  mkdir -p "$(dirname -- "${BUILDROOT_DIR}")"
  git clone --depth 1 --branch "${BUILDROOT_REF}" "${BUILDROOT_REPO}" "${BUILDROOT_DIR}"
fi

missing=0
for path in "${required_paths[@]}"; do
  if [[ -e "${BUILDROOT_DIR}/${path}" ]]; then
    echo "ok: ${path}"
  else
    echo "missing: ${path}" >&2
    missing=$((missing + 1))
  fi
done

if [[ "${missing}" -gt 0 ]]; then
  cat >&2 <<EOF

The selected Buildroot checkout is missing ${missing} required path(s).
Try a newer BUILDROOT_REF, or backport the missing package/config support.
EOF
  exit 1
fi

cat <<EOF

Buildroot checkout ready:
  ${BUILDROOT_DIR}

Next:
  BUILDROOT_DIR=${BUILDROOT_DIR} ./scripts/build-t113-s3-image.sh olddefconfig
  FRAMEOS_BUILD_RUNTIME=1 BUILDROOT_DIR=${BUILDROOT_DIR} ./scripts/build-t113-s3-image.sh
EOF
