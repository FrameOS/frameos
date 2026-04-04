#!/usr/bin/env bash
set -euo pipefail

DEFAULT_INSTALL_DIR="/srv/frameos"
DEFAULT_ASSETS_DIR="/srv/assets"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "This uninstaller needs root or sudo." >&2
    exit 1
  fi
fi

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
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
FrameOS uninstaller

Run with:
  curl -fsSL https://files.frameos.net/uninstall.sh | bash

Optional environment overrides:
  FRAMEOS_INSTALL_DIR
  FRAMEOS_ASSETS_DIR
  FRAMEOS_REMOVE_ASSETS
  FRAMEOS_FORCE
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

normalize_path() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
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
  local value=""

  if lookup_env_value "$env_name" >/tmp/frameos-uninstall-value.$$ 2>/dev/null; then
    cat /tmp/frameos-uninstall-value.$$
    rm -f /tmp/frameos-uninstall-value.$$
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

  IFS= read -r value < /dev/tty || true
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

  if lookup_env_value "$env_name" >/tmp/frameos-uninstall-value.$$ 2>/dev/null; then
    value="$(cat /tmp/frameos-uninstall-value.$$)"
    rm -f /tmp/frameos-uninstall-value.$$
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

ensure_systemd_environment() {
  if ! command_exists systemctl; then
    die "This uninstaller requires a systemd-based host."
  fi
}

detect_install_dir() {
  if [ -f /etc/systemd/system/frameos.service ]; then
    python3 - <<'PY'
import os
import re

service_path = "/etc/systemd/system/frameos.service"
working_directory = ""
try:
    with open(service_path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            match = re.match(r"WorkingDirectory=(.+)", line)
            if match:
                working_directory = match.group(1).strip()
                break
except OSError:
    pass

if working_directory:
    print(os.path.dirname(working_directory))
elif os.path.exists("/srv/frameos"):
    print(os.path.abspath(os.path.realpath("/srv/frameos")))
else:
    print("/srv/frameos")
PY
    return 0
  fi

  if [ -e /srv/frameos ]; then
    python3 - <<'PY'
import os
print(os.path.abspath(os.path.realpath("/srv/frameos")))
PY
    return 0
  fi

  printf '%s' "$DEFAULT_INSTALL_DIR"
}

detect_assets_dir() {
  local frame_json_path=""

  if [ -f "${INSTALL_DIR}/current/frame.json" ]; then
    frame_json_path="${INSTALL_DIR}/current/frame.json"
  elif [ -f /srv/frameos/current/frame.json ]; then
    frame_json_path="/srv/frameos/current/frame.json"
  fi

  if [ -n "$frame_json_path" ]; then
    python3 - "$frame_json_path" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        payload = json.load(handle)
except Exception:
    print("/srv/assets")
    raise SystemExit(0)

print(payload.get("assetsPath") or "/srv/assets")
PY
    return 0
  fi

  printf '%s' "$DEFAULT_ASSETS_DIR"
}

print_summary() {
  log "FrameOS uninstall target"
  log "Install dir: ${INSTALL_DIR}"
  log "Assets dir: ${ASSETS_DIR}"
  log "Remove assets: ${REMOVE_ASSETS}"
}

confirm_uninstall() {
  if [ "${FRAMEOS_FORCE:-}" = "1" ] || [ "${FRAMEOS_FORCE:-}" = "true" ] || [ "${FRAMEOS_FORCE:-}" = "yes" ]; then
    return 0
  fi

  print_summary
  local confirmed=""
  confirmed="$(prompt_yes_no FRAMEOS_FORCE "Remove this FrameOS installation" "n")"
  if [ "$confirmed" != "true" ]; then
    die "Uninstall cancelled."
  fi
}

stop_and_disable_service() {
  if ! systemctl list-unit-files frameos.service >/dev/null 2>&1; then
    return 0
  fi

  log "Stopping frameos.service"
  $SUDO systemctl stop frameos.service >/dev/null 2>&1 || true
  log "Disabling frameos.service"
  $SUDO systemctl disable frameos.service >/dev/null 2>&1 || true
}

remove_service_file() {
  if [ -e /etc/systemd/system/frameos.service ]; then
    log "Removing systemd unit"
    $SUDO rm -f /etc/systemd/system/frameos.service
    $SUDO systemctl daemon-reload
  fi
}

remove_install_dir() {
  if [ -e "$INSTALL_DIR" ]; then
    log "Removing install directory"
    $SUDO rm -rf "$INSTALL_DIR"
  else
    warn "Install directory not found: ${INSTALL_DIR}"
  fi
}

remove_compat_symlink() {
  if [ ! -L /srv/frameos ]; then
    return 0
  fi

  local resolved=""
  resolved="$(python3 - <<'PY'
import os
print(os.path.abspath(os.path.realpath("/srv/frameos")))
PY
)"
  if [ "$resolved" = "$INSTALL_DIR" ]; then
    log "Removing compatibility symlink /srv/frameos"
    $SUDO rm -f /srv/frameos
  fi
}

remove_assets_dir() {
  if [ "$REMOVE_ASSETS" != "true" ]; then
    return 0
  fi

  if [ -e "$ASSETS_DIR" ]; then
    log "Removing assets directory"
    $SUDO rm -rf "$ASSETS_DIR"
  else
    warn "Assets directory not found: ${ASSETS_DIR}"
  fi
}

main() {
  ensure_systemd_environment

  INSTALL_DIR_DEFAULT="$(detect_install_dir)"
  INSTALL_DIR="$(normalize_path "$(prompt_text FRAMEOS_INSTALL_DIR "FrameOS install location" "$INSTALL_DIR_DEFAULT")")"
  ASSETS_DIR_DEFAULT="$(detect_assets_dir)"
  ASSETS_DIR="$(normalize_path "$(prompt_text FRAMEOS_ASSETS_DIR "Assets path" "$ASSETS_DIR_DEFAULT")")"
  REMOVE_ASSETS="$(prompt_yes_no FRAMEOS_REMOVE_ASSETS "Also remove the assets directory" "n")"

  confirm_uninstall
  stop_and_disable_service
  remove_service_file
  remove_install_dir
  remove_compat_symlink
  remove_assets_dir

  log
  log "FrameOS uninstalled"
  log "Removed install dir: ${INSTALL_DIR}"
  if [ "$REMOVE_ASSETS" = "true" ]; then
    log "Removed assets dir: ${ASSETS_DIR}"
  else
    log "Kept assets dir: ${ASSETS_DIR}"
  fi
}

main "$@"
