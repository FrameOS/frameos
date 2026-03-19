#!/usr/bin/env bash
set -euo pipefail

FRAMEOS_BASE_URL="${FRAMEOS_BASE_URL:-https://files.frameos.net}"
FRAMEOS_ARCHIVE_BASE_URL="${FRAMEOS_ARCHIVE_BASE_URL:-https://archive.frameos.net}"
FRAMEOS_FONTS_URL="${FRAMEOS_FONTS_URL:-${FRAMEOS_BASE_URL%/}/fonts/default/fonts.zip}"
DEFAULT_INSTALL_DIR="/srv/frameos"
DEFAULT_ASSETS_DIR="/srv/assets"
DEFAULT_RELEASE_NAME="initial"
DEFAULT_FRAME_PORT="8787"
DEFAULT_SERVER_PORT="8989"
DEFAULT_METRICS_INTERVAL="60.0"
DEFAULT_SCALING_MODE="contain"
DEFAULT_ROTATE="0"
DEFAULT_FRAME_ACCESS="public"
DEFAULT_WIFI_HOTSPOT="disabled"
DEFAULT_WIDTH="800"
DEFAULT_HEIGHT="480"
DEFAULT_VCOM="-1.5"
DEFAULT_LGPIO_VERSION="v0.2.2"
DEFAULT_LGPIO_SHA256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

APT_UPDATED=0
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "This installer needs root or sudo." >&2
    exit 1
  fi
fi

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

have_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

tty_printf() {
  if have_tty; then
    printf '%s' "$*" > /dev/tty
  else
    printf '%s' "$*"
  fi
}

usage() {
  cat <<'EOF'
FrameOS installer

Run with:
  curl -fsSL https://files.frameos.net/install.sh | bash

Optional environment overrides:
  FRAMEOS_BASE_URL
  FRAMEOS_ARCHIVE_BASE_URL
  FRAMEOS_VERSION
  FRAMEOS_NAME
  FRAMEOS_INSTALL_DIR
  FRAMEOS_ASSETS_DIR
  FRAMEOS_RUN_USER
  FRAMEOS_RUN_GROUP
  FRAMEOS_DEVICE
  FRAMEOS_WIDTH
  FRAMEOS_HEIGHT
  FRAMEOS_ROTATE
  FRAMEOS_VCOM
  FRAMEOS_FRAME_HOST
  FRAMEOS_FRAME_PORT
  FRAMEOS_HTTP_UPLOAD_URL
  FRAMEOS_HTTP_UPLOAD_HEADER_NAME
  FRAMEOS_HTTP_UPLOAD_HEADER_VALUE
  FRAMEOS_SERVER_HOST
  FRAMEOS_SERVER_PORT
  FRAMEOS_SERVER_API_KEY
  FRAMEOS_SERVER_SEND_LOGS
  FRAMEOS_FRAME_ACCESS
  FRAMEOS_ADMIN_USER
  FRAMEOS_ADMIN_PASSWORD
  FRAMEOS_FORCE
  FRAMEOS_REBOOT_NOW
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

normalize_url_base() {
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1].strip()
print(value[:-1] if value.endswith("/") else value)
PY
}

normalize_path() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
}

apt_update_once() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    log "Refreshing apt package index"
    $SUDO apt-get update
    APT_UPDATED=1
  fi
}

install_apt_package() {
  local package_name="$1"
  if dpkg -s "$package_name" >/dev/null 2>&1; then
    return 0
  fi
  apt_update_once
  $SUDO apt-get install -y "$package_name"
}

install_apt_package_optional() {
  local package_name="$1"
  if dpkg -s "$package_name" >/dev/null 2>&1; then
    return 0
  fi
  apt_update_once
  if $SUDO apt-get install -y "$package_name"; then
    return 0
  fi
  return 1
}

ensure_systemd_environment() {
  if ! command_exists systemctl; then
    die "This installer requires a systemd-based host. Minimal Docker containers are not supported."
  fi

  if [ ! -d /run/systemd/system ]; then
    die "This installer requires a running systemd init system. This environment does not appear to be booted with systemd."
  fi

  if ! systemctl list-unit-files >/dev/null 2>&1; then
    die "This installer requires a working systemd environment. Test it on a real host, VM, or a container booted with systemd."
  fi
}

ensure_base_tools() {
  if ! command_exists curl; then
    die "curl is required to run the installer."
  fi
  ensure_systemd_environment
  if ! command_exists python3; then
    log "Installing python3"
    install_apt_package python3
  fi
  install_apt_package ca-certificates
}

curl_fetch() {
  local url="$1"
  local destination="$2"
  curl -fsSL --retry 3 --connect-timeout 10 "$url" -o "$destination"
}

lookup_env_value() {
  local env_name="$1"
  if [ "${!env_name+x}" = "x" ]; then
    printf '%s' "${!env_name}"
    return 0
  fi
  return 1
}

prompt_text() {
  local env_name="$1"
  local prompt="$2"
  local default_value="$3"
  local secret="${4:-0}"
  local value=""

  if lookup_env_value "$env_name" >/tmp/frameos-installer-value.$$ 2>/dev/null; then
    cat /tmp/frameos-installer-value.$$
    rm -f /tmp/frameos-installer-value.$$
    return 0
  fi

  if ! have_tty; then
    printf '%s' "$default_value"
    return 0
  fi

  if [ -n "$default_value" ]; then
    tty_printf "$prompt [$default_value]: "
  else
    tty_printf "$prompt: "
  fi

  if [ "$secret" = "1" ]; then
    IFS= read -r -s value < /dev/tty || true
    tty_printf $'\n'
  else
    IFS= read -r value < /dev/tty || true
  fi

  if [ -z "$value" ]; then
    value="$default_value"
  fi

  printf '%s' "$value"
}

