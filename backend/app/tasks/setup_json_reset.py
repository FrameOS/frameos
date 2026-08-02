from __future__ import annotations

import shlex
from typing import Any

from app.models.frame import Frame

DEFAULT_SETUP_JSON_RESET_FILE_PATH = "/boot/frameos-setup.json"
SETUP_JSON_RESET_SERVICE_NAME = "frameos-firstboot-setup.service"
SETUP_JSON_RESET_SCRIPT_NAME = "frameos-setup-reset.sh"
SETUP_JSON_RESET_SERVICE_PATH = f"/etc/systemd/system/{SETUP_JSON_RESET_SERVICE_NAME}"
SETUP_JSON_RESET_SCRIPT_PATH = f"/usr/local/bin/{SETUP_JSON_RESET_SCRIPT_NAME}"
BOOT_WIFI_CONNECTION_FILE = "/boot/frameos-wifi.nmconnection"
BOOT_HOSTNAME_FILE = "/boot/frameos-hostname"
BOOT_AUTHORIZED_KEYS_FILE = "/boot/frameos-authorized_keys"
BOOT_ROOT_PASSWORD_FILE = "/boot/frameos-root-password"
BOOT_SETUP_RESET_LOG_FILE = "/boot/frameos-setup-reset.log"
# Cloud-enrollment personalization file (docs/cloud-frames.md, "Provisioning").
# INI-style KEY=value lines: cloud_url, claim_token, name, wifi_ssid,
# wifi_password. Read once on first boot, then shredded.
BOOT_CLOUD_CONFIG_FILE = "/boot/frameos-cloud.txt"
# Handoff target for the FrameOS runtime: written 0600 on first boot when
# /boot/frameos-cloud.txt carried a claim token. Content:
# {"claim_token": "...", "provider_url": "...", "name": "..."} (name optional).
CLOUD_ENROLL_PENDING_FILE = "/srv/frameos/current/state/cloud_enroll_pending.json"
DEFAULT_CLOUD_PROVIDER_URL = "https://cloud.frameos.net"


def setup_json_reset_file_path(frame: Frame | Any, *, default_if_missing: bool = False) -> str:
    if getattr(frame, "mode", None) != "buildroot" and not default_if_missing:
        return ""
    return DEFAULT_SETUP_JSON_RESET_FILE_PATH


def setup_json_reset_enabled(frame: Frame | Any) -> bool:
    return bool(setup_json_reset_file_path(frame))


def _boot_path_expression(path: str) -> str:
    """Shell expression for a path below /boot, honoring $BOOT_DIR overrides."""
    if path.startswith("/boot/"):
        return '"$BOOT_DIR"/' + shlex.quote(path[len("/boot/"):])
    return shlex.quote(path)


