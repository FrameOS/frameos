#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDROOT_OUTPUT_DIR="${BUILDROOT_OUTPUT_DIR:-${OUTPUT_DIR:-${ROOT_DIR}/build/buildroot-t113-s3}}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3}"
IMAGE_ARTIFACTS_DIR="${IMAGE_ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3-image}"
FRAMEOS_RUNTIME_BINARY="${FRAMEOS_RUNTIME_BINARY:-${ARTIFACTS_DIR}/frameos}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $0

Environment:
  BUILDROOT_OUTPUT_DIR      Buildroot output directory
  OUTPUT_DIR                Alias for BUILDROOT_OUTPUT_DIR
  ARTIFACTS_DIR             FrameOS runtime artifact directory
  IMAGE_ARTIFACTS_DIR       Copied image artifact directory
  FRAMEOS_RUNTIME_BINARY    Runtime binary to inspect
EOF
  exit 0
fi

HOST_DIR="${BUILDROOT_OUTPUT_DIR}/host"
TARGET_DIR="${BUILDROOT_OUTPUT_DIR}/target"
IMAGE_DIR="${BUILDROOT_OUTPUT_DIR}/images"
failures=0

ok() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'missing: %s\n' "$1" >&2
  failures=$((failures + 1))
}

check_file() {
  local path="$1"
  local label="$2"
  if [[ -f "${path}" ]]; then
    ok "${label}: ${path}"
  else
    fail "${label}: ${path}"
  fi
}

check_executable() {
  local path="$1"
  local label="$2"
  if [[ -x "${path}" ]]; then
    ok "${label}: ${path}"
  else
    fail "${label}: ${path}"
  fi
}

check_glob() {
  local pattern="$1"
  local label="$2"
  if compgen -G "${pattern}" >/dev/null; then
    ok "${label}: ${pattern}"
  else
    fail "${label}: ${pattern}"
  fi
}

find_target_readelf() {
  local candidate
  for candidate in "${HOST_DIR}"/bin/*-readelf; do
    if [[ -x "${candidate}" && "$(basename -- "${candidate}")" != "readelf" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  if command -v readelf >/dev/null 2>&1; then
    command -v readelf
    return 0
  fi

  return 1
}

check_readelf() {
  local binary="$1"
  local readelf_bin

  if [[ ! -f "${binary}" ]]; then
    fail "FrameOS runtime binary: ${binary}"
    return
  fi

  if ! readelf_bin="$(find_target_readelf)"; then
    fail "readelf command"
    return
  fi

  ok "readelf: ${readelf_bin}"
  "${readelf_bin}" -h "${binary}" | awk '/Class:|Data:|Machine:/ { print }'
  "${readelf_bin}" -l "${binary}" | awk '/interpreter/ { print }'
  "${readelf_bin}" -d "${binary}" | awk '/NEEDED/ { print }' || true

  if "${readelf_bin}" -h "${binary}" | grep -q 'Machine:.*ARM'; then
    ok "FrameOS runtime ELF machine is ARM"
  else
    fail "FrameOS runtime ELF machine is ARM"
  fi
}

check_file "${BUILDROOT_OUTPUT_DIR}/.config" "Buildroot config"
check_file "${IMAGE_DIR}/sdcard.img" "Buildroot SD card image"
check_file "${IMAGE_DIR}/rootfs.ext4" "Buildroot rootfs.ext4"
check_file "${IMAGE_DIR}/u-boot-sunxi-with-spl.bin" "U-Boot SPL image"
check_glob "${IMAGE_DIR}/sun8i-t113s-*.dtb" "T113-S3 device tree"

check_executable "${TARGET_DIR}/etc/init.d/S99frameos" "FrameOS init script"
check_file "${TARGET_DIR}/etc/default/frameos" "FrameOS defaults"
check_file "${TARGET_DIR}/etc/frameos/frame.json" "FrameOS frame config"
check_executable "${TARGET_DIR}/usr/bin/frameos" "FrameOS runtime in rootfs"
check_glob "${TARGET_DIR}/usr/lib/liblgpio.so*" "lgpio runtime library"
check_glob "${TARGET_DIR}/usr/lib/libssl.so*" "OpenSSL runtime library"
check_glob "${TARGET_DIR}/usr/lib/libcrypto.so*" "OpenSSL crypto runtime library"
check_glob "${TARGET_DIR}/etc/ssl/certs/*" "CA certificates"

check_readelf "${FRAMEOS_RUNTIME_BINARY}"

if [[ -f "${IMAGE_ARTIFACTS_DIR}/sdcard.img.sha256" ]]; then
  (
    cd "${IMAGE_ARTIFACTS_DIR}"
    sha256sum -c sdcard.img.sha256
  )
else
  fail "copied image checksum: ${IMAGE_ARTIFACTS_DIR}/sdcard.img.sha256"
fi

if [[ "${failures}" -gt 0 ]]; then
  echo "Inspection failed with ${failures} missing or invalid item(s)." >&2
  exit 1
fi

echo "Inspection passed."