prompt_yes_no() {
  local env_name="$1"
  local prompt="$2"
  local default_value="$3"
  local value=""

  if lookup_env_value "$env_name" >/tmp/frameos-installer-value.$$ 2>/dev/null; then
    value="$(cat /tmp/frameos-installer-value.$$)"
    rm -f /tmp/frameos-installer-value.$$
  else
    if ! have_tty; then
      value="$default_value"
    else
      tty_printf "$prompt [$default_value]: "
      IFS= read -r value < /dev/tty || true
      if [ -z "$value" ]; then
        value="$default_value"
      fi
    fi
  fi

  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    y|yes|true|1) printf 'true' ;;
    n|no|false|0) printf 'false' ;;
    *)
      die "Invalid yes/no value for $env_name: $value"
      ;;
  esac
}

prompt_required_secret() {
  local env_name="$1"
  local prompt="$2"
  local value=""
  local confirm_value=""

  if lookup_env_value "$env_name" >/tmp/frameos-installer-value.$$ 2>/dev/null; then
    value="$(cat /tmp/frameos-installer-value.$$)"
    rm -f /tmp/frameos-installer-value.$$
    [ -n "$value" ] || die "$env_name cannot be empty."
    printf '%s' "$value"
    return 0
  fi

  if ! have_tty; then
    die "$env_name must be set when the installer has no TTY."
  fi

  while :; do
    tty_printf "$prompt: "
    IFS= read -r -s value < /dev/tty || true
    tty_printf $'\n'
    if [ -z "$value" ]; then
      tty_printf "Value cannot be empty.\n"
      continue
    fi

    tty_printf "Confirm $prompt: "
    IFS= read -r -s confirm_value < /dev/tty || true
    tty_printf $'\n'
    if [ "$value" = "$confirm_value" ]; then
      printf '%s' "$value"
      return 0
    fi

    tty_printf "Values did not match. Try again.\n"
  done
}

validate_positive_int() {
  local field_name="$1"
  local value="$2"
  case "$value" in
    ''|*[!0-9]*)
      die "$field_name must be a positive integer."
      ;;
  esac
  if [ "$value" -le 0 ]; then
    die "$field_name must be greater than zero."
  fi
}

validate_non_negative_int() {
  local field_name="$1"
  local value="$2"
  case "$value" in
    ''|*[!0-9]*)
      die "$field_name must be a non-negative integer."
      ;;
  esac
}

detect_hostname() {
  hostname -f 2>/dev/null || hostname 2>/dev/null || printf 'localhost'
}

detect_framebuffer_size() {
  if [ -r /sys/class/graphics/fb0/virtual_size ]; then
    tr ',' ' ' < /sys/class/graphics/fb0/virtual_size
    return 0
  fi
  printf '%s %s' "$DEFAULT_WIDTH" "$DEFAULT_HEIGHT"
}

detect_target_slug() {
  python3 - <<'PY'
import os
import platform
import re
import sys

os_release = {}
try:
    with open("/etc/os-release", "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os_release[key] = value.strip().strip('"')
except OSError:
    pass

def normalize_distro(value: str) -> str | None:
    value = (value or "").strip().lower()
    if value in {"raspbian", "raspios", "pios"}:
        return "debian"
    if value in {"debian", "ubuntu"}:
        return value
    return None

def normalize_debian_release() -> str | None:
    candidates = [
        os_release.get("VERSION_CODENAME", ""),
        os_release.get("DEBIAN_CODENAME", ""),
        os_release.get("VERSION", ""),
        os_release.get("VERSION_ID", ""),
    ]
    joined = " ".join(candidates).lower()
    if "trixie" in joined or os_release.get("VERSION_ID") == "13":
        return "trixie"
    if "bookworm" in joined or os_release.get("VERSION_ID") == "12":
        return "bookworm"
    if "buster" in joined or os_release.get("VERSION_ID") == "10":
        return "buster"
    return None

def normalize_ubuntu_release() -> str | None:
    joined = " ".join(
        [
            os_release.get("VERSION_ID", ""),
            os_release.get("VERSION_CODENAME", ""),
            os_release.get("UBUNTU_CODENAME", ""),
            os_release.get("VERSION", ""),
        ]
    ).lower()
    if "24.04" in joined or "noble" in joined:
        return "24.04"
    if "22.04" in joined or "jammy" in joined:
        return "22.04"
    return None

def normalize_arch(value: str) -> str | None:
    return {
        "x86_64": "amd64",
        "amd64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
        "armv8": "arm64",
        "armv8l": "armhf",
        "armv7l": "armhf",
        "armv6l": "armhf",
        "armhf": "armhf",
    }.get((value or "").lower())

distro = normalize_distro(os_release.get("ID", ""))
if distro is None:
    sys.exit(1)

if distro == "debian":
    release = normalize_debian_release()
else:
    release = normalize_ubuntu_release()

arch = normalize_arch(platform.machine())

if not release or not arch:
    sys.exit(1)

print(f"{distro}-{release}-{arch}")
PY
}

pick_frameos_version() {
  local manifest_path="$1"
  local requested_version="${2:-}"
  python3 - "$manifest_path" "$requested_version" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], "r", encoding="utf-8"))
requested = (sys.argv[2] or "").strip()
entries = manifest.get("entries") or []
versions = [str(entry.get("version") or "").strip() for entry in entries if entry.get("version")]
if not versions:
    raise SystemExit("No FrameOS versions were published for this target.")
if requested and requested.lower() != "latest":
    if requested not in versions:
        raise SystemExit(f"Requested FrameOS version is not available for this target: {requested}")
    print(requested)
else:
    print(versions[-1])
PY
}

device_lookup() {
  local devices_path="$1"
  local selector="$2"
  python3 - "$devices_path" "$selector" <<'PY'
import json
import sys

devices = json.load(open(sys.argv[1], "r", encoding="utf-8"))
selector = sys.argv[2].strip()
if selector.isdigit():
    index = int(selector) - 1
    if index < 0 or index >= len(devices):
        raise SystemExit("Device selection is out of range.")
    item = devices[index]
else:
    match = next((item for item in devices if item.get("value") == selector), None)
    if match is None:
        raise SystemExit(f"Unknown device: {selector}")
    item = match
print(item["value"])
print(item["label"])
PY
}

