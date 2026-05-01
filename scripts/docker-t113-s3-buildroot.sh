#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_ROOT="${FRAMEOS_T113_S3_CONTAINER_ROOT:-/workspace/frameos}"
DOCKERFILE="${FRAMEOS_T113_S3_DOCKERFILE:-${ROOT_DIR}/backend/tools/t113-buildroot.Dockerfile}"
IMAGE="${FRAMEOS_T113_S3_DOCKER_IMAGE:-frameos-t113-s3-buildroot:bookworm}"
BUILDROOT_DIR_HOST="${BUILDROOT_DIR:-${ROOT_DIR}/build/buildroot}"
OUTPUT_DIR_HOST="${OUTPUT_DIR:-${ROOT_DIR}/build/buildroot-t113-s3}"
IMAGE_ARTIFACTS_DIR_HOST="${IMAGE_ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3-image}"
FRAMEOS_RUNTIME_ARTIFACTS_DIR_HOST="${FRAMEOS_RUNTIME_ARTIFACTS_DIR:-${ROOT_DIR}/build/frameos-t113-s3}"
GENERATED_DIR_HOST="${GENERATED_DIR:-${ROOT_DIR}/build/frameos-t113-s3-c}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $0 [build-t113-s3-image.sh args...]

Build or configure the T113-S3 Buildroot image inside a Linux Docker container.
Arguments are passed to scripts/build-t113-s3-image.sh, for example:
  $0 olddefconfig
  FRAMEOS_BUILD_RUNTIME=1 $0

Environment:
  FRAMEOS_T113_S3_DOCKER_IMAGE       Docker image tag. Default: ${IMAGE}
  FRAMEOS_T113_S3_DOCKERFILE         Dockerfile path. Default: ${DOCKERFILE}
  FRAMEOS_T113_S3_DOCKER_BUILD       Set to 0 to skip docker build. Default: 1
  FRAMEOS_T113_S3_DOCKER_PLATFORM    Optional docker --platform value
  FRAMEOS_T113_S3_SKIP_BOOTSTRAP     Set to 1 to skip Buildroot bootstrap
  BUILDROOT_DIR                      Host Buildroot checkout/cache directory
  OUTPUT_DIR                         Host Buildroot output directory
  IMAGE_ARTIFACTS_DIR                Host copied image artifact directory
  FRAMEOS_RUNTIME_ARTIFACTS_DIR      Host runtime artifact directory
  GENERATED_DIR                      Host generated C source directory

Most variables accepted by build-t113-s3-image.sh are forwarded into the
container, including FRAMEOS_BUILD_RUNTIME, FRAMEOS_WIFI_VARIANT, DEFCONFIG,
BUILDROOT_REF, BUILDROOT_REPO, BUILDROOT_UPDATE, FRAMEOS_RECONFIGURE, and
FRAMEOS_CONFIG_FRAGMENTS.
EOF
  exit 0
fi

