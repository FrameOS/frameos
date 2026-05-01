#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$1"
BR2_CONFIG_FILE="${BR2_CONFIG:-}"
INTERFACES_FILE="${TARGET_DIR}/etc/network/interfaces"

install -d -m 0755 \
  "${TARGET_DIR}/etc/frameos" \
  "${TARGET_DIR}/var/lib/frameos/assets" \
  "${TARGET_DIR}/var/log"

if [[ -f "${INTERFACES_FILE}" ]]; then
  interfaces_tmp="$(mktemp)"
  awk '
    $0 == "# FrameOS Wi-Fi interface begin" { skip = 1; next }
    $0 == "# FrameOS Wi-Fi interface end" { skip = 0; next }
    !skip { print }
  ' "${INTERFACES_FILE}" >"${interfaces_tmp}"
  mv "${interfaces_tmp}" "${INTERFACES_FILE}"
fi

if [[ -n "${BR2_CONFIG_FILE}" ]] &&
  [[ -f "${BR2_CONFIG_FILE}" ]] &&
  grep -q '^BR2_PACKAGE_WPA_SUPPLICANT=y$' "${BR2_CONFIG_FILE}"; then
  cat >>"${INTERFACES_FILE}" <<'EOF'

# FrameOS Wi-Fi interface begin
auto wlan0
iface wlan0 inet dhcp
wpa-conf /etc/wpa_supplicant.conf
# FrameOS Wi-Fi interface end
EOF
  if [[ ! -f "${TARGET_DIR}/etc/wpa_supplicant.conf" ]]; then
    cat >"${TARGET_DIR}/etc/wpa_supplicant.conf" <<'EOF'
ap_scan=1

network={
        ssid="YOURSSID"
        scan_ssid=1
        key_mgmt=WPA-PSK
        psk="YOURPASSWD"
}
EOF
  fi
  chmod 0600 "${TARGET_DIR}/etc/wpa_supplicant.conf"
else
  rm -f "${TARGET_DIR}/etc/wpa_supplicant.conf"
fi

if [[ -n "${FRAMEOS_RUNTIME_BINARY:-}" ]]; then
  if [[ ! -f "${FRAMEOS_RUNTIME_BINARY}" ]]; then
    echo "FRAMEOS_RUNTIME_BINARY does not exist: ${FRAMEOS_RUNTIME_BINARY}" >&2
    exit 1
  fi
  install -D -m 0755 "${FRAMEOS_RUNTIME_BINARY}" "${TARGET_DIR}/usr/bin/frameos"
else
  echo "No FRAMEOS_RUNTIME_BINARY set; /usr/bin/frameos will not be installed." >&2
fi