select_device() {
  local devices_path="$1"
  local selected=""
  local lookup_output=""

  if lookup_env_value FRAMEOS_DEVICE >/tmp/frameos-installer-device.$$ 2>/dev/null; then
    selected="$(cat /tmp/frameos-installer-device.$$)"
    rm -f /tmp/frameos-installer-device.$$
  else
    if ! have_tty; then
      die "FRAMEOS_DEVICE must be set when the installer has no TTY."
    fi
    tty_printf '\nAvailable displays:\n'
    python3 - "$devices_path" <<'PY' > /dev/tty
import json
import sys

devices = json.load(open(sys.argv[1], "r", encoding="utf-8"))
for index, item in enumerate(devices, start=1):
    print(f"{index:3}. {item['label']} [{item['value']}]")
PY
    tty_printf '\nEnter a number or exact device id: '
    IFS= read -r selected < /dev/tty || true
  fi

  lookup_output="$(device_lookup "$devices_path" "$selected")" || die "$lookup_output"
  DEVICE_VALUE="$(printf '%s\n' "$lookup_output" | sed -n '1p')"
  DEVICE_LABEL="$(printf '%s\n' "$lookup_output" | sed -n '2p')"
}

parse_label_dimensions() {
  python3 - "$1" <<'PY'
import re
import sys

label = sys.argv[1]
match = re.search(r'(\d+)x(\d+)', label)
if match:
    print(match.group(1))
    print(match.group(2))
else:
    print("0")
    print("0")
PY
}

resolve_component_relpath() {
  local metadata_path="$1"
  local version="$2"
  local component_kind="$3"
  local component_key="$4"
  python3 - "$metadata_path" "$version" "$component_kind" "$component_key" <<'PY'
import json
import sys

metadata = json.load(open(sys.argv[1], "r", encoding="utf-8"))
version = sys.argv[2]
component_kind = sys.argv[3]
component_key = sys.argv[4]
components = metadata.get("components") or {}

if component_kind == "frameos":
    component = components.get("frameos")
    if not component:
        raise SystemExit("FrameOS runtime component metadata is missing.")
    print(f"{component['directory']}/{component['basename']}-{version}")
    raise SystemExit(0)

for component in components.values():
    if component.get("driver_id") == component_key:
        print(f"{component['directory']}/{component['basename']}-{version}.so")
        raise SystemExit(0)

raise SystemExit(f"Missing metadata for driver component: {component_key}")
PY
}

lookup_manifest_md5() {
  local manifest_path="$1"
  local relative_path="$2"
  python3 - "$manifest_path" "$relative_path" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], "r", encoding="utf-8"))
target = sys.argv[2]
for artifact in manifest.get("artifacts") or []:
    if artifact.get("path") == target:
        print(artifact.get("md5") or "")
        raise SystemExit(0)
raise SystemExit(f"Missing artifact entry in manifest: {target}")
PY
}

download_checked_artifact() {
  local relative_path="$1"
  local destination="$2"
  local expected_md5=""
  local tmp_file=""
  expected_md5="$(lookup_manifest_md5 "$TARGET_RELEASE_MANIFEST_PATH" "$relative_path")"
  tmp_file="$(mktemp)"
  curl_fetch "${FRAMEOS_BASE_URL}/${TARGET_SLUG}/${relative_path}" "$tmp_file"
  if [ -n "$expected_md5" ]; then
    printf '%s  %s\n' "$expected_md5" "$tmp_file" | md5sum -c >/dev/null
  fi
  install -m 0644 "$tmp_file" "$destination"
  rm -f "$tmp_file"
}

download_plain_file() {
  local url="$1"
  local destination="$2"
  curl_fetch "$url" "$destination"
}

required_compiled_drivers() {
  case "$DEVICE_VALUE" in
    web_only)
      ;;
    framebuffer)
      printf '%s\n' "frameBuffer" "evdev"
      ;;
    http.upload)
      printf '%s\n' "httpUpload"
      ;;
    pimoroni.hyperpixel2r)
      printf '%s\n' "inkyHyperPixel2r" "evdev"
      ;;
    pimoroni.inky_impression|pimoroni.inky_impression_7|pimoroni.inky_impression_13)
      printf '%s\n' "inkyPython" "gpioButton"
      ;;
    pimoroni.inky_python)
      printf '%s\n' "inkyPython"
      ;;
    waveshare.*)
      printf '%s\n' "waveshare/${DEVICE_VALUE#waveshare.}"
      ;;
    *)
      die "Unsupported device selection: $DEVICE_VALUE"
      ;;
  esac
}

download_vendor_bundle() {
  local bundle_name="$1"
  local destination_root="$2"
  local base_url="${FRAMEOS_BASE_URL}/vendor/${bundle_name}"
  local bundle_dir="${destination_root}/${bundle_name}"
  mkdir -p "$bundle_dir"

  case "$bundle_name" in
    inkyPython)
      mkdir -p "$bundle_dir/devices"
      download_plain_file "${base_url}/check.py" "${bundle_dir}/check.py"
      download_plain_file "${base_url}/demo.py" "${bundle_dir}/demo.py"
      download_plain_file "${base_url}/requirements.in" "${bundle_dir}/requirements.in"
      download_plain_file "${base_url}/requirements.txt" "${bundle_dir}/requirements.txt"
      download_plain_file "${base_url}/run.py" "${bundle_dir}/run.py"
      download_plain_file "${base_url}/devices/util.py" "${bundle_dir}/devices/util.py"
      ;;
    inkyHyperPixel2r)
      download_plain_file "${base_url}/README.md" "${bundle_dir}/README.md"
      download_plain_file "${base_url}/requirements.in" "${bundle_dir}/requirements.in"
      download_plain_file "${base_url}/requirements.txt" "${bundle_dir}/requirements.txt"
      download_plain_file "${base_url}/turnOn.py" "${bundle_dir}/turnOn.py"
      download_plain_file "${base_url}/turnOff.py" "${bundle_dir}/turnOff.py"
      ;;
    *)
      die "Unknown vendor bundle: $bundle_name"
      ;;
  esac
}