# The first-boot script. FRAMEOS_BOOT_DIR / FRAMEOS_SRV_DIR / FRAMEOS_ETC_DIR
# are test-only overrides; production boots use the /boot, /srv, /etc defaults,
# so on-device behavior is identical to spelling the paths out literally.
_SETUP_RESET_SCRIPT_TEMPLATE = """#!/bin/sh
set -eu

BOOT_DIR="${FRAMEOS_BOOT_DIR:-/boot}"
SRV_DIR="${FRAMEOS_SRV_DIR:-/srv}"
ETC_DIR="${FRAMEOS_ETC_DIR:-/etc}"

SETUP_FILE=__SETUP_FILE_EXPR__
CLOUD_FILE=__CLOUD_FILE_EXPR__
LOG_FILE=__LOG_FILE_EXPR__
STATUS_FILE="${TMPDIR:-/tmp}/frameos-setup-reset.status"
HOSTNAME_FILE=__HOSTNAME_FILE_EXPR__
WIFI_CONNECTION_FILE=__WIFI_CONNECTION_FILE_EXPR__
AUTHORIZED_KEYS_FILE=__AUTHORIZED_KEYS_FILE_EXPR__
ROOT_PASSWORD_FILE=__ROOT_PASSWORD_FILE_EXPR__

request_reboot() {
  sync || true
  if [ "$(id -u)" = "0" ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl reboot; then
      return 0
    fi
    if command -v reboot >/dev/null 2>&1 && reboot; then
      return 0
    fi
    if command -v shutdown >/dev/null 2>&1 && shutdown -r now; then
      return 0
    fi
  elif command -v sudo >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1 && sudo systemctl reboot; then
      return 0
    fi
    if command -v reboot >/dev/null 2>&1 && sudo reboot; then
      return 0
    fi
    if command -v shutdown >/dev/null 2>&1 && sudo shutdown -r now; then
      return 0
    fi
  fi
  return 1
}

# Overwrite a file with zeros, then delete it. FAT has no secure delete, so
# on /boot this is best effort, but unlike a rename no plaintext secret stays
# behind in an allocated, readable file.
shred_remove_file() {
  target="$1"
  if [ ! -f "$target" ]; then
    return 0
  fi
  target_size="$(wc -c < "$target" 2>/dev/null | tr -d ' \t' || echo 0)"
  if [ "${target_size:-0}" -gt 0 ] 2>/dev/null; then
    dd if=/dev/zero of="$target" bs=1 count="$target_size" conv=notrunc 2>/dev/null || true
  fi
  sync || true
  rm -f "$target" || true
  sync || true
  [ ! -e "$target" ]
}

# Escape a value for a NetworkManager keyfile (backslashes doubled).
nm_keyfile_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g'
}

# Best-effort JSON string sanitizer for images without python3: strips double
# quotes, backslashes, and control characters. Values containing those
# characters lose them; see tools/buildroot-images/README.md.
json_fallback_sanitize() {
  printf '%s' "$1" | tr -d '"\\\\' | tr -d '[:cntrl:]'
}

handle_cloud_config() {
  echo "Reading cloud personalization from $CLOUD_FILE"
  cloud_url=''
  claim_token=''
  cloud_name=''
  cloud_wifi_ssid=''
  cloud_wifi_password=''
  while IFS= read -r cloud_line || [ -n "$cloud_line" ]; do
    # Tolerate CRLF line endings, comments, and surrounding whitespace.
    cloud_line="$(printf '%s' "$cloud_line" | tr -d '\\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$cloud_line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    cloud_key="$(printf '%s' "${cloud_line%%=*}" | sed 's/[[:space:]]*$//')"
    cloud_value="$(printf '%s' "${cloud_line#*=}" | sed 's/^[[:space:]]*//')"
    case "$cloud_key" in
      cloud_url) cloud_url="$cloud_value" ;;
      claim_token) claim_token="$cloud_value" ;;
      name) cloud_name="$cloud_value" ;;
      wifi_ssid) cloud_wifi_ssid="$cloud_value" ;;
      wifi_password) cloud_wifi_password="$cloud_value" ;;
      *) echo "Ignoring unknown key '$cloud_key' in $CLOUD_FILE" ;;
    esac
  done < "$CLOUD_FILE"

  if [ -n "$cloud_wifi_ssid" ]; then
    echo "Installing NetworkManager WiFi connection from cloud personalization"
    if install -d -m 700 "$ETC_DIR"/NetworkManager/system-connections; then
      cloud_wifi_file="$ETC_DIR"/NetworkManager/system-connections/frameos-cloud-wifi.nmconnection
      old_umask="$(umask)"
      umask 077
      if {
        printf '%s\\n' '[connection]' 'id=frameos-cloud-wifi' 'type=wifi' 'autoconnect=true' ''
        printf '%s\\n' '[wifi]' 'mode=infrastructure'
        printf 'ssid=%s\\n\\n' "$(nm_keyfile_escape "$cloud_wifi_ssid")"
        printf '%s\\n' '[wifi-security]' 'key-mgmt=wpa-psk'
        printf 'psk=%s\\n\\n' "$(nm_keyfile_escape "$cloud_wifi_password")"
        printf '%s\\n' '[ipv4]' 'method=auto' '' '[ipv6]' 'method=auto'
      } > "$cloud_wifi_file"; then
        chmod 600 "$cloud_wifi_file" || true
      else
        echo "Warning: failed to write cloud WiFi connection"
      fi
      umask "$old_umask"
    else
      echo "Warning: failed to create NetworkManager connection directory"
    fi
  fi

  if [ -z "$claim_token" ]; then
    echo "Warning: no claim_token in $CLOUD_FILE; skipping cloud enrollment state"
  else
    if [ -z "$cloud_url" ]; then
      cloud_url=__DEFAULT_CLOUD_PROVIDER_URL__
      echo "No cloud_url in $CLOUD_FILE; defaulting to $cloud_url"
    fi
    pending_dir="$SRV_DIR"/frameos/current/state
    mkdir -p "$pending_dir" 2>/dev/null || true
    if [ ! -d "$pending_dir" ]; then
      # current/state may be a dangling symlink before the first release is
      # staged; fall back to the shared state directory it points at.
      pending_dir="$SRV_DIR"/frameos/state
      mkdir -p "$pending_dir"
    fi
    chmod 700 "$pending_dir" 2>/dev/null || true
    pending_file="$pending_dir"/cloud_enroll_pending.json
    old_umask="$(umask)"
    umask 077
    if command -v python3 >/dev/null 2>&1 && \\
      FRAMEOS_CLOUD_URL="$cloud_url" FRAMEOS_CLAIM_TOKEN="$claim_token" FRAMEOS_CLOUD_NAME="$cloud_name" \\
      python3 -c 'import json, os
data = {"claim_token": os.environ["FRAMEOS_CLAIM_TOKEN"], "provider_url": os.environ["FRAMEOS_CLOUD_URL"]}
if os.environ.get("FRAMEOS_CLOUD_NAME"):
    data["name"] = os.environ["FRAMEOS_CLOUD_NAME"]
print(json.dumps(data))' > "$pending_file" 2>/dev/null; then
      :
    else
      # No usable python3 (busybox-only image): hand-rolled JSON with
      # sanitized values.
      json_claim_token="$(json_fallback_sanitize "$claim_token")"
      json_cloud_url="$(json_fallback_sanitize "$cloud_url")"
      json_cloud_name="$(json_fallback_sanitize "$cloud_name")"
      if [ -n "$json_cloud_name" ]; then
        printf '{"claim_token": "%s", "provider_url": "%s", "name": "%s"}\\n' \\
          "$json_claim_token" "$json_cloud_url" "$json_cloud_name" > "$pending_file"
      else
        printf '{"claim_token": "%s", "provider_url": "%s"}\\n' \\
          "$json_claim_token" "$json_cloud_url" > "$pending_file"
      fi
    fi
    umask "$old_umask"
    chmod 600 "$pending_file"
    echo "Wrote cloud enrollment state to $pending_file"
  fi

  # Shred, don't rename: the FAT boot partition is readable by anyone with
  # the card, and the claim token / WiFi password must not linger there.
  echo "Shredding $CLOUD_FILE"
  if ! shred_remove_file "$CLOUD_FILE"; then
    echo "Error: failed to remove $CLOUD_FILE; cloud personalization would re-run on every boot"
    return 1
  fi
  claim_token=''
  cloud_wifi_password=''
  return 0
}

run_setup() {
echo "FrameOS first-boot setup started at $(date -Iseconds 2>/dev/null || date)"
echo "Setup file: $SETUP_FILE"
echo "Cloud personalization file: $CLOUD_FILE"
echo "User id: $(id -u)"
echo "Mounts:"
findmnt "$BOOT_DIR" "$SRV_DIR"/frameos 2>/dev/null || mount | grep -E " $BOOT_DIR | $SRV_DIR/frameos " || true
echo "Current release:"
ls -la "$SRV_DIR"/frameos "$SRV_DIR"/frameos/current 2>/dev/null || true
echo "Remounting root filesystem read-write"
if mount -o remount,rw /; then
  echo "Root filesystem is read-write"
else
  echo "Warning: failed to remount root filesystem read-write"
fi

if [ -f "$HOSTNAME_FILE" ]; then
  echo "Installing hostname from $HOSTNAME_FILE"
  if ! install -m 644 "$HOSTNAME_FILE" "$ETC_DIR"/hostname; then
    echo "Warning: failed to install hostname"
  fi
fi

if [ -f "$WIFI_CONNECTION_FILE" ]; then
  echo "Installing NetworkManager WiFi connection from $WIFI_CONNECTION_FILE"
  if install -d -m 700 "$ETC_DIR"/NetworkManager/system-connections; then
    if ! install -m 600 "$WIFI_CONNECTION_FILE" "$ETC_DIR"/NetworkManager/system-connections/frameos-wifi.nmconnection; then
      echo "Warning: failed to install NetworkManager WiFi connection"
    fi
  else
    echo "Warning: failed to create NetworkManager connection directory"
  fi
fi

if [ -f "$AUTHORIZED_KEYS_FILE" ]; then
  echo "Installing authorized keys from $AUTHORIZED_KEYS_FILE"
  if install -d -m 700 /root/.ssh; then
    if ! install -m 600 "$AUTHORIZED_KEYS_FILE" /root/.ssh/authorized_keys; then
      echo "Warning: failed to install authorized keys"
    fi
  else
    echo "Warning: failed to create /root/.ssh"
  fi
fi

if [ -f "$ROOT_PASSWORD_FILE" ]; then
  echo "Installing root password from $ROOT_PASSWORD_FILE"
  root_password="$(cat "$ROOT_PASSWORD_FILE")"
  if [ -n "$root_password" ]; then
    if printf 'root:%s\\n' "$root_password" | chpasswd; then
      install -d -m 755 "$ETC_DIR"/default
      printf '%s\\n' 'DROPBEAR_ARGS=""' > "$ETC_DIR"/default/dropbear
      shred_remove_file "$ROOT_PASSWORD_FILE" || echo "Warning: failed to remove $ROOT_PASSWORD_FILE"
      if command -v systemctl >/dev/null 2>&1; then
        systemctl try-restart dropbear.service || true
      fi
    else
      echo "Warning: failed to install root password"
    fi
  else
    echo "Warning: root password file is empty"
  fi
fi

if [ -f "$CLOUD_FILE" ]; then
  if ! handle_cloud_config; then
    return 1
  fi
fi

if [ ! -f "$SETUP_FILE" ]; then
  echo "No setup JSON present; first-boot handling finished at $(date -Iseconds 2>/dev/null || date)"
  return 0
fi

export FRAMEOS_HOME="$SRV_DIR"/frameos/current
export LD_LIBRARY_PATH="$SRV_DIR/frameos/current/drivers:$SRV_DIR/frameos/current/scenes:/usr/lib:/usr/local/lib"

setup_status=0
echo "Running FrameOS setup"
set +e
if [ "$(id -u)" = "0" ]; then
  "$SRV_DIR"/frameos/current/frameos setup --with-setup="$SETUP_FILE"
elif command -v sudo >/dev/null 2>&1; then
  sudo -E "$SRV_DIR"/frameos/current/frameos setup --with-setup="$SETUP_FILE"
else
  echo "FrameOS setup requires root, but sudo is not available"
  false
fi
setup_status=$?
set -e

if [ "$setup_status" -eq 0 ] || [ "$setup_status" -eq 2 ]; then
  # Behavior change: the consumed setup JSON used to be renamed to
  # setup-done-<timestamp>.json and left on the world-readable FAT boot
  # partition with its secrets (WiFi credentials, access keys) intact. It is
  # now zero-overwritten and removed; the persistent log file above keeps the
  # debugging trail.
  echo "FrameOS setup finished with status $setup_status; shredding $SETUP_FILE"
  if ! shred_remove_file "$SETUP_FILE"; then
    echo "Error: failed to remove $SETUP_FILE; setup would re-run on every boot"
    return 1
  fi
else
  echo "FrameOS setup failed with status $setup_status; leaving $SETUP_FILE in place for retry"
fi

if [ "$setup_status" -eq 2 ]; then
  echo "FrameOS setup requested reboot"
  if request_reboot; then
    echo "Reboot command accepted"
    echo "FrameOS first-boot setup ended at $(date -Iseconds 2>/dev/null || date) with status 0 (reboot requested)"
    return 0
  fi
  echo "FrameOS setup requested reboot, but no reboot command succeeded"
  return 1
fi

echo "FrameOS first-boot setup ended at $(date -Iseconds 2>/dev/null || date) with status $setup_status"
return "$setup_status"
}

if [ ! -f "$SETUP_FILE" ] && [ ! -f "$CLOUD_FILE" ]; then
  exit 0
fi

# Stream everything to stdout so it reaches the boot console and journal
# (the service runs with StandardOutput=journal+console), while tee keeps
# the persistent copy on /boot. The pipe hides run_setup's exit status, so
# it is passed out-of-band through a status file.
rm -f "$STATUS_FILE"
{
  setup_rc=0
  run_setup 2>&1 || setup_rc=$?
  echo "$setup_rc" > "$STATUS_FILE"
} | tee -a "$LOG_FILE"
exit "$(cat "$STATUS_FILE" 2>/dev/null || echo 1)"
"""


