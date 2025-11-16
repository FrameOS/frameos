#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKERFILE="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile"
OUTPUT_BASE="${ROOT_DIR}/build/prebuilt-deps"

NIM_VERSION="${NIM_VERSION:-2.2.4}"
QUICKJS_VERSION="${QUICKJS_VERSION:-2025-04-26}"
LGPIO_VERSION="${LGPIO_VERSION:-v0.2.2}"
LGPIO_REPO="${LGPIO_REPO:-https://github.com/joan2937/lg.git}"

RELEASES=("bookworm" "trixie")
ARCH_MATRIX=(
  "armhf:linux/arm/v7"
  "arm64:linux/arm64"
)

declare -a REQUESTED_TARGETS=()
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    if [[ ! $arg =~ ^pios-(buster|bookworm|trixie)-(armhf|arm64)$ ]]; then
      echo "Unknown target '$arg'. Expected format pios-<buster|bookworm|trixie>-<armhf|arm64>." >&2
      exit 1
    fi
    REQUESTED_TARGETS+=("$arg")
  done
else
  for release in "${RELEASES[@]}"; do
    for entry in "${ARCH_MATRIX[@]}"; do
      arch_name="${entry%%:*}"
      REQUESTED_TARGETS+=("pios-${release}-${arch_name}")
    done
  done
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

mkdir -p "${OUTPUT_BASE}"

for target in "${REQUESTED_TARGETS[@]}"; do
  release="${target#pios-}"
  release="${release%-*}"
  arch="${target##*-}"

  platform=""
  for entry in "${ARCH_MATRIX[@]}"; do
    arch_name="${entry%%:*}"
    plat="${entry#*:}"
    if [[ "${arch_name}" == "${arch}" ]]; then
      platform="${plat}"
      break
    fi
  done

  if [[ -z "${platform}" ]]; then
    echo "Could not map arch '${arch}' to a docker platform" >&2
    exit 1
  fi

  dest="${OUTPUT_BASE}/${target}"
  rm -rf "${dest}"
  mkdir -p "${dest}"

  echo "\n=== Building ${target} (Debian ${release}, platform ${platform}) ===" >&2

  docker buildx build \
    --progress=plain \
    --platform "${platform}" \
    --build-arg "DEBIAN_RELEASE=${release}" \
    --build-arg "TARGET_NAME=${target}" \
    --build-arg "NIM_VERSION=${NIM_VERSION}" \
    --build-arg "QUICKJS_VERSION=${QUICKJS_VERSION}" \
    --build-arg "LGPIO_VERSION=${LGPIO_VERSION}" \
    --build-arg "LGPIO_REPO=${LGPIO_REPO}" \
    --output "type=local,dest=${dest}" \
    --target artifacts \
    -f "${DOCKERFILE}" "${ROOT_DIR}"
done

cat <<INFO

Artifacts written to: ${OUTPUT_BASE}
Targets built: ${REQUESTED_TARGETS[*]}
INFO
