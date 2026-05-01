#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXTERNAL_DIR="${ROOT_DIR}/buildroot-external/frameos-t113-s3"
source "${ROOT_DIR}/scripts/lib/t113-s3-buildroot.sh"

BUILDROOT_DIR="${BUILDROOT_DIR:-${ROOT_DIR}/build/buildroot}"
BUILDROOT_OUTPUT_DIR="${BUILDROOT_OUTPUT_DIR:-${ROOT_DIR}/build/buildroot-t113-s3}"
FRAMEOS_ROOT="${FRAMEOS_ROOT:-${ROOT_DIR}/frameos}"
GENERATED_DIR="${GENERATED_DIR:-${ROOT_DIR}/build/frameos-t113-s3-c}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3}"
TARGET="${TARGET:-buildroot-t113-s3-armhf}"
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

mkdir -p "${BUILDROOT_OUTPUT_DIR}" "${ARTIFACTS_DIR}"

if [[ "${FRAMEOS_RECONFIGURE:-0}" == "1" || ! -f "${BUILDROOT_OUTPUT_DIR}/.config" ]]; then
  frameos_t113_s3_configure_buildroot "${BUILDROOT_DIR}" "${BUILDROOT_OUTPUT_DIR}" "${EXTERNAL_DIR}" "${DEFCONFIG}"
fi

make -C "${BUILDROOT_DIR}" \
  O="${BUILDROOT_OUTPUT_DIR}" \
  BR2_EXTERNAL="${EXTERNAL_DIR}" \
  frameos-quickjs frameos-lgpio openssl

HOST_DIR="${BUILDROOT_OUTPUT_DIR}/host"
STAGING_DIR="${BUILDROOT_OUTPUT_DIR}/staging"

if [[ ! -d "${STAGING_DIR}" ]]; then
  echo "Buildroot staging directory missing: ${STAGING_DIR}" >&2
  exit 1
fi

target_gcc=""
for candidate in "${HOST_DIR}"/bin/*-gcc; do
  if [[ -x "${candidate}" && "$(basename "${candidate}")" != "gcc" ]]; then
    target_gcc="${candidate}"
    break
  fi
done

if [[ -z "${target_gcc}" ]]; then
  echo "Could not find a target gcc under ${HOST_DIR}/bin" >&2
  exit 1
fi

for required in \
  "${STAGING_DIR}/usr/include/lgpio.h" \
  "${STAGING_DIR}/usr/include/quickjs/quickjs.h" \
  "${STAGING_DIR}/usr/include/quickjs/quickjs-libc.h" \
  "${STAGING_DIR}/usr/lib/libquickjs.a"; do
  if [[ ! -e "${required}" ]]; then
    echo "Missing Buildroot staging artifact: ${required}" >&2
    exit 1
  fi
done

if [[ ! -e "${STAGING_DIR}/usr/lib/liblgpio.so" && ! -e "${STAGING_DIR}/usr/lib/liblgpio.a" ]]; then
  echo "Missing Buildroot staging artifact: ${STAGING_DIR}/usr/lib/liblgpio.{so,a}" >&2
  exit 1
fi

python3 "${ROOT_DIR}/backend/bin/cross" generate \
  --target "${TARGET}" \
  --frameos-root "${FRAMEOS_ROOT}" \
  --build-dir "${GENERATED_DIR}"

rm -rf "${GENERATED_DIR}/quickjs"
mkdir -p "${GENERATED_DIR}/quickjs"
cp "${STAGING_DIR}/usr/lib/libquickjs.a" "${GENERATED_DIR}/quickjs/libquickjs.a"
cp "${STAGING_DIR}/usr/include/quickjs/quickjs.h" "${GENERATED_DIR}/quickjs/quickjs.h"
cp "${STAGING_DIR}/usr/include/quickjs/quickjs-libc.h" "${GENERATED_DIR}/quickjs/quickjs-libc.h"

export CPATH="${GENERATED_DIR}:${STAGING_DIR}/usr/include:${STAGING_DIR}/usr/include/quickjs${CPATH:+:${CPATH}}"
export LIBRARY_PATH="${STAGING_DIR}/usr/lib${LIBRARY_PATH:+:${LIBRARY_PATH}}"
export PKG_CONFIG_SYSROOT_DIR="${STAGING_DIR}"
export PKG_CONFIG_LIBDIR="${STAGING_DIR}/usr/lib/pkgconfig:${STAGING_DIR}/usr/share/pkgconfig"

make -C "${GENERATED_DIR}" \
  CC="${target_gcc}" \
  EXTRA_CFLAGS="--sysroot=${STAGING_DIR} -I${GENERATED_DIR} -I${STAGING_DIR}/usr/include -I${STAGING_DIR}/usr/include/quickjs" \
  EXTRA_LIBS="--sysroot=${STAGING_DIR} -L${STAGING_DIR}/usr/lib -Wl,-rpath-link,${STAGING_DIR}/usr/lib"

install -D -m 0755 "${GENERATED_DIR}/frameos" "${ARTIFACTS_DIR}/frameos"

cat >"${ARTIFACTS_DIR}/metadata.json" <<EOF
{
  "target": "${TARGET}",
  "buildroot_output_dir": "${BUILDROOT_OUTPUT_DIR}",
  "staging_dir": "${STAGING_DIR}",
  "generated_dir": "${GENERATED_DIR}",
  "cc": "${target_gcc}"
}
EOF

cat <<EOF

Built FrameOS runtime: ${ARTIFACTS_DIR}/frameos
To include it in the SD card image:
  FRAMEOS_RUNTIME_BINARY=${ARTIFACTS_DIR}/frameos \\
    BUILDROOT_DIR=${BUILDROOT_DIR} \\
    OUTPUT_DIR=${BUILDROOT_OUTPUT_DIR} \\
    ${ROOT_DIR}/scripts/build-t113-s3-image.sh
EOF