abs_dir() {
  local path="$1"
  case "${path}" in
    /*) ;;
    *) path="${ROOT_DIR}/${path}" ;;
  esac
  mkdir -p "${path}"
  (cd "${path}" && pwd -P)
}

abs_file() {
  local path="$1"
  local dir
  case "${path}" in
    /*) ;;
    *) path="${ROOT_DIR}/${path}" ;;
  esac
  dir="$(dirname -- "${path}")"
  if [[ ! -d "${dir}" ]]; then
    echo "Parent directory does not exist for file path: ${path}" >&2
    exit 1
  fi
  printf '%s/%s\n' "$(cd "${dir}" && pwd -P)" "$(basename -- "${path}")"
}

mount_specs=()

add_mount() {
  local host_path="$1"
  local container_path="$2"
  local mode="${3:-}"
  local spec="${host_path}:${container_path}${mode:+:${mode}}"
  mount_specs+=("${spec}")
}

container_dir_for() {
  local host_path="$1"
  local label="$2"
  if [[ "${host_path}" == "${ROOT_DIR}" ]]; then
    printf '%s\n' "${CONTAINER_ROOT}"
  elif [[ "${host_path}" == "${ROOT_DIR}/"* ]]; then
    printf '%s/%s\n' "${CONTAINER_ROOT}" "${host_path#"${ROOT_DIR}/"}"
  else
    local target="/workspace/mounts/${label}"
    add_mount "${host_path}" "${target}"
    printf '%s\n' "${target}"
  fi
}

container_file_for() {
  local host_path="$1"
  local label="$2"
  local host_dir
  local target_dir
  host_dir="$(dirname -- "${host_path}")"
  if [[ "${host_path}" == "${ROOT_DIR}/"* ]]; then
    printf '%s/%s\n' "${CONTAINER_ROOT}" "${host_path#"${ROOT_DIR}/"}"
  else
    target_dir="/workspace/mounts/${label}"
    add_mount "${host_dir}" "${target_dir}"
    printf '%s/%s\n' "${target_dir}" "$(basename -- "${host_path}")"
  fi
}

translate_fragment_list() {
  local fragments="${1:-}"
  local fragment_array=()
  local translated=()
  local fragment
  [[ -n "${fragments}" ]] || return 0
  read -r -a fragment_array <<<"${fragments}"
  for fragment in "${fragment_array[@]}"; do
    local host_fragment
    host_fragment="$(abs_file "${fragment}")"
    if [[ ! -f "${host_fragment}" ]]; then
      echo "FRAMEOS_CONFIG_FRAGMENTS entry does not exist: ${fragment}" >&2
      exit 1
    fi
    translated+=("$(container_file_for "${host_fragment}" "config-fragment-${#translated[@]}")")
  done
  printf '%s\n' "${translated[*]}"
}

BUILDROOT_DIR_HOST="$(abs_dir "${BUILDROOT_DIR_HOST}")"
OUTPUT_DIR_HOST="$(abs_dir "${OUTPUT_DIR_HOST}")"
IMAGE_ARTIFACTS_DIR_HOST="$(abs_dir "${IMAGE_ARTIFACTS_DIR_HOST}")"
FRAMEOS_RUNTIME_ARTIFACTS_DIR_HOST="$(abs_dir "${FRAMEOS_RUNTIME_ARTIFACTS_DIR_HOST}")"
GENERATED_DIR_HOST="$(abs_dir "${GENERATED_DIR_HOST}")"

BUILDROOT_DIR_CONTAINER="$(container_dir_for "${BUILDROOT_DIR_HOST}" "buildroot")"
OUTPUT_DIR_CONTAINER="$(container_dir_for "${OUTPUT_DIR_HOST}" "output")"
IMAGE_ARTIFACTS_DIR_CONTAINER="$(container_dir_for "${IMAGE_ARTIFACTS_DIR_HOST}" "image-artifacts")"
FRAMEOS_RUNTIME_ARTIFACTS_DIR_CONTAINER="$(container_dir_for "${FRAMEOS_RUNTIME_ARTIFACTS_DIR_HOST}" "runtime-artifacts")"
GENERATED_DIR_CONTAINER="$(container_dir_for "${GENERATED_DIR_HOST}" "generated")"

FRAMEOS_RUNTIME_BINARY_CONTAINER=""
if [[ -n "${FRAMEOS_RUNTIME_BINARY:-}" ]]; then
  FRAMEOS_RUNTIME_BINARY_HOST="$(abs_file "${FRAMEOS_RUNTIME_BINARY}")"
  FRAMEOS_RUNTIME_BINARY_CONTAINER="$(container_file_for "${FRAMEOS_RUNTIME_BINARY_HOST}" "runtime-binary")"
fi

FRAMEOS_CONFIG_FRAGMENTS_CONTAINER=""
if [[ -n "${FRAMEOS_CONFIG_FRAGMENTS:-}" ]]; then
  FRAMEOS_CONFIG_FRAGMENTS_CONTAINER="$(translate_fragment_list "${FRAMEOS_CONFIG_FRAGMENTS}")"
fi

if [[ "${FRAMEOS_T113_S3_DOCKER_BUILD:-1}" == "1" ]]; then
  platform_args=()
  if [[ -n "${FRAMEOS_T113_S3_DOCKER_PLATFORM:-}" ]]; then
    platform_args=(--platform "${FRAMEOS_T113_S3_DOCKER_PLATFORM}")
  fi
  docker buildx build --load \
    "${platform_args[@]}" \
    -t "${IMAGE}" \
    -f "${DOCKERFILE}" \
    "${ROOT_DIR}"
fi

add_mount "${ROOT_DIR}" "${CONTAINER_ROOT}"

docker_args=()
for spec in "${mount_specs[@]}"; do
  docker_args+=(-v "${spec}")
done

container_env=(
  -e "BUILDROOT_DIR=${BUILDROOT_DIR_CONTAINER}"
  -e "OUTPUT_DIR=${OUTPUT_DIR_CONTAINER}"
  -e "BUILDROOT_OUTPUT_DIR=${OUTPUT_DIR_CONTAINER}"
  -e "IMAGE_ARTIFACTS_DIR=${IMAGE_ARTIFACTS_DIR_CONTAINER}"
  -e "FRAMEOS_RUNTIME_ARTIFACTS_DIR=${FRAMEOS_RUNTIME_ARTIFACTS_DIR_CONTAINER}"
  -e "GENERATED_DIR=${GENERATED_DIR_CONTAINER}"
  -e "HOST_UID=$(id -u)"
  -e "HOST_GID=$(id -g)"
  -e "FRAMEOS_T113_S3_SKIP_BOOTSTRAP=${FRAMEOS_T113_S3_SKIP_BOOTSTRAP:-0}"
)

if [[ -n "${FRAMEOS_RUNTIME_BINARY_CONTAINER}" ]]; then
  container_env+=(-e "FRAMEOS_RUNTIME_BINARY=${FRAMEOS_RUNTIME_BINARY_CONTAINER}")
fi
if [[ -n "${FRAMEOS_CONFIG_FRAGMENTS_CONTAINER}" ]]; then
  container_env+=(-e "FRAMEOS_CONFIG_FRAGMENTS=${FRAMEOS_CONFIG_FRAGMENTS_CONTAINER}")
fi

forward_names=(
  BUILDROOT_REPO
  BUILDROOT_REF
  BUILDROOT_UPDATE
  DEFCONFIG
  FRAMEOS_BUILD_RUNTIME
  FRAMEOS_RECONFIGURE
  FRAMEOS_WIFI_VARIANT
  TARGET
)

for name in "${forward_names[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    container_env+=(-e "${name}=${!name}")
  fi
done

run_platform_args=()
if [[ -n "${FRAMEOS_T113_S3_DOCKER_PLATFORM:-}" ]]; then
  run_platform_args=(--platform "${FRAMEOS_T113_S3_DOCKER_PLATFORM}")
fi

docker run --rm \
  "${run_platform_args[@]}" \
  "${docker_args[@]}" \
  "${container_env[@]}" \
  -w "${CONTAINER_ROOT}" \
  "${IMAGE}" \
  bash -lc '
    set -euo pipefail

    cleanup() {
      status=$?
      for path in "$BUILDROOT_DIR" "$OUTPUT_DIR" "$IMAGE_ARTIFACTS_DIR" "$FRAMEOS_RUNTIME_ARTIFACTS_DIR" "$GENERATED_DIR"; do
        if [ -e "$path" ]; then
          chown -R "$HOST_UID:$HOST_GID" "$path" 2>/dev/null || true
        fi
      done
      exit "$status"
    }
    trap cleanup EXIT

    cd '"${CONTAINER_ROOT}"'
    if [ "${FRAMEOS_T113_S3_SKIP_BOOTSTRAP:-0}" != "1" ]; then
      ./scripts/bootstrap-t113-s3-buildroot.sh
    fi
    ./scripts/build-t113-s3-image.sh "$@"
  ' bash "$@"
