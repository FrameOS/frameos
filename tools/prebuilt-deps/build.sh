#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_BASE="${ROOT_DIR}/build/prebuilt-deps"

NIM_VERSION="${NIM_VERSION:-2.2.4}"
QUICKJS_VERSION="${QUICKJS_VERSION:-2025-04-26}"
QUICKJS_SHA256="${QUICKJS_SHA256:-2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf}"
LGPIO_VERSION="${LGPIO_VERSION:-v0.2.2}"
LGPIO_REPO="${LGPIO_REPO:-https://github.com/joan2937/lg.git}"

declare -a COMPONENTS=("nim" "quickjs" "lgpio")

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

component_marker() {
  local component="$1" target="$2" release="$3" platform="$4"
  case "${component}" in
    nim)
      printf '%s|%s|%s|%s|%s' "${target}" "${component}" "${release}" "${platform}" "${NIM_VERSION}"
      ;;
    quickjs)
      printf '%s|%s|%s|%s|%s|%s' "${target}" "${component}" "${release}" "${platform}" "${QUICKJS_VERSION}" "${QUICKJS_SHA256}"
      ;;
    lgpio)
      printf '%s|%s|%s|%s|%s|%s' "${target}" "${component}" "${release}" "${platform}" "${LGPIO_VERSION}" "${LGPIO_REPO}"
      ;;
    *)
      echo "Unknown component '${component}'" >&2
      exit 1
      ;;
  esac
}

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
  mkdir -p "${dest}"

  echo "\n=== Target ${target} (Debian ${release}, platform ${platform}) ===" >&2

  for component in "${COMPONENTS[@]}"; do
    component_args=()
    case "${component}" in
      nim)
        subdir="nim-${NIM_VERSION}"
        component_dockerfile="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile.nim"
        component_args=("--build-arg" "NIM_VERSION=${NIM_VERSION}")
        ;;
      quickjs)
        subdir="quickjs-${QUICKJS_VERSION}"
        component_dockerfile="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile.quickjs"
        component_args=(
          "--build-arg" "QUICKJS_VERSION=${QUICKJS_VERSION}"
          "--build-arg" "QUICKJS_SHA256=${QUICKJS_SHA256}"
        )
        ;;
      lgpio)
        subdir="lgpio-${LGPIO_VERSION}"
        component_dockerfile="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile.lgpio"
        component_args=(
          "--build-arg" "LGPIO_VERSION=${LGPIO_VERSION}"
          "--build-arg" "LGPIO_REPO=${LGPIO_REPO}"
        )
        ;;
      *)
        echo "Unknown component '${component}'" >&2
        exit 1
        ;;
    esac
    comp_dest="${dest}/${subdir}"
    marker_file="${comp_dest}/.build-info"
    expected_marker="$(component_marker "${component}" "${target}" "${release}" "${platform}")"

    if [[ -f "${marker_file}" ]]; then
      existing_marker="$(<"${marker_file}")"
    else
      existing_marker=""
    fi

    if [[ "${existing_marker}" == "${expected_marker}" ]]; then
      echo " - ${component}: already built, skipping" >&2
      continue
    fi

    echo " - ${component}: building" >&2
    rm -rf "${comp_dest}"
    mkdir -p "${comp_dest}"

    docker buildx build \
      --progress=plain \
      --platform "${platform}" \
      --build-arg "DEBIAN_RELEASE=${release}" \
      --build-arg "TARGET_NAME=${target}" \
      "${component_args[@]}" \
      --output "type=local,dest=${comp_dest}" \
      --target artifacts \
      -f "${component_dockerfile}" "${ROOT_DIR}"

    printf '%s' "${expected_marker}" > "${marker_file}"
  done

  cat >"${dest}/metadata.json" <<META
{
  "target": "${target}",
  "debian_release": "${release}",
  "platform": "${platform}",
  "nim_version": "${NIM_VERSION}",
  "quickjs_version": "${QUICKJS_VERSION}",
  "lgpio_version": "${LGPIO_VERSION}"
}
META
done

cat <<INFO

Artifacts written to: ${OUTPUT_BASE}
Targets built: ${REQUESTED_TARGETS[*]}
INFO
