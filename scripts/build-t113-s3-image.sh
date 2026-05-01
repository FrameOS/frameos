#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXTERNAL_DIR="${ROOT_DIR}/buildroot-external/frameos-t113-s3"
source "${ROOT_DIR}/scripts/lib/t113-s3-buildroot.sh"

BUILDROOT_DIR="${BUILDROOT_DIR:-${ROOT_DIR}/build/buildroot}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/build/buildroot-t113-s3}"
DEFCONFIG="${DEFCONFIG:-frameos_t113_s3_mangopi_mq_dual_defconfig}"
IMAGE_ARTIFACTS_DIR="${IMAGE_ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3-image}"
FRAMEOS_BUILD_RUNTIME="${FRAMEOS_BUILD_RUNTIME:-0}"

if [[ ! -f "${BUILDROOT_DIR}/Makefile" ]]; then
  cat >&2 <<EOF
Buildroot was not found at:
  ${BUILDROOT_DIR}

Set BUILDROOT_DIR to a Buildroot checkout, for example:
  BUILDROOT_DIR=/path/to/buildroot $0
EOF
  exit 1
fi

frameos_t113_s3_assert_host_compilers

if [[ "${FRAMEOS_RECONFIGURE:-1}" == "1" || ! -f "${OUTPUT_DIR}/.config" ]]; then
  frameos_t113_s3_configure_buildroot "${BUILDROOT_DIR}" "${OUTPUT_DIR}" "${EXTERNAL_DIR}" "${DEFCONFIG}"
fi

if [[ -z "${FRAMEOS_RUNTIME_BINARY:-}" && "${FRAMEOS_BUILD_RUNTIME}" == "1" ]]; then
  FRAMEOS_RUNTIME_ARTIFACTS_DIR="${FRAMEOS_RUNTIME_ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3}"
  BUILDROOT_DIR="${BUILDROOT_DIR}" \
    BUILDROOT_OUTPUT_DIR="${OUTPUT_DIR}" \
    ARTIFACTS_DIR="${FRAMEOS_RUNTIME_ARTIFACTS_DIR}" \
    FRAMEOS_RECONFIGURE=0 \
    "${ROOT_DIR}/scripts/build-t113-s3-frameos.sh"
  FRAMEOS_RUNTIME_BINARY="${FRAMEOS_RUNTIME_ARTIFACTS_DIR}/frameos"
fi

if [[ -n "${FRAMEOS_RUNTIME_BINARY:-}" ]]; then
  export FRAMEOS_RUNTIME_BINARY
fi

make -C "${BUILDROOT_DIR}" \
  O="${OUTPUT_DIR}" \
  BR2_EXTERNAL="${EXTERNAL_DIR}" \
  "$@"

image_artifact_message="Image artifact copy: not generated"
if [[ -f "${OUTPUT_DIR}/images/sdcard.img" ]]; then
  mkdir -p "${IMAGE_ARTIFACTS_DIR}"
  cp "${OUTPUT_DIR}/images/sdcard.img" "${IMAGE_ARTIFACTS_DIR}/sdcard.img"
  (
    cd "${IMAGE_ARTIFACTS_DIR}"
    sha256sum sdcard.img >sdcard.img.sha256
  )
  cat >"${IMAGE_ARTIFACTS_DIR}/metadata.json" <<EOF
{
  "defconfig": "${DEFCONFIG}",
  "wifi_variant": "${FRAMEOS_WIFI_VARIANT:-rtl8723ds}",
  "output_dir": "${OUTPUT_DIR}",
  "runtime_binary": "${FRAMEOS_RUNTIME_BINARY:-}",
  "image": "${IMAGE_ARTIFACTS_DIR}/sdcard.img",
  "sha256": "${IMAGE_ARTIFACTS_DIR}/sdcard.img.sha256"
}
EOF
  image_artifact_message="Image artifact copy: ${IMAGE_ARTIFACTS_DIR}/sdcard.img"
fi

cat <<EOF

Buildroot output: ${OUTPUT_DIR}
Expected SD image: ${OUTPUT_DIR}/images/sdcard.img
${image_artifact_message}
EOF
