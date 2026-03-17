#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
FRAMEOS_ROOT="${ROOT_DIR}/frameos"
CROSS_SCRIPT="${ROOT_DIR}/backend/bin/cross"
OUTPUT_BASE="${ROOT_DIR}/build/prebuilt-deps"
CROSS_OUTPUT_BASE="${ROOT_DIR}/build/prebuilt-cross"

NIM_VERSION="${NIM_VERSION:-2.2.4}"
QUICKJS_VERSION="${QUICKJS_VERSION:-2025-04-26}"
QUICKJS_SHA256="${QUICKJS_SHA256:-2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf}"
DEFAULT_LGPIO_REPO="https://github.com/joan2937/lg.git"
LGPIO_VERSION="${LGPIO_VERSION:-v0.2.2}"
LGPIO_REPO="${LGPIO_REPO:-${DEFAULT_LGPIO_REPO}}"

compute_frameos_version() {
  if ! git -C "${ROOT_DIR}" rev-parse --verify HEAD >/dev/null 2>&1; then
    date -u +%Y%m%d%H%M%S
    return
  fi

  local version
  version="$(git -C "${ROOT_DIR}" rev-parse --short=12 HEAD)"
  if [[ -n "$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=normal -- frameos backend tools/prebuilt-deps package.json pnpm-lock.yaml pnpm-workspace.yaml versions.json frontend 2>/dev/null)" ]]; then
    version="${version}-dirty"
  fi
  printf '%s' "${version}"
}

run_backend_python() {
  local existing_pythonpath="${PYTHONPATH:-}"
  PYTHONPATH="${ROOT_DIR}/backend${existing_pythonpath:+:${existing_pythonpath}}" python3 "$@"
}

read_frameos_release_version() {
  run_backend_python -m app.utils.prebuilt_cross frameos-version --repo-root "${ROOT_DIR}" --field base
}

