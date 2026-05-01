#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_ARTIFACTS_DIR="${IMAGE_ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3-image}"
PACKAGE_DIR="${PACKAGE_DIR:-${IMAGE_ARTIFACTS_DIR}}"
IMAGE_NAME="${IMAGE_NAME:-frameos-t113-s3-sdcard}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $0

Environment:
  IMAGE_ARTIFACTS_DIR   Directory containing sdcard.img and optional metadata
  PACKAGE_DIR           Directory where compressed download artifacts are written
  IMAGE_NAME            Base artifact name, without .img.xz
EOF
  exit 0
fi

image="${IMAGE_ARTIFACTS_DIR}/sdcard.img"
metadata="${IMAGE_ARTIFACTS_DIR}/metadata.json"
compressed="${PACKAGE_DIR}/${IMAGE_NAME}.img.xz"
manifest="${PACKAGE_DIR}/${IMAGE_NAME}.manifest.txt"

if [[ ! -f "${image}" ]]; then
  cat >&2 <<EOF
SD card image not found:
  ${image}

Build an image first, for example:
  FRAMEOS_BUILD_RUNTIME=1 ./scripts/build-t113-s3-image.sh
EOF
  exit 1
fi

if ! command -v xz >/dev/null 2>&1; then
  echo "xz is required to package the image. Install xz-utils." >&2
  exit 1
fi

mkdir -p "${PACKAGE_DIR}"

tmp_compressed="${compressed}.tmp"
rm -f "${tmp_compressed}"
xz -T0 -9e -c "${image}" >"${tmp_compressed}"
mv "${tmp_compressed}" "${compressed}"

(
  cd "${PACKAGE_DIR}"
  sha256sum "$(basename -- "${compressed}")" >"$(basename -- "${compressed}").sha256"
)

raw_sha256="$(sha256sum "${image}" | awk '{ print $1 }')"
compressed_sha256="$(sha256sum "${compressed}" | awk '{ print $1 }')"
raw_size_bytes="$(stat -c '%s' "${image}")"
compressed_size_bytes="$(stat -c '%s' "${compressed}")"
git_commit="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || true)"

cat >"${manifest}" <<EOF
name=${IMAGE_NAME}
git_commit=${git_commit}
source_image=${image}
compressed_image=${compressed}
metadata=${metadata}
raw_size_bytes=${raw_size_bytes}
compressed_size_bytes=${compressed_size_bytes}
raw_sha256=${raw_sha256}
compressed_sha256=${compressed_sha256}
EOF

cat <<EOF
Packaged image: ${compressed}
Checksum: ${compressed}.sha256
Manifest: ${manifest}
EOF