def render_setup_json_reset_script(setup_file_path: str) -> str:
    replacements = {
        "__SETUP_FILE_EXPR__": _boot_path_expression(setup_file_path),
        "__CLOUD_FILE_EXPR__": _boot_path_expression(BOOT_CLOUD_CONFIG_FILE),
        "__LOG_FILE_EXPR__": _boot_path_expression(BOOT_SETUP_RESET_LOG_FILE),
        "__HOSTNAME_FILE_EXPR__": _boot_path_expression(BOOT_HOSTNAME_FILE),
        "__WIFI_CONNECTION_FILE_EXPR__": _boot_path_expression(BOOT_WIFI_CONNECTION_FILE),
        "__AUTHORIZED_KEYS_FILE_EXPR__": _boot_path_expression(BOOT_AUTHORIZED_KEYS_FILE),
        "__ROOT_PASSWORD_FILE_EXPR__": _boot_path_expression(BOOT_ROOT_PASSWORD_FILE),
        "__DEFAULT_CLOUD_PROVIDER_URL__": shlex.quote(DEFAULT_CLOUD_PROVIDER_URL),
    }
    script = _SETUP_RESET_SCRIPT_TEMPLATE
    for placeholder, value in replacements.items():
        script = script.replace(placeholder, value)
    return script


def render_setup_json_reset_service(setup_file_path: str, script_path: str = SETUP_JSON_RESET_SCRIPT_PATH) -> str:
    quoted_setup_file_path = shlex.quote(setup_file_path)
    quoted_cloud_file_path = shlex.quote(BOOT_CLOUD_CONFIG_FILE)
    quoted_script_path = shlex.quote(script_path)
    # ConditionPathExists=| lines OR together: the unit fires when the setup
    # JSON and/or the cloud personalization file is present.
    return f"""[Unit]
Description=FrameOS setup JSON reset
DefaultDependencies=no
After=local-fs.target systemd-sysusers.service
Before=dropbear.service frameos.service frameos-remote.service
RequiresMountsFor=/boot /srv/frameos
ConditionPathExists=|{quoted_setup_file_path}
ConditionPathExists=|{quoted_cloud_file_path}

[Service]
Type=oneshot
RemainAfterExit=yes
StandardOutput=journal+console
StandardError=journal+console
ExecStart={quoted_script_path}

[Install]
WantedBy=multi-user.target
"""
