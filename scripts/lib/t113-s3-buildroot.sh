#!/usr/bin/env bash

frameos_t113_s3_abs_path() {
  local path="$1"
  local dir
  dir="$(cd -- "$(dirname -- "${path}")" && pwd)"
  printf '%s/%s\n' "${dir}" "$(basename -- "${path}")"
}

frameos_t113_s3_preferred_host_tool() {
  local tool="$1"

  if [[ -x "/usr/bin/${tool}" ]]; then
    printf '/usr/bin/%s\n' "${tool}"
  elif command -v "${tool}" >/dev/null 2>&1; then
    command -v "${tool}"
  fi
}

frameos_t113_s3_set_host_compilers() {
  if [[ -z "${HOSTCC:-}" ]]; then
    HOSTCC="$(frameos_t113_s3_preferred_host_tool gcc)"
    export HOSTCC
  fi

  if [[ -z "${HOSTCXX:-}" ]]; then
    HOSTCXX="$(frameos_t113_s3_preferred_host_tool g++)"
    export HOSTCXX
  fi
}

frameos_t113_s3_assert_host_compilers() {
  local hostcc_cmd=()
  local hostcxx_cmd=()
  local test_bin

  frameos_t113_s3_set_host_compilers

  if [[ -z "${HOSTCC:-}" ]]; then
    echo "No host C compiler found. Install gcc or set HOSTCC." >&2
    return 1
  fi
  read -r -a hostcc_cmd <<<"${HOSTCC}"
  if ! command -v "${hostcc_cmd[0]}" >/dev/null 2>&1; then
    echo "HOSTCC is not executable or not on PATH: ${HOSTCC}" >&2
    return 1
  fi

  if [[ -z "${HOSTCXX:-}" ]]; then
    echo "No host C++ compiler found. Install g++ or set HOSTCXX." >&2
    return 1
  fi
  read -r -a hostcxx_cmd <<<"${HOSTCXX}"
  if ! command -v "${hostcxx_cmd[0]}" >/dev/null 2>&1; then
    echo "HOSTCXX is not executable or not on PATH: ${HOSTCXX}" >&2
    return 1
  fi

  test_bin="$(mktemp "${TMPDIR:-/tmp}/frameos-t113-s3-crypt.XXXXXX")"
  rm -f "${test_bin}"
  if ! printf '#include <crypt.h>\n#include <unistd.h>\nint main(void) { return crypt("x", "xx") == 0; }\n' |
    "${hostcc_cmd[@]}" -x c - -lcrypt -o "${test_bin}"; then
    rm -f "${test_bin}"
    cat >&2 <<EOF
HOSTCC cannot compile a program that includes <crypt.h> and links libcrypt.
Buildroot needs this for host tools such as mkpasswd.

Install the host crypt development headers, or set HOSTCC to a compiler that
can use them. On Debian/Ubuntu:
  sudo apt-get install -y libcrypt-dev
  HOSTCC=/usr/bin/gcc HOSTCXX=/usr/bin/g++ ./scripts/build-t113-s3-image.sh
EOF
    return 1
  fi
  rm -f "${test_bin}"
}

frameos_t113_s3_collect_config_fragments() {
  local external_dir="$1"
  local wifi_variant="${FRAMEOS_WIFI_VARIANT:-rtl8723ds}"

  FRAMEOS_T113_S3_CONFIG_FRAGMENTS=()

  case "${wifi_variant}" in
    "" | none | no-wifi)
      ;;
    rtl8189f | rtl8189fs)
      FRAMEOS_T113_S3_CONFIG_FRAGMENTS+=("${external_dir}/board/mangopi/mq-dual/wifi/rtl8189fs.config")
      ;;
    rtl8723ds)
      FRAMEOS_T113_S3_CONFIG_FRAGMENTS+=("${external_dir}/board/mangopi/mq-dual/wifi/rtl8723ds.config")
      ;;
    *)
      if [[ -f "${wifi_variant}" ]]; then
        FRAMEOS_T113_S3_CONFIG_FRAGMENTS+=("$(frameos_t113_s3_abs_path "${wifi_variant}")")
      else
        cat >&2 <<EOF
Unknown FRAMEOS_WIFI_VARIANT: ${wifi_variant}

Use one of:
  rtl8723ds
  rtl8189fs
  none

Or set FRAMEOS_WIFI_VARIANT to a readable Buildroot config fragment path.
EOF
        return 1
      fi
      ;;
  esac

  if [[ -n "${FRAMEOS_CONFIG_FRAGMENTS:-}" ]]; then
    local extra_fragments=()
    local fragment
    local fragment_abs
    read -r -a extra_fragments <<<"${FRAMEOS_CONFIG_FRAGMENTS}"
    for fragment in "${extra_fragments[@]}"; do
      if [[ ! -f "${fragment}" ]]; then
        echo "FRAMEOS_CONFIG_FRAGMENTS entry does not exist: ${fragment}" >&2
        return 1
      fi
      fragment_abs="$(frameos_t113_s3_abs_path "${fragment}")"
      FRAMEOS_T113_S3_CONFIG_FRAGMENTS+=("${fragment_abs}")
    done
  fi
}

frameos_t113_s3_configure_buildroot() {
  local buildroot_dir="$1"
  local output_dir="$2"
  local external_dir="$3"
  local defconfig="$4"
  local base_config="${external_dir}/configs/${defconfig}"

  if [[ ! -f "${base_config}" ]]; then
    echo "Buildroot defconfig not found: ${base_config}" >&2
    return 1
  fi

  mkdir -p "${output_dir}"
  frameos_t113_s3_collect_config_fragments "${external_dir}"

  if [[ "${#FRAMEOS_T113_S3_CONFIG_FRAGMENTS[@]}" -eq 0 ]]; then
    make -C "${buildroot_dir}" \
      O="${output_dir}" \
      BR2_EXTERNAL="${external_dir}" \
      "${defconfig}"
  else
    (
      cd "${buildroot_dir}"
      support/kconfig/merge_config.sh \
        -O "${output_dir}" \
        -e "${external_dir}" \
        "${base_config}" \
        "${FRAMEOS_T113_S3_CONFIG_FRAGMENTS[@]}"
    )
  fi
}
