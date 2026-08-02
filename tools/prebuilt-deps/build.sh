#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_BASE="${ROOT_DIR}/build/prebuilt-deps"

NIM_VERSION="${NIM_VERSION:-2.2.4}"
QUICKJS_VERSION="${QUICKJS_VERSION:-2026-06-04}"
QUICKJS_SHA256="${QUICKJS_SHA256:-b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a}"

declare -a COMPONENTS=("nim" "quickjs")

# ARMv6 hard-float (Raspberry Pi Zero W / 1). No distro publishes
# linux/arm/v6 containers, so this target builds in an amd64 container with
# the Bootlin armv6-eabihf toolchain. Keep the tarball pin in sync with
# backend/app/utils/cross_toolchain_packages.py.
ARMV6_TOOLCHAIN_URL="${ARMV6_TOOLCHAIN_URL:-https://toolchains.bootlin.com/downloads/releases/toolchains/armv6-eabihf/tarballs/armv6-eabihf--glibc--stable-2024.05-1.tar.xz}"
ARMV6_TOOLCHAIN_SHA256="${ARMV6_TOOLCHAIN_SHA256:-2924afaa0d47e046339fe70bf526db5a19edaa58d87c6758a861ef41e2781368}"
ARMV6_CROSS_PREFIX="arm-buildroot-linux-gnueabihf-"

TARGET_MATRIX=(
  "debian|bullseye|armhf|linux/arm/v7|debian:bullseye"
  "debian|bullseye|arm64|linux/arm64|debian:bullseye"
  "debian|bullseye|amd64|linux/amd64|debian:bullseye"
  "debian|bookworm|armhf|linux/arm/v7|debian:bookworm"
  "debian|bookworm|arm64|linux/arm64|debian:bookworm"
  "debian|bookworm|amd64|linux/amd64|debian:bookworm"
  "debian|bookworm|armv6|linux/amd64|debian:bookworm"
  "debian|trixie|armhf|linux/arm/v7|debian:trixie"
  "debian|trixie|arm64|linux/arm64|debian:trixie"
  "debian|trixie|amd64|linux/amd64|debian:trixie"
  "ubuntu|24.04|arm64|linux/arm64|ubuntu:24.04"
  "ubuntu|24.04|amd64|linux/amd64|ubuntu:24.04"
  "ubuntu|26.04|arm64|linux/arm64|ubuntu:26.04"
  "ubuntu|26.04|amd64|linux/amd64|ubuntu:26.04"
)

# nim tarballs only bootstrap CI runners and dev hosts (amd64/arm64); frames
# compile pre-generated C sources with the device gcc and never run nim.
# armv6 targets therefore ship quickjs only.
target_components() {
  local arch="$1"
  if [[ "${arch}" == "armv6" ]]; then
    printf '%s' "quickjs"
  else
    printf '%s' "${COMPONENTS[*]}"
  fi
}

get_target_entry() {
  local search_target="$1"
  for entry in "${TARGET_MATRIX[@]}"; do
    IFS="|" read -r distro release arch _ <<<"${entry}"
    local entry_target="${distro}-${release}-${arch}"
    if [[ "${entry_target}" == "${search_target}" ]]; then
      printf '%s' "${entry}"
      return 0
    fi
  done
  return 1
}

list_targets() {
  local targets=()
  for entry in "${TARGET_MATRIX[@]}"; do
    IFS="|" read -r distro release arch _ <<<"${entry}"
    targets+=("${distro}-${release}-${arch}")
  done
  printf '%s' "${targets[*]}"
}

declare -a REQUESTED_TARGETS=()
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    if ! info="$(get_target_entry "${arg}")"; then
      echo "Unknown target '${arg}'." >&2
      echo "Valid targets: $(list_targets)" >&2
      exit 1
    fi
    REQUESTED_TARGETS+=("$arg")
  done
else
  for entry in "${TARGET_MATRIX[@]}"; do
    IFS="|" read -r distro release arch _ <<<"${entry}"
    REQUESTED_TARGETS+=("${distro}-${release}-${arch}")
  done
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

