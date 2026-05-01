#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXTERNAL_DIR="${ROOT_DIR}/buildroot-external/frameos-t113-s3"
OVERLAY_DIR="${EXTERNAL_DIR}/board/mangopi/mq-dual/rootfs_overlay"
POST_BUILD="${EXTERNAL_DIR}/board/mangopi/mq-dual/post-build.sh"

tmpdirs=()

cleanup() {
  if [[ "${#tmpdirs[@]}" -gt 0 ]]; then
    rm -rf "${tmpdirs[@]}"
  fi
}
trap cleanup EXIT

new_tmpdir() {
  local tmpdir
  tmpdir="$(mktemp -d /tmp/frameos-t113-smoke.XXXXXX)"
  tmpdirs+=("${tmpdir}")
  printf '%s\n' "${tmpdir}"
}

assert_file_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -Eq "${pattern}" "${file}"; then
    echo "Expected ${file} to match: ${pattern}" >&2
    exit 1
  fi
}

assert_file_not_contains() {
  local file="$1"
  local pattern="$2"
  if grep -Eq "${pattern}" "${file}"; then
    echo "Expected ${file} not to match: ${pattern}" >&2
    exit 1
  fi
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

check_shell_syntax() {
  bash -n \
    "${ROOT_DIR}/scripts/lib/t113-s3-buildroot.sh" \
    "${ROOT_DIR}/scripts/bootstrap-t113-s3-buildroot.sh" \
    "${ROOT_DIR}/scripts/build-t113-s3-image.sh" \
    "${ROOT_DIR}/scripts/build-t113-s3-frameos.sh" \
    "${ROOT_DIR}/scripts/docker-t113-s3-buildroot.sh" \
    "${ROOT_DIR}/scripts/inspect-t113-s3-build.sh" \
    "${ROOT_DIR}/scripts/package-t113-s3-image.sh" \
    "${POST_BUILD}"
}

check_wifi_fragment_selection() {
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/scripts/lib/t113-s3-buildroot.sh"

  unset FRAMEOS_WIFI_VARIANT FRAMEOS_CONFIG_FRAGMENTS
  frameos_t113_s3_collect_config_fragments "${EXTERNAL_DIR}"
  [[ "${#FRAMEOS_T113_S3_CONFIG_FRAGMENTS[@]}" -eq 0 ]]

  FRAMEOS_WIFI_VARIANT=rtl8723ds
  frameos_t113_s3_collect_config_fragments "${EXTERNAL_DIR}"
  [[ "${#FRAMEOS_T113_S3_CONFIG_FRAGMENTS[@]}" -eq 1 ]]
  [[ "${FRAMEOS_T113_S3_CONFIG_FRAGMENTS[0]}" == *"/wifi/rtl8723ds.config" ]]

  FRAMEOS_WIFI_VARIANT=rtl8189fs
  frameos_t113_s3_collect_config_fragments "${EXTERNAL_DIR}"
  [[ "${#FRAMEOS_T113_S3_CONFIG_FRAGMENTS[@]}" -eq 1 ]]
  [[ "${FRAMEOS_T113_S3_CONFIG_FRAGMENTS[0]}" == *"/wifi/rtl8189fs.config" ]]
}

copy_overlay() {
  local target="$1"
  mkdir -p "${target}"
  cp -a "${OVERLAY_DIR}/." "${target}/"
}

check_post_build_network_config() {
  local tmpdir
  local target
  local config

  tmpdir="$(new_tmpdir)"
  target="${tmpdir}/target"
  config="${tmpdir}/buildroot.config"
  copy_overlay "${target}"

  printf '# BR2_PACKAGE_WPA_SUPPLICANT is not set\n' >"${config}"
  BR2_CONFIG="${config}" "${POST_BUILD}" "${target}" >/dev/null 2>&1
  assert_file_not_contains "${target}/etc/network/interfaces" 'wlan0|wpa-conf|FrameOS Wi-Fi interface'
  [[ ! -e "${target}/etc/wpa_supplicant.conf" ]]

  printf 'BR2_PACKAGE_WPA_SUPPLICANT=y\n' >"${config}"
  BR2_CONFIG="${config}" "${POST_BUILD}" "${target}" >/dev/null 2>&1
  BR2_CONFIG="${config}" "${POST_BUILD}" "${target}" >/dev/null 2>&1
  assert_file_contains "${target}/etc/network/interfaces" '^auto wlan0$'
  assert_file_contains "${target}/etc/network/interfaces" '^wpa-conf /etc/wpa_supplicant.conf$'
  [[ "$(grep -Ec '^auto wlan0$' "${target}/etc/network/interfaces")" -eq 1 ]]
  [[ -f "${target}/etc/wpa_supplicant.conf" ]]
  [[ "$(file_mode "${target}/etc/wpa_supplicant.conf")" == "600" ]]

  printf '# BR2_PACKAGE_WPA_SUPPLICANT is not set\n' >"${config}"
  BR2_CONFIG="${config}" "${POST_BUILD}" "${target}" >/dev/null 2>&1
  assert_file_not_contains "${target}/etc/network/interfaces" 'wlan0|wpa-conf|FrameOS Wi-Fi interface'
  [[ ! -e "${target}/etc/wpa_supplicant.conf" ]]
}

check_packaging() {
  local tmpdir

  tmpdir="$(new_tmpdir)"
  printf 'frameos-test-image' >"${tmpdir}/sdcard.img"
  IMAGE_ARTIFACTS_DIR="${tmpdir}" \
    PACKAGE_DIR="${tmpdir}/download" \
    IMAGE_NAME="test-image" \
    "${ROOT_DIR}/scripts/package-t113-s3-image.sh" >/dev/null
  (
    cd "${tmpdir}/download"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c test-image.img.xz.sha256 >/dev/null
    else
      shasum -a 256 -c test-image.img.xz.sha256 >/dev/null
    fi
  )
  assert_file_contains "${tmpdir}/download/test-image.manifest.txt" '^compressed_sha256='
}

check_shell_syntax
check_wifi_fragment_selection
check_post_build_network_config
check_packaging

echo "T113-S3 Buildroot smoke checks passed."