ensure_lgpio_runtime() {
  if [ -f /usr/local/include/lgpio.h ] || [ -f /usr/include/lgpio.h ]; then
    return 0
  fi

  if install_apt_package_optional liblgpio-dev; then
    return 0
  fi

  log "Installing lgpio from published archives"
  local archive_manifest_path=""
  archive_manifest_path="$(mktemp)"
  if curl -fsSL --retry 3 --connect-timeout 10 "${FRAMEOS_ARCHIVE_BASE_URL%/}/prebuilt-deps/manifest.json" -o "$archive_manifest_path"; then
    local archive_info=""
    archive_info="$(python3 - "$archive_manifest_path" "$TARGET_SLUG" <<'PY'
import json
import sys
from urllib.parse import urljoin

manifest = json.load(open(sys.argv[1], "r", encoding="utf-8"))
target = sys.argv[2]
entry = next((item for item in manifest.get("entries") or [] if item.get("target") == target), None)
if not entry:
    raise SystemExit(1)
key = (entry.get("component_keys") or {}).get("lgpio")
if not key:
    raise SystemExit(1)
base = "https://archive.frameos.net/"
print(urljoin(base, key))
print((entry.get("component_md5sums") or {}).get("lgpio", ""))
print((entry.get("versions") or {}).get("lgpio", ""))
PY
)" || archive_info=""
    rm -f "$archive_manifest_path"

    if [ -n "$archive_info" ]; then
      local archive_url archive_md5 archive_version archive_file archive_dir
      archive_url="$(printf '%s\n' "$archive_info" | sed -n '1p')"
      archive_md5="$(printf '%s\n' "$archive_info" | sed -n '2p')"
      archive_version="$(printf '%s\n' "$archive_info" | sed -n '3p')"
      archive_file="$(mktemp)"
      archive_dir="$(mktemp -d)"
      curl_fetch "$archive_url" "$archive_file"
      if [ -n "$archive_md5" ]; then
        printf '%s  %s\n' "$archive_md5" "$archive_file" | md5sum -c >/dev/null
      fi
      tar -xzf "$archive_file" -C "$archive_dir"
      $SUDO mkdir -p /usr/local/include /usr/local/lib
      if [ -d "${archive_dir}/include" ]; then
        $SUDO cp -R "${archive_dir}/include/." /usr/local/include/
      fi
      if [ -d "${archive_dir}/lib" ]; then
        $SUDO cp -R "${archive_dir}/lib/." /usr/local/lib/
      fi
      $SUDO ldconfig
      rm -rf "$archive_dir" "$archive_file"
      log "Installed lgpio ${archive_version:-$DEFAULT_LGPIO_VERSION}"
      return 0
    fi
  else
    rm -f "$archive_manifest_path"
  fi

  log "Falling back to building lgpio from source"
  install_apt_package build-essential
  install_apt_package python3-setuptools
  local source_dir source_archive archive_name
  source_dir="$(mktemp -d)"
  archive_name="${DEFAULT_LGPIO_VERSION}.tar.gz"
  curl_fetch "${FRAMEOS_ARCHIVE_BASE_URL%/}/source/vendor/lgpio-${DEFAULT_LGPIO_VERSION}.tar.gz" "${source_dir}/${archive_name}"
  if [ "$DEFAULT_LGPIO_SHA256" != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]; then
    printf '%s  %s\n' "$DEFAULT_LGPIO_SHA256" "${source_dir}/${archive_name}" | sha256sum -c >/dev/null
  else
    warn "Skipping lgpio source archive SHA verification because no trusted checksum is configured."
  fi
  tar -xzf "${source_dir}/${archive_name}" -C "$source_dir"
  (
    cd "${source_dir}/lg-${DEFAULT_LGPIO_VERSION#v}"
    make
    $SUDO make install
  )
  $SUDO ldconfig
  rm -rf "$source_dir"
}

