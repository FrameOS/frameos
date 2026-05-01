#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXTERNAL_DIR="${ROOT_DIR}/buildroot-external/frameos-t113-s3"
BUILDROOT_DIR="${BUILDROOT_DIR:-${ROOT_DIR}/build/buildroot}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/build/buildroot-t113-s3}"
DEFCONFIG="${DEFCONFIG:-frameos_t113_s3_mangopi_mq_dual_defconfig}"

if [[ ! -f "${BUILDROOT_DIR}/Makefile" ]]; then
  cat >&2 <<EOF
Buildroot was not found at:
  ${BUILDROOT_DIR}

Set BUILDROOT_DIR to a Buildroot checkout, for example:
  BUILDROOT_DIR=/path/to/buildroot $0
EOF
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

make -C "${BUILDROOT_DIR}" \
  O="${OUTPUT_DIR}" \
  BR2_EXTERNAL="${EXTERNAL_DIR}" \
  "${DEFCONFIG}"

make -C "${BUILDROOT_DIR}" \
  O="${OUTPUT_DIR}" \
  BR2_EXTERNAL="${EXTERNAL_DIR}" \
  "$@"

cat <<EOF

Buildroot output: ${OUTPUT_DIR}
Expected SD image: ${OUTPUT_DIR}/images/sdcard.img
EOF