write_cross_target_metadata() {
  local target_dir="$1" target="$2" distro="$3" release="$4" arch="$5" platform="$6" image="$7"
  python3 - "${target_dir}" "${target}" "${distro}" "${release}" "${arch}" "${platform}" "${image}" <<'PY'
import json
import sys
from pathlib import Path

target_dir = Path(sys.argv[1])
target = sys.argv[2]
distro = sys.argv[3]
release = sys.argv[4]
arch = sys.argv[5]
platform = sys.argv[6]
image = sys.argv[7]

payload = {
    "slug": target,
    "target": target,
    "arch": arch,
    "distribution": distro,
    "distro": distro,
    "release": release,
    "version": release,
    "platform": platform,
    "image": image,
}

target_dir.mkdir(parents=True, exist_ok=True)
(target_dir / "metadata.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
}

write_cross_manifest() {
  local root_dir="$1" source_version="$2"
  shift 2
  local -a manifest_cmd=(
    -m app.utils.prebuilt_cross write-manifest
    --root "${root_dir}"
    --frameos-version "${FRAMEOS_RELEASE_VERSION}"
    --source-version "${source_version}"
    --exclude-name manifest.json
  )
  while [[ $# -gt 0 ]]; do
    manifest_cmd+=("$1")
    shift
  done
  run_backend_python "${manifest_cmd[@]}" >/dev/null
}

FRAMEOS_VERSION_OVERRIDE="${FRAMEOS_VERSION:-}"
FRAMEOS_VERSION="${FRAMEOS_VERSION_OVERRIDE:-$(compute_frameos_version)}"
FRAMEOS_RELEASE_VERSION="${FRAMEOS_VERSION_OVERRIDE%%+*}"
if [[ -z "${FRAMEOS_RELEASE_VERSION}" ]]; then
  FRAMEOS_RELEASE_VERSION="$(read_frameos_release_version)"
fi
if [[ -z "${FRAMEOS_RELEASE_VERSION}" ]]; then
  FRAMEOS_RELEASE_VERSION="${FRAMEOS_VERSION%%+*}"
fi
CROSS_RELEASE_DIR="${CROSS_OUTPUT_BASE}/${FRAMEOS_RELEASE_VERSION}"

declare -a STATIC_COMPONENTS=("nim" "quickjs" "lgpio")

list_targets() {
  python3 "${CROSS_SCRIPT}" list | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

usage() {
  cat <<EOF
Usage: ./tools/prebuilt-deps/build.sh [target ...]

Builds prebuilt FrameOS artifacts for the requested targets. When no targets are
provided, it builds every target from backend/bin/cross.

Artifacts built per target:
  - nim
  - quickjs
  - lgpio
  - frameos
  - all compiled driver plugins

Examples:
  ./tools/prebuilt-deps/build.sh
  ./tools/prebuilt-deps/build.sh debian-bookworm-arm64 ubuntu-24.04-amd64
  FRAMEOS_VERSION=my-build ./tools/prebuilt-deps/build.sh

Environment overrides:
  NIM_VERSION
  QUICKJS_VERSION
  QUICKJS_SHA256
  LGPIO_VERSION
  LGPIO_REPO
  FRAMEOS_VERSION
  FRAMEOS_DRIVER_JOBS

Targets:
  $(list_targets)
EOF
}

get_target_entry() {
  python3 "${CROSS_SCRIPT}" show-target --target "$1" --format tsv
}

component_marker() {
  local target="$1" component="$2" release="$3" platform="$4"
  shift 4
  printf '%s|%s|%s|%s' "${target}" "${component}" "${release}" "${platform}"
  for part in "$@"; do
    printf '|%s' "${part}"
  done
}

component_is_current() {
  local component_dir="$1" expected_marker="$2"
  local marker_file="${component_dir}/.build-info"
  if [[ ! -f "${marker_file}" ]]; then
    return 1
  fi
  local existing_marker
  existing_marker="$(<"${marker_file}")"
  [[ "${existing_marker}" == "${expected_marker}" ]]
}

write_component_marker() {
  local component_dir="$1" expected_marker="$2"
  printf '%s' "${expected_marker}" > "${component_dir}/.build-info"
}

write_metadata() {
  local target_dir="$1" target="$2" distro="$3" release="$4" arch="$5" platform="$6" components_file="$7"
  python3 - "${target_dir}" "${target}" "${distro}" "${release}" "${arch}" "${platform}" "${components_file}" <<'PY'
import json
import sys
from pathlib import Path

target_dir = Path(sys.argv[1])
target = sys.argv[2]
distro = sys.argv[3]
release = sys.argv[4]
arch = sys.argv[5]
platform = sys.argv[6]
components_file = Path(sys.argv[7])

components: dict[str, dict[str, str]] = {}
for raw_line in components_file.read_text(encoding="utf-8").splitlines():
    if not raw_line:
        continue
    component, version, directory, artifact, driver_id = raw_line.split("|", 4)
    entry = {
        "version": version,
        "directory": directory,
    }
    if artifact:
        entry["artifact"] = artifact
    if driver_id:
        entry["driver_id"] = driver_id
    components[component] = entry

payload = {
    "target": target,
    "distribution": distro,
    "release": release,
    "arch": arch,
    "platform": platform,
    "components": components,
}

for component in ("nim", "quickjs", "lgpio", "frameos"):
    version = components.get(component, {}).get("version")
    if version:
        payload[f"{component}_version"] = version

(target_dir / "metadata.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
}

try_stage_published_component() {
  local component="$1" target="$2" version="$3" component_dir="$4" expected_marker="$5"

  case "${component}" in
    lgpio)
      if [[ "${LGPIO_REPO}" != "${DEFAULT_LGPIO_REPO}" ]]; then
        return 1
      fi
      ;;
    *)
      return 1
      ;;
  esac

  if run_backend_python -m app.utils.prebuilt_component \
    --target "${target}" \
    --component "${component}" \
    --version "${version}" \
    --dest "${component_dir}" \
    --expected-marker "${expected_marker}"; then
    echo " - ${component}: using published prebuilt" >&2
    return 0
  fi

  return 1
}

build_static_component() {
  local component="$1" target="$2" distro="$3" release="$4" platform="$5" base_image="$6" target_dir="$7"

  local subdir component_dockerfile expected_marker component_version
  local -a component_args=()
  case "${component}" in
    nim)
      subdir="nim-${NIM_VERSION}"
      component_version="${NIM_VERSION}"
      component_dockerfile="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile.nim"
      component_args=("--build-arg" "NIM_VERSION=${NIM_VERSION}")
      expected_marker="$(component_marker "${target}" "${component}" "${release}" "${platform}" "${NIM_VERSION}")"
      ;;
    quickjs)
      subdir="quickjs-${QUICKJS_VERSION}"
      component_version="${QUICKJS_VERSION}"
      component_dockerfile="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile.quickjs"
      component_args=(
        "--build-arg" "QUICKJS_VERSION=${QUICKJS_VERSION}"
        "--build-arg" "QUICKJS_SHA256=${QUICKJS_SHA256}"
      )
      expected_marker="$(component_marker "${target}" "${component}" "${release}" "${platform}" "${QUICKJS_VERSION}" "${QUICKJS_SHA256}")"
      ;;
    lgpio)
      subdir="lgpio-${LGPIO_VERSION}"
      component_version="${LGPIO_VERSION}"
      component_dockerfile="${ROOT_DIR}/tools/prebuilt-deps/Dockerfile.lgpio"
      component_args=(
        "--build-arg" "LGPIO_VERSION=${LGPIO_VERSION}"
        "--build-arg" "LGPIO_REPO=${LGPIO_REPO}"
      )
      expected_marker="$(component_marker "${target}" "${component}" "${release}" "${platform}" "${LGPIO_VERSION}" "${LGPIO_REPO}")"
      ;;
    *)
      echo "Unknown component '${component}'" >&2
      exit 1
      ;;
  esac

  local comp_dest="${target_dir}/${subdir}"
  if component_is_current "${comp_dest}" "${expected_marker}"; then
    echo " - ${component}: already built, skipping" >&2
    return
  fi

  if try_stage_published_component "${component}" "${target}" "${component_version}" "${comp_dest}" "${expected_marker}"; then
    return
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

  if [[ "${component}" == "lgpio" ]]; then
    for static_lib in lib/liblgpio.a lib/librgpio.a; do
      if [[ ! -f "${comp_dest}/${static_lib}" ]]; then
        echo " - ${component}: missing ${static_lib} in artifacts" >&2
        exit 1
      fi
    done
  fi

  write_component_marker "${comp_dest}" "${expected_marker}"
}