ensure_driver_runtime_packages() {
  local driver_id=""
  local needs_lgpio="false"
  local needs_evdev="false"

  for driver_id in "${COMPILED_DRIVERS[@]}"; do
    case "$driver_id" in
      evdev)
        needs_evdev="true"
        ;;
      gpioButton|waveshare/*)
        needs_lgpio="true"
        ;;
    esac
  done

  if [ "$needs_evdev" = "true" ]; then
    install_apt_package libevdev-dev
  fi

  if [ "$needs_lgpio" = "true" ]; then
    ensure_lgpio_runtime
  fi
}

ensure_default_asset() {
  mkdir -p "$RELEASE_WORK_DIR/assets"
  download_plain_file "${FRAMEOS_BASE_URL}/assets/default.svg" "${RELEASE_WORK_DIR}/assets/default.svg"
}

install_fonts() {
  local fonts_zip=""
  fonts_zip="$(mktemp)"
  mkdir -p "${TEMP_ROOT}/fonts"
  curl_fetch "$FRAMEOS_FONTS_URL" "$fonts_zip"
  python3 - "$fonts_zip" "${TEMP_ROOT}/fonts" <<'PY'
import os
import sys
import zipfile

zip_path = sys.argv[1]
dest = sys.argv[2]
os.makedirs(dest, exist_ok=True)
with zipfile.ZipFile(zip_path, "r") as archive:
    archive.extractall(dest)
PY
  $SUDO install -d -m 0755 "${ASSETS_DIR}/fonts"
  $SUDO cp -R "${TEMP_ROOT}/fonts/." "${ASSETS_DIR}/fonts/"
  $SUDO chown -R "${RUN_USER}:${RUN_GROUP}" "${ASSETS_DIR}/fonts"
  rm -f "$fonts_zip"
}

write_scenes_payload() {
  python3 - "${RELEASE_WORK_DIR}/scenes.json.gz" <<'PY'
import gzip
import sys

with gzip.open(sys.argv[1], "wb") as handle:
    handle.write(b"[]\n")
PY
}

write_release_info() {
  python3 - "${RELEASE_WORK_DIR}/release.json" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

payload = {
    "version": os.environ["FRAMEOS_VERSION_SELECTED"],
    "target": os.environ["TARGET_SLUG"],
    "device": os.environ["DEVICE_VALUE"],
    "deviceLabel": os.environ["DEVICE_LABEL"],
    "installedAt": datetime.now(timezone.utc).isoformat(),
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
PY
}

write_frame_json() {
  python3 - "${RELEASE_WORK_DIR}/frame.json" <<'PY'
import json
import os
import secrets
import sys

frame_access = os.environ["FRAME_ACCESS"]
frame_access_key = os.environ["FRAME_ACCESS_KEY"] if frame_access != "public" else ""
server_host = os.environ["SERVER_HOST"]
server_api_key = os.environ["SERVER_API_KEY"]
server_send_logs = os.environ["SERVER_SEND_LOGS"].lower() == "true"
device_value = os.environ["DEVICE_VALUE"]

device_config = {}
if device_value == "http.upload":
    upload_url = os.environ["HTTP_UPLOAD_URL"]
    if not upload_url:
        raise SystemExit("HTTP upload mode requires FRAMEOS_HTTP_UPLOAD_URL.")
    device_config["uploadUrl"] = upload_url
    header_name = os.environ["HTTP_UPLOAD_HEADER_NAME"]
    header_value = os.environ["HTTP_UPLOAD_HEADER_VALUE"]
    if header_name:
      device_config["uploadHeaders"] = [{"name": header_name, "value": header_value}]

if device_value == "waveshare.EPD_10in3":
    device_config["vcom"] = float(os.environ["DEVICE_VCOM"])

payload = {
    "name": os.environ["FRAME_NAME"],
    "mode": "rpios",
    "frameHost": os.environ["FRAME_HOST"],
    "framePort": int(os.environ["FRAME_PORT"]),
    "frameAccessKey": frame_access_key,
    "frameAccess": frame_access,
    "frameAdminAuth": {
        "enabled": True,
        "user": os.environ["ADMIN_USER"],
        "pass": os.environ["ADMIN_PASSWORD"],
    },
    "httpsProxy": {
        "enable": False,
        "port": 8443,
        "exposeOnlyPort": False,
        "serverCert": "",
        "serverKey": "",
    },
    "serverHost": server_host or "localhost",
    "serverPort": int(os.environ["SERVER_PORT"]),
    "serverApiKey": server_api_key,
    "serverSendLogs": server_send_logs,
    "width": int(os.environ["FRAME_WIDTH"]),
    "height": int(os.environ["FRAME_HEIGHT"]),
    "device": device_value,
    "deviceConfig": device_config,
    "metricsInterval": float(os.environ["METRICS_INTERVAL"]),
    "debug": False,
    "scalingMode": os.environ["SCALING_MODE"],
    "rotate": int(os.environ["FRAME_ROTATE"]),
    "flip": "",
    "logToFile": "",
    "assetsPath": os.environ["ASSETS_DIR"],
    "saveAssets": True,
    "schedule": {"events": []},
    "gpioButtons": [],
    "palette": {},
    "controlCode": {"enabled": False},
    "network": {
        "networkCheck": True,
        "networkCheckTimeoutSeconds": 30,
        "networkCheckUrl": "https://networkcheck.frameos.net/",
        "wifiHotspot": os.environ["WIFI_HOTSPOT"],
        "wifiHotspotSsid": "FrameOS-Setup",
        "wifiHotspotPassword": "frame1234",
        "wifiHotspotTimeoutSeconds": 300,
    },
    "agent": {
        "agentEnabled": False,
        "agentRunCommands": False,
        "agentSharedSecret": secrets.token_hex(32),
    },
}

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
PY
}

write_service_file() {
  cat > "${RELEASE_WORK_DIR}/frameos.service" <<EOF
[Unit]
Description=FrameOS Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${INSTALL_DIR}/current
Environment=FRAMEOS_CONFIG=${INSTALL_DIR}/current/frame.json
Environment=FRAMEOS_TLS_PROXY_VENDOR_PATH=/srv/frameos/vendor/caddy
ExecStart=${INSTALL_DIR}/current/frameos
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
}

ensure_install_dirs() {
  $SUDO install -d -m 0755 "${INSTALL_DIR}"
  $SUDO install -d -m 0755 "${INSTALL_DIR}/releases"
  $SUDO install -d -m 0755 "${INSTALL_DIR}/state"
  $SUDO install -d -m 0755 "${INSTALL_DIR}/logs"
  $SUDO install -d -m 0755 "${INSTALL_DIR}/build"
  $SUDO install -d -m 0755 "${INSTALL_DIR}/vendor"
  $SUDO install -d -m 0755 "${ASSETS_DIR}"
  $SUDO install -d -m 0755 "${ASSETS_DIR}/fonts"
  $SUDO chown -R "${RUN_USER}:${RUN_GROUP}" "${INSTALL_DIR}"
  $SUDO chown "${RUN_USER}:${RUN_GROUP}" "${ASSETS_DIR}" "${ASSETS_DIR}/fonts"
}

ensure_compat_symlink() {
  if [ "$INSTALL_DIR" = "/srv/frameos" ]; then
    return 0
  fi

  log "Using a non-default install path"
  log "Creating a compatibility link at /srv/frameos because parts of FrameOS still expect that path."
  $SUDO mkdir -p /srv

  if [ -L /srv/frameos ]; then
    local existing_target=""
    existing_target="$(python3 - <<'PY'
import os
print(os.path.abspath(os.path.realpath("/srv/frameos")))
PY
)"
    if [ "$existing_target" != "$INSTALL_DIR" ]; then
      die "/srv/frameos already points somewhere else: $existing_target"
    fi
    return 0
  fi

  if [ -e /srv/frameos ]; then
    die "/srv/frameos already exists. Choose /srv/frameos as the install dir or move that path aside first."
  fi

  $SUDO ln -s "$INSTALL_DIR" /srv/frameos
}

has_existing_install() {
  if [ -e "${INSTALL_DIR}/current" ] || [ -d "${INSTALL_DIR}/releases/${DEFAULT_RELEASE_NAME}" ]; then
    return 0
  fi

  if ls "${INSTALL_DIR}/releases"/release_* >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

existing_install_summary() {
  if [ ! -e "${INSTALL_DIR}/current" ]; then
    return 0
  fi

  python3 - "${INSTALL_DIR}/current/release.json" "${INSTALL_DIR}/current/frame.json" <<'PY'
import json
import sys

def load(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}

release = load(sys.argv[1])
frame = load(sys.argv[2])
parts = []

version = str(release.get("version") or "")
target = str(release.get("target") or "")
device = str(release.get("deviceLabel") or release.get("device") or frame.get("device") or "")
name = str(frame.get("name") or "")

if version:
    parts.append(f"version={version}")
if target:
    parts.append(f"target={target}")
if device:
    parts.append(f"device={device}")
if name:
    parts.append(f"name={name}")

print(", ".join(parts))
PY
}

confirm_existing_install_if_needed() {
  if ! has_existing_install; then
    return 0
  fi

  local summary=""
  summary="$(existing_install_summary || true)"
  if [ -n "$summary" ]; then
    log "Existing install detected: ${summary}"
  else
    log "Existing install detected in ${INSTALL_DIR}"
  fi

  if [ "${FRAMEOS_FORCE:-}" = "1" ] || [ "${FRAMEOS_FORCE:-}" = "true" ] || [ "${FRAMEOS_FORCE:-}" = "yes" ]; then
    return 0
  fi

  local overwrite=""
  overwrite="$(prompt_yes_no FRAMEOS_FORCE "Continue and install a new release into ${INSTALL_DIR}" "n")"
  if [ "$overwrite" != "true" ]; then
    die "Installation cancelled."
  fi
}

choose_release_name() {
  local version_tag=""

  if ! has_existing_install; then
    RELEASE_NAME="$DEFAULT_RELEASE_NAME"
    export RELEASE_NAME
    return 0
  fi

  version_tag="$(printf '%s' "$FRAMEOS_VERSION_SELECTED" | tr -c '[:alnum:]' '_' | sed 's/_*$//')"
  if [ -z "$version_tag" ]; then
    version_tag="unknown"
  fi
  RELEASE_NAME="release_${version_tag}_$(date -u +%Y%m%d%H%M%S)_$$"
  export RELEASE_NAME
}

install_release_tree() {
  local final_release_dir="${INSTALL_DIR}/releases/${RELEASE_NAME}"
  if [ -e "$final_release_dir" ]; then
    die "Release path already exists: ${final_release_dir}"
  fi
  $SUDO mv "$RELEASE_WORK_DIR" "$final_release_dir"
  $SUDO ln -sfn "${INSTALL_DIR}/state" "${final_release_dir}/state"
  $SUDO ln -sfn "$final_release_dir" "${INSTALL_DIR}/current"
  $SUDO chmod 0755 "${final_release_dir}/frameos"
  $SUDO chown -R "${RUN_USER}:${RUN_GROUP}" "$final_release_dir"
}

install_systemd_service() {
  $SUDO install -m 0644 "${INSTALL_DIR}/current/frameos.service" /etc/systemd/system/frameos.service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable frameos.service
}

run_frameos_setup() {
  local setup_output=""
  setup_output="$($SUDO "${INSTALL_DIR}/current/frameos" setup --config "${INSTALL_DIR}/current/frame.json" --json)"
  printf '%s\n' "$setup_output"
}

extract_reboot_required() {
  python3 - <<'PY'
import json
import sys

payload = json.loads(sys.stdin.read())
print("true" if payload.get("rebootRequired") else "false")
PY
}

print_setup_actions() {
  python3 - <<'PY'
import json
import sys

payload = json.loads(sys.stdin.read())
for action in payload.get("actions") or []:
    print(f"- {action}")
PY
}

main() {
  ensure_base_tools

  FRAMEOS_BASE_URL="$(normalize_url_base "$FRAMEOS_BASE_URL")"
  FRAMEOS_ARCHIVE_BASE_URL="$(normalize_url_base "$FRAMEOS_ARCHIVE_BASE_URL")"
  RUN_USER="${FRAMEOS_RUN_USER:-${SUDO_USER:-$(id -un)}}"
  RUN_GROUP="${FRAMEOS_RUN_GROUP:-$(id -gn "$RUN_USER")}"

  TARGET_SLUG="$(detect_target_slug)" || die "Could not detect a supported environment from /etc/os-release and uname -m."
  TEMP_ROOT="$(mktemp -d)"
  trap 'rm -rf "$TEMP_ROOT"' EXIT

  TARGET_METADATA_PATH="${TEMP_ROOT}/metadata.json"
  TARGET_FRAMEOS_MANIFEST_PATH="${TEMP_ROOT}/frameos-manifest.json"
  DEVICES_PATH="${TEMP_ROOT}/devices.json"

  if ! curl -fsSL --retry 3 --connect-timeout 10 "${FRAMEOS_BASE_URL}/${TARGET_SLUG}/metadata.json" -o "$TARGET_METADATA_PATH"; then
    die "This environment is not supported by the published prebuilt bundle: ${TARGET_SLUG}"
  fi

  curl_fetch "${FRAMEOS_BASE_URL}/devices.json" "$DEVICES_PATH"
  curl_fetch "${FRAMEOS_BASE_URL}/${TARGET_SLUG}/frameos/manifest.json" "$TARGET_FRAMEOS_MANIFEST_PATH"

  REQUESTED_VERSION="${FRAMEOS_VERSION:-latest}"
  FRAMEOS_VERSION_SELECTED="$(pick_frameos_version "$TARGET_FRAMEOS_MANIFEST_PATH" "$REQUESTED_VERSION")"
  export TARGET_SLUG FRAMEOS_VERSION_SELECTED
  TARGET_RELEASE_MANIFEST_PATH="${TEMP_ROOT}/manifest.${FRAMEOS_VERSION_SELECTED}.json"
  curl_fetch "${FRAMEOS_BASE_URL}/${TARGET_SLUG}/manifest.${FRAMEOS_VERSION_SELECTED}.json" "$TARGET_RELEASE_MANIFEST_PATH"

  log "Detected target: ${TARGET_SLUG}"
  log "Installing FrameOS version: ${FRAMEOS_VERSION_SELECTED}"
  log

  HOSTNAME_DEFAULT="$(detect_hostname)"
  FRAME_NAME="$(prompt_text FRAMEOS_NAME "Frame name" "$HOSTNAME_DEFAULT")"
  INSTALL_DIR="$(normalize_path "$(prompt_text FRAMEOS_INSTALL_DIR "Install location" "$DEFAULT_INSTALL_DIR")")"
  ASSETS_DIR="$(normalize_path "$(prompt_text FRAMEOS_ASSETS_DIR "Assets path" "$DEFAULT_ASSETS_DIR")")"

  select_device "$DEVICES_PATH"
  export DEVICE_VALUE DEVICE_LABEL

  FRAME_WIDTH="0"
  FRAME_HEIGHT="0"
  DEVICE_VCOM=""
  HTTP_UPLOAD_URL=""
  HTTP_UPLOAD_HEADER_NAME=""
  HTTP_UPLOAD_HEADER_VALUE=""

  case "$DEVICE_VALUE" in
    framebuffer|http.upload|web_only)
      read -r detected_width detected_height <<<"$(detect_framebuffer_size)"
      FRAME_WIDTH="$(prompt_text FRAMEOS_WIDTH "Display width in pixels" "$detected_width")"
      FRAME_HEIGHT="$(prompt_text FRAMEOS_HEIGHT "Display height in pixels" "$detected_height")"
      validate_positive_int "Width" "$FRAME_WIDTH"
      validate_positive_int "Height" "$FRAME_HEIGHT"
      ;;
    waveshare.*)
      local_dims="$(parse_label_dimensions "$DEVICE_LABEL")"
      FRAME_WIDTH="$(printf '%s\n' "$local_dims" | sed -n '1p')"
      FRAME_HEIGHT="$(printf '%s\n' "$local_dims" | sed -n '2p')"
      ;;
  esac

  if [ "$DEVICE_VALUE" = "waveshare.EPD_10in3" ]; then
    DEVICE_VCOM="$(prompt_text FRAMEOS_VCOM "Waveshare 10.3 VCOM" "$DEFAULT_VCOM")"
  fi

  if [ "$DEVICE_VALUE" = "http.upload" ]; then
    HTTP_UPLOAD_URL="$(prompt_text FRAMEOS_HTTP_UPLOAD_URL "HTTP upload URL" "")"
    [ -n "$HTTP_UPLOAD_URL" ] || die "HTTP upload mode requires an upload URL."
    HTTP_UPLOAD_HEADER_NAME="$(prompt_text FRAMEOS_HTTP_UPLOAD_HEADER_NAME "Optional upload header name" "")"
    if [ -n "$HTTP_UPLOAD_HEADER_NAME" ]; then
      HTTP_UPLOAD_HEADER_VALUE="$(prompt_text FRAMEOS_HTTP_UPLOAD_HEADER_VALUE "Optional upload header value" "" 1)"
    fi
  fi

  FRAME_ROTATE="$(prompt_text FRAMEOS_ROTATE "Rotate display (0/90/180/270)" "$DEFAULT_ROTATE")"
  validate_non_negative_int "Rotate" "$FRAME_ROTATE"

  FRAME_HOST="${FRAMEOS_FRAME_HOST:-$HOSTNAME_DEFAULT}"
  FRAME_PORT="${FRAMEOS_FRAME_PORT:-$DEFAULT_FRAME_PORT}"
  validate_positive_int "Frame port" "$FRAME_PORT"

  SERVER_HOST="$(prompt_text FRAMEOS_SERVER_HOST "FrameOS server host (leave blank to skip remote logging/control)" "")"
  SERVER_PORT="$DEFAULT_SERVER_PORT"
  SERVER_API_KEY=""
  SERVER_SEND_LOGS="false"
  if [ -n "$SERVER_HOST" ]; then
    SERVER_PORT="$(prompt_text FRAMEOS_SERVER_PORT "FrameOS server port" "$DEFAULT_SERVER_PORT")"
    validate_positive_int "Server port" "$SERVER_PORT"
    SERVER_API_KEY="$(prompt_text FRAMEOS_SERVER_API_KEY "FrameOS server API key" "" 1)"
    default_send_logs="n"
    if [ -n "$SERVER_API_KEY" ]; then
      default_send_logs="y"
    fi
    SERVER_SEND_LOGS="$(prompt_yes_no FRAMEOS_SERVER_SEND_LOGS "Send logs to the FrameOS server" "$default_send_logs")"
  fi

  FRAME_ACCESS="$(prompt_text FRAMEOS_FRAME_ACCESS "Frame web access mode (public/protected/private)" "$DEFAULT_FRAME_ACCESS")"
  case "$FRAME_ACCESS" in
    public|protected|private)
      ;;
    *)
      die "Frame access mode must be public, protected, or private."
      ;;
  esac

  FRAME_ACCESS_KEY=""
  if [ "$FRAME_ACCESS" != "public" ]; then
    FRAME_ACCESS_KEY="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(20))
PY
)"
  fi

  ADMIN_USER="$(prompt_text FRAMEOS_ADMIN_USER "Frame admin username" "admin")"
  [ -n "$ADMIN_USER" ] || die "Frame admin username cannot be empty."
  ADMIN_PASSWORD="$(prompt_required_secret FRAMEOS_ADMIN_PASSWORD "Frame admin password")"

  SCALING_MODE="$DEFAULT_SCALING_MODE"
  METRICS_INTERVAL="$DEFAULT_METRICS_INTERVAL"
  WIFI_HOTSPOT="$DEFAULT_WIFI_HOTSPOT"

  mapfile -t COMPILED_DRIVERS < <(required_compiled_drivers)
  export FRAME_NAME INSTALL_DIR ASSETS_DIR FRAME_WIDTH FRAME_HEIGHT FRAME_ROTATE FRAME_HOST FRAME_PORT
  export SERVER_HOST SERVER_PORT SERVER_API_KEY SERVER_SEND_LOGS FRAME_ACCESS FRAME_ACCESS_KEY
  export ADMIN_USER ADMIN_PASSWORD
  export DEVICE_VCOM HTTP_UPLOAD_URL HTTP_UPLOAD_HEADER_NAME HTTP_UPLOAD_HEADER_VALUE
  export SCALING_MODE METRICS_INTERVAL WIFI_HOTSPOT

  confirm_existing_install_if_needed
  ensure_install_dirs
  ensure_compat_symlink
  choose_release_name

  RELEASE_WORK_DIR="${TEMP_ROOT}/release"
  mkdir -p "${RELEASE_WORK_DIR}/drivers" "${RELEASE_WORK_DIR}/scenes"

  runtime_relpath="$(resolve_component_relpath "$TARGET_METADATA_PATH" "$FRAMEOS_VERSION_SELECTED" "frameos" "frameos")"
  download_checked_artifact "$runtime_relpath" "${RELEASE_WORK_DIR}/frameos"
  chmod 0755 "${RELEASE_WORK_DIR}/frameos"

  if [ "${#COMPILED_DRIVERS[@]}" -gt 0 ]; then
    log "Downloading compiled drivers"
  fi
  for driver_id in "${COMPILED_DRIVERS[@]}"; do
    driver_relpath="$(resolve_component_relpath "$TARGET_METADATA_PATH" "$FRAMEOS_VERSION_SELECTED" "driver" "$driver_id")"
    download_checked_artifact "$driver_relpath" "${RELEASE_WORK_DIR}/drivers/$(basename "$driver_relpath")"
  done

  ensure_default_asset
  write_scenes_payload
  write_frame_json
  write_release_info
  write_service_file

  if [[ "$DEVICE_VALUE" == pimoroni.inky_* ]] || [ "$DEVICE_VALUE" = "pimoroni.hyperpixel2r" ]; then
    log "Downloading Python vendor files"
    if [[ "$DEVICE_VALUE" == pimoroni.inky_* ]]; then
      download_vendor_bundle "inkyPython" "${TEMP_ROOT}/vendor"
    fi
    if [ "$DEVICE_VALUE" = "pimoroni.hyperpixel2r" ]; then
      download_vendor_bundle "inkyHyperPixel2r" "${TEMP_ROOT}/vendor"
    fi
    $SUDO mkdir -p "${INSTALL_DIR}/vendor"
    $SUDO cp -R "${TEMP_ROOT}/vendor/." "${INSTALL_DIR}/vendor/"
    $SUDO chown -R "${RUN_USER}:${RUN_GROUP}" "${INSTALL_DIR}/vendor"
  fi

  log "Installing shared-library runtime dependencies"
  ensure_driver_runtime_packages

  log "Installing bundled fonts into ${ASSETS_DIR}/fonts"
  install_fonts

  $SUDO systemctl stop frameos.service >/dev/null 2>&1 || true
  install_release_tree
  install_systemd_service

  log "Running frameos setup"
  setup_output="$(run_frameos_setup)"
  reboot_required="$(printf '%s\n' "$setup_output" | extract_reboot_required)"

  if [ "$setup_output" != "{}" ]; then
    log "Setup actions:"
    printf '%s\n' "$setup_output" | print_setup_actions || true
  fi

  if [ "$reboot_required" = "true" ]; then
    reboot_now="$(prompt_yes_no FRAMEOS_REBOOT_NOW "A reboot is required before FrameOS can fully use the configured hardware. Reboot now" "y")"
    if [ "$reboot_now" = "true" ]; then
      log "Rebooting"
      $SUDO reboot
      exit 0
    fi
    log "Reboot required before starting FrameOS."
    log "Run: sudo reboot"
  else
    $SUDO systemctl restart frameos.service
    $SUDO systemctl --no-pager --full status frameos.service || true
  fi

  access_url="http://${FRAME_HOST}:${FRAME_PORT}/"
  if [ "$FRAME_ACCESS" != "public" ] && [ -n "$FRAME_ACCESS_KEY" ]; then
    access_url="${access_url}?k=${FRAME_ACCESS_KEY}"
  fi

  log
  log "FrameOS installed"
  log "Version: ${FRAMEOS_VERSION_SELECTED}"
  log "Target: ${TARGET_SLUG}"
  log "Release: ${RELEASE_NAME}"
  log "Install dir: ${INSTALL_DIR}"
  log "Assets dir: ${ASSETS_DIR}"
  log "Device: ${DEVICE_LABEL}"
  log "Admin user: ${ADMIN_USER}"
  log "Open: ${access_url}"
  if [ "$FRAME_ACCESS" != "public" ] && [ -n "$FRAME_ACCESS_KEY" ]; then
    log "Frame access key: ${FRAME_ACCESS_KEY}"
  fi
  if [ "$reboot_required" = "true" ]; then
    log "A reboot is still required."
  fi
}

main "$@"