mkdir -p "${OUTPUT_BASE}"

component_marker() {
  local component="$1" target="$2" release="$3" platform="$4" arch="$5"
  local cross_suffix=""
  if [[ "${arch}" == "armv6" ]]; then
    cross_suffix="|${ARMV6_TOOLCHAIN_URL}|${ARMV6_TOOLCHAIN_SHA256}"
  fi
  case "${component}" in
    nim)
      printf '%s|%s|%s|%s|%s%s' "${target}" "${component}" "${release}" "${platform}" "${NIM_VERSION}" "${cross_suffix}"
      ;;
    quickjs)
      printf '%s|%s|%s|%s|%s|%s%s' "${target}" "${component}" "${release}" "${platform}" "${QUICKJS_VERSION}" "${QUICKJS_SHA256}" "${cross_suffix}"
      ;;
    *)
      echo "Unknown component '${component}'" >&2
      exit 1
      ;;
  esac
}

for target in "${REQUESTED_TARGETS[@]}"; do
  if ! info="$(get_target_entry "${target}")"; then
    echo "Unknown target '${target}'." >&2
    exit 1
  fi
  IFS="|" read -r distro release arch platform base_image <<<"${info}"

  dest="${OUTPUT_BASE}/${target}"
  mkdir -p "${dest}"

  echo "\n=== Target ${target} (${distro} ${release}, arch ${arch}, platform ${platform}) ===" >&2

  cross_args=()
  if [[ "${arch}" == "armv6" ]]; then
    cross_args=(
      "--build-arg" "CROSS_TOOLCHAIN_URL=${ARMV6_TOOLCHAIN_URL}"
      "--build-arg" "CROSS_TOOLCHAIN_SHA256=${ARMV6_TOOLCHAIN_SHA256}"
      "--build-arg" "CROSS_PREFIX=${ARMV6_CROSS_PREFIX}"
      "--build-arg" "CROSS_EXPECTED_CPU_ARCH=v6KZ"
    )
  fi

  read -r -a target_component_list <<<"$(target_components "${arch}")"
  for component in "${target_component_list[@]}"; do
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
          ${cross_args[@]+"${cross_args[@]}"}
        )
        ;;
      *)
        echo "Unknown component '${component}'" >&2
        exit 1
        ;;
    esac
    comp_dest="${dest}/${subdir}"
    marker_file="${comp_dest}/.build-info"
    expected_marker="$(component_marker "${component}" "${target}" "${release}" "${platform}" "${arch}")"

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
      --build-arg "BASE_IMAGE=${base_image}" \
      --build-arg "DISTRO_NAME=${distro}" \
      --build-arg "DISTRO_RELEASE=${release}" \
      --build-arg "TARGET_NAME=${target}" \
      "${component_args[@]}" \
      --output "type=local,dest=${comp_dest}" \
      --target artifacts \
      -f "${component_dockerfile}" "${ROOT_DIR}"

    printf '%s' "${expected_marker}" > "${marker_file}"
  done

  # The matrix platform column is the docker *build* platform; armv6 builds
  # in an amd64 container but targets linux/arm/v6.
  metadata_platform="${platform}"
  if [[ "${arch}" == "armv6" ]]; then
    metadata_platform="linux/arm/v6"
  fi

  components_json=""
  version_lines=""
  for component in "${target_component_list[@]}"; do
    [[ -n "${components_json}" ]] && components_json+=", "
    components_json+="\"${component}\""
    case "${component}" in
      nim) version_lines+="  \"nim_version\": \"${NIM_VERSION}\","$'\n' ;;
      quickjs) version_lines+="  \"quickjs_version\": \"${QUICKJS_VERSION}\","$'\n' ;;
    esac
  done

  cat >"${dest}/metadata.json" <<META
{
  "target": "${target}",
  "distribution": "${distro}",
  "release": "${release}",
  "arch": "${arch}",
  "platform": "${metadata_platform}",
${version_lines}  "components": [${components_json}]
}
META
done

cat <<INFO

Artifacts written to: ${OUTPUT_BASE}
Targets built: ${REQUESTED_TARGETS[*]}
INFO