declare -a REQUESTED_TARGETS=()
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    case "${arg}" in
      -h|--help)
        usage
        exit 0
        ;;
      -*)
        echo "Unknown option '${arg}'." >&2
        usage >&2
        exit 1
        ;;
    esac
    if ! get_target_entry "${arg}" >/dev/null 2>&1; then
      echo "Unknown target '${arg}'." >&2
      echo "Valid targets: $(list_targets)" >&2
      exit 1
    fi
    REQUESTED_TARGETS+=("${arg}")
  done
else
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    REQUESTED_TARGETS+=("${line}")
  done < <(python3 "${CROSS_SCRIPT}" list)
fi

declare -a DRIVER_ROWS=()
while IFS= read -r line; do
  [[ -n "${line}" ]] || continue
  DRIVER_ROWS+=("${line}")
done < <(python3 "${CROSS_SCRIPT}" list-drivers --format tsv)

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

mkdir -p "${OUTPUT_BASE}" "${CROSS_OUTPUT_BASE}" "${CROSS_RELEASE_DIR}"

for target in "${REQUESTED_TARGETS[@]}"; do
  if ! info="$(get_target_entry "${target}")"; then
    echo "Unknown target '${target}'." >&2
    exit 1
  fi
  IFS="|" read -r _slug distro release arch platform base_image _runner <<<"${info}"

  dest="${OUTPUT_BASE}/${target}"
  cross_dest="${CROSS_RELEASE_DIR}/${target}"
  mkdir -p "${dest}" "${cross_dest}"

  printf '\n=== Target %s (%s %s, platform %s) ===\n' "${target}" "${distro}" "${release}" "${platform}" >&2

  for component in "${STATIC_COMPONENTS[@]}"; do
    build_static_component "${component}" "${target}" "${distro}" "${release}" "${platform}" "${base_image}" "${dest}"
  done

  frameos_component_dir="${dest}/frameos-${FRAMEOS_VERSION}"
  frameos_marker="$(component_marker "${target}" "frameos" "${release}" "${platform}" "${FRAMEOS_VERSION}" "quickjs=${QUICKJS_VERSION}")"
  if component_is_current "${frameos_component_dir}" "${frameos_marker}"; then
    echo " - frameos: already built, skipping" >&2
  else
    echo " - frameos: building" >&2
    rm -rf "${frameos_component_dir}"
    mkdir -p "${frameos_component_dir}"
    rm -f "${cross_dest}/frameos"
    python3 "${CROSS_SCRIPT}" build-frameos \
      --target "${target}" \
      --frameos-root "${FRAMEOS_ROOT}" \
      --artifacts-dir "${CROSS_RELEASE_DIR}" \
      --prebuilt-component "quickjs=${dest}/quickjs-${QUICKJS_VERSION}" \
      --prebuilt-component "lgpio=${dest}/lgpio-${LGPIO_VERSION}"

    if [[ ! -f "${cross_dest}/frameos" ]]; then
      echo " - frameos: expected runtime artifact missing at ${cross_dest}/frameos" >&2
      exit 1
    fi
    cp "${cross_dest}/frameos" "${frameos_component_dir}/frameos"
    chmod 755 "${frameos_component_dir}/frameos"
    write_component_marker "${frameos_component_dir}" "${frameos_marker}"
  fi

  declare -a DRIVER_IDS_TO_BUILD=()
  declare -a DRIVER_COPY_ROWS=()
  for row in "${DRIVER_ROWS[@]}"; do
    IFS="|" read -r driver_id component_name library_name <<<"${row}"
    component_dir="${dest}/${component_name}-${FRAMEOS_VERSION}"
    driver_marker="$(component_marker "${target}" "${component_name}" "${release}" "${platform}" "${FRAMEOS_VERSION}" "driver=${driver_id}" "lgpio=${LGPIO_VERSION}")"
    if component_is_current "${component_dir}" "${driver_marker}"; then
      echo " - ${component_name}: already built, skipping" >&2
      continue
    fi
    DRIVER_IDS_TO_BUILD+=("${driver_id}")
    DRIVER_COPY_ROWS+=("${row}")
  done

  if [[ ${#DRIVER_IDS_TO_BUILD[@]} -gt 0 ]]; then
    echo " - drivers: building ${#DRIVER_IDS_TO_BUILD[@]} plugin(s)" >&2
    rm -rf "${cross_dest}/drivers"
    build_driver_cmd=(
      python3 "${CROSS_SCRIPT}" build-drivers
      --target "${target}"
      --frameos-root "${FRAMEOS_ROOT}"
      --artifacts-dir "${CROSS_RELEASE_DIR}"
      --prebuilt-component "lgpio=${dest}/lgpio-${LGPIO_VERSION}"
    )
    for driver_id in "${DRIVER_IDS_TO_BUILD[@]}"; do
      build_driver_cmd+=(--driver "${driver_id}")
    done
    "${build_driver_cmd[@]}"
  fi

  if [[ ${#DRIVER_COPY_ROWS[@]} -gt 0 ]]; then
    for row in "${DRIVER_COPY_ROWS[@]}"; do
      IFS="|" read -r driver_id component_name library_name <<<"${row}"
      component_dir="${dest}/${component_name}-${FRAMEOS_VERSION}"
      driver_marker="$(component_marker "${target}" "${component_name}" "${release}" "${platform}" "${FRAMEOS_VERSION}" "driver=${driver_id}" "lgpio=${LGPIO_VERSION}")"
      rm -rf "${component_dir}"
      mkdir -p "${component_dir}"
      if [[ ! -f "${cross_dest}/drivers/${library_name}" ]]; then
        echo " - ${component_name}: expected driver artifact missing at ${cross_dest}/drivers/${library_name}" >&2
        exit 1
      fi
      cp "${cross_dest}/drivers/${library_name}" "${component_dir}/${library_name}"
      write_component_marker "${component_dir}" "${driver_marker}"
    done
  fi

  frameos_binary="${frameos_component_dir}/frameos"
  if [[ ! -f "${frameos_binary}" ]]; then
    echo " - frameos: expected runtime artifact missing at ${frameos_binary}" >&2
    exit 1
  fi
  cp "${frameos_binary}" "${cross_dest}/frameos"
  chmod 755 "${cross_dest}/frameos"

  rm -rf "${cross_dest}/drivers"
  mkdir -p "${cross_dest}/drivers"
  for row in "${DRIVER_ROWS[@]}"; do
    IFS="|" read -r driver_id component_name library_name <<<"${row}"
    component_dir="${dest}/${component_name}-${FRAMEOS_VERSION}"
    built_library="${component_dir}/${library_name}"
    if [[ ! -f "${built_library}" ]]; then
      echo " - ${component_name}: expected driver artifact missing at ${built_library}" >&2
      exit 1
    fi
    cp "${built_library}" "${cross_dest}/drivers/${library_name}"
  done

  write_cross_target_metadata "${cross_dest}" "${target}" "${distro}" "${release}" "${arch}" "${platform}" "${base_image}"
  write_cross_manifest "${cross_dest}" "${FRAMEOS_VERSION}" --target "${target}"

  components_file="$(mktemp)"
  {
    printf 'nim|%s|nim-%s||\n' "${NIM_VERSION}" "${NIM_VERSION}"
    printf 'quickjs|%s|quickjs-%s||\n' "${QUICKJS_VERSION}" "${QUICKJS_VERSION}"
    printf 'lgpio|%s|lgpio-%s||\n' "${LGPIO_VERSION}" "${LGPIO_VERSION}"
    printf 'frameos|%s|frameos-%s|frameos|\n' "${FRAMEOS_VERSION}" "${FRAMEOS_VERSION}"
    for row in "${DRIVER_ROWS[@]}"; do
      IFS="|" read -r driver_id component_name library_name <<<"${row}"
      printf '%s|%s|%s-%s|%s|%s\n' \
        "${component_name}" \
        "${FRAMEOS_VERSION}" \
        "${component_name}" \
        "${FRAMEOS_VERSION}" \
        "${library_name}" \
        "${driver_id}"
    done
  } > "${components_file}"
  write_metadata "${dest}" "${target}" "${distro}" "${release}" "${arch}" "${platform}" "${components_file}"
  rm -f "${components_file}"

  write_cross_manifest "${CROSS_RELEASE_DIR}" "${FRAMEOS_VERSION}"

  legacy_cross_dest="${CROSS_OUTPUT_BASE}/${target}"
  if [[ "${legacy_cross_dest}" != "${cross_dest}" && -d "${legacy_cross_dest}" ]]; then
    rm -rf "${legacy_cross_dest}"
  fi
done

cat <<INFO

Artifacts written to: ${OUTPUT_BASE}
Cross artifacts written to: ${CROSS_RELEASE_DIR}
Targets built: ${REQUESTED_TARGETS[*]}
FrameOS version: ${FRAMEOS_VERSION}
FrameOS release: ${FRAMEOS_RELEASE_VERSION}
INFO
