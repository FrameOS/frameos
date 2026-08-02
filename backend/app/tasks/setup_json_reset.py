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

# --- Release-image placeholder for /boot/frameos-cloud.txt -------------------
#
# Generic release images ship frameos-cloud.txt pre-created as an all-comments
# placeholder of exactly CLOUD_CONFIG_PLACEHOLDER_SIZE bytes whose first line
# is CLOUD_CONFIG_MAGIC. The in-browser "Download SD image" personalizer
# searches the raw .img for that exact byte string, verifies the 4096-byte
# all-comment tail, and overwrites the region in place with real KEY=value
# content padded back to the same size — no FAT metadata changes, no rebuild
# (docs/cloud-frames.md, "Placeholder + in-browser personalization"). Neither
# the magic line nor the total size may ever change.
CLOUD_CONFIG_MAGIC = "# FRAMEOS-CLOUD-CONFIG-V1"
CLOUD_CONFIG_PLACEHOLDER_SIZE = 4096
# Padding is deterministic: repeated lines of 79 "#" + "\n" (80 bytes each),
# then one final run of "#" without a trailing newline to hit the exact size.
CLOUD_CONFIG_PLACEHOLDER_PAD_LINE = b"#" * 79 + b"\n"

_CLOUD_CONFIG_PLACEHOLDER_HEADER = (
    CLOUD_CONFIG_MAGIC
    + """
#
# FrameOS cloud personalization file. To connect this frame to a FrameOS
# cloud provider, replace the comment lines below with KEY=value lines
# (keep the first line of this file intact):
#
#   cloud_url=https://cloud.frameos.net
#   claim_token=FRCT_xxxxxxxxxxxx
#   name=Kitchen frame
#   wifi_ssid=MyNetwork
#   wifi_password=secret
#
# This file is read once on first boot. When it contains real keys it is
# applied, then zero-overwritten and deleted (it may hold WiFi secrets).
# While it contains only comments like these it is ignored and left in
# place, so the image stays generic and the file stays editable.
"""
)


def render_cloud_config_placeholder() -> bytes:
    """The canonical 4096-byte all-comments /boot/frameos-cloud.txt placeholder.

    Byte layout (deterministic):
    - line 1: "# FRAMEOS-CLOUD-CONFIG-V1\\n" (the magic; byte-exact)
    - a fixed block of "# ..." instruction comment lines
    - padding: repeated lines of 79 x "#" + "\\n", then a final partial run of
      "#" with no trailing newline, to exactly 4096 bytes total.
    """
    header = _CLOUD_CONFIG_PLACEHOLDER_HEADER.encode("ascii")
    remaining = CLOUD_CONFIG_PLACEHOLDER_SIZE - len(header)
    if remaining < 0:
        raise ValueError("Cloud config placeholder header exceeds the fixed placeholder size")
    full_lines, partial = divmod(remaining, len(CLOUD_CONFIG_PLACEHOLDER_PAD_LINE))
    placeholder = header + CLOUD_CONFIG_PLACEHOLDER_PAD_LINE * full_lines + b"#" * partial
    if len(placeholder) != CLOUD_CONFIG_PLACEHOLDER_SIZE:
        raise AssertionError("Cloud config placeholder is not exactly 4096 bytes")
    return placeholder


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
    # Block-sized writes, then one final partial block: bs=1 for the whole
    # file is a read+write syscall pair per byte, which visibly stalls a Pi
    # Zero on a multi-megabyte setup JSON (scenes can be embedded). The byte
    # count stays exact and conv=notrunc keeps the file length.
    shred_blocks=$((target_size / 4096))
    shred_tail=$((target_size % 4096))
    if [ "$shred_blocks" -gt 0 ]; then
      dd if=/dev/zero of="$target" bs=4096 count="$shred_blocks" conv=notrunc 2>/dev/null || true
    fi
    if [ "$shred_tail" -gt 0 ]; then
      dd if=/dev/zero of="$target" bs=1 count="$shred_tail" seek="$((shred_blocks * 4096))" conv=notrunc 2>/dev/null || true
    fi
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

# Does $CLOUD_FILE hold anything other than comments? Generic release images
# ship it as an all-comments 4096-byte placeholder that stays on /boot
# forever, so this has to be answered *before* any of the first-boot work
# happens — see the bottom gate. Mirrors the parser in handle_cloud_config: a
# line counts when it is not a comment and contains "=".
cloud_config_has_key_lines() {
  [ -f "$CLOUD_FILE" ] || return 1
  tr -d '\\r' < "$CLOUD_FILE" | grep -v '^[[:space:]]*#' | grep -q '='
}

handle_cloud_config() {
  echo "Reading cloud personalization from $CLOUD_FILE"
  cloud_url=''
  claim_token=''
  cloud_name=''
  cloud_wifi_ssid=''
  cloud_wifi_password=''
  cloud_device=''
  cloud_width=''
  cloud_height=''
  cloud_rotate=''
  cloud_vcom=''
  cloud_upload_url=''
  cloud_recognized=0
  cloud_unknown_keys=''
  cloud_enrolled=0
  cloud_wifi_applied=0
  cloud_display_applied=0
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
      cloud_url) cloud_url="$cloud_value"; cloud_recognized=1 ;;
      claim_token) claim_token="$cloud_value"; cloud_recognized=1 ;;
      name) cloud_name="$cloud_value"; cloud_recognized=1 ;;
      wifi_ssid) cloud_wifi_ssid="$cloud_value"; cloud_recognized=1 ;;
      wifi_password) cloud_wifi_password="$cloud_value"; cloud_recognized=1 ;;
      device) cloud_device="$cloud_value"; cloud_recognized=1 ;;
      width) cloud_width="$cloud_value"; cloud_recognized=1 ;;
      height) cloud_height="$cloud_value"; cloud_recognized=1 ;;
      rotate) cloud_rotate="$cloud_value"; cloud_recognized=1 ;;
      vcom) cloud_vcom="$cloud_value"; cloud_recognized=1 ;;
      upload_url) cloud_upload_url="$cloud_value"; cloud_recognized=1 ;;
      *)
        echo "Ignoring unknown key '$cloud_key' in $CLOUD_FILE"
        cloud_unknown_keys="$cloud_unknown_keys $cloud_key"
        ;;
    esac
  done < "$CLOUD_FILE"

  # Release images ship this file as an all-comments 4096-byte placeholder
  # (first line "# FRAMEOS-CLOUD-CONFIG-V1"). A file with zero recognized
  # keys means "not personalized": log, leave the file untouched so it stays
  # editable (manually or by the in-browser image personalizer), write no
  # enrollment state, and exit successfully. The systemd unit's
  # ConditionPathExists keeps firing on every boot while the file exists, but
  # the bottom gate exits before run_setup when the file has no KEY=value
  # lines, so an untouched placeholder costs nothing on later boots. (A
  # typo'd file does reach this branch on every boot, on purpose: it warns
  # until the user fixes it.)
  if [ "$cloud_recognized" -eq 0 ]; then
    if [ -n "$cloud_unknown_keys" ]; then
      # KEY=value lines exist but none is a key we know — almost certainly a
      # typo from a manual edit. Do NOT shred: /boot is mounted root-only
      # (umask=077), so the file cannot leak to other users, and shredding
      # would destroy the user's only copy of what they typed. Warn loudly,
      # keep the file, do not enroll.
      echo "Warning: $CLOUD_FILE has KEY=value lines but no recognized keys; unrecognized:$cloud_unknown_keys"
      echo "Warning: recognized keys are cloud_url, claim_token, name, wifi_ssid, wifi_password"
      echo "Warning: leaving $CLOUD_FILE in place; fix the keys and reboot to enroll"
    else
      echo "No personalization keys in $CLOUD_FILE (placeholder or comments only); leaving it in place"
    fi
    return 0
  fi

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
        # Open network (no wifi_password): omit [wifi-security] entirely.
        # key-mgmt=wpa-psk with an empty psk= is a connection NetworkManager
        # can never activate.
        if [ -n "$cloud_wifi_password" ]; then
          printf '%s\\n' '[wifi-security]' 'key-mgmt=wpa-psk'
          printf 'psk=%s\\n\\n' "$(nm_keyfile_escape "$cloud_wifi_password")"
        fi
        printf '%s\\n' '[ipv4]' 'method=auto' '' '[ipv6]' 'method=auto'
      } > "$cloud_wifi_file"; then
        chmod 600 "$cloud_wifi_file" || true
        cloud_wifi_applied=1
      else
        echo "Warning: failed to write cloud WiFi connection"
      fi
      umask "$old_umask"
    else
      echo "Warning: failed to create NetworkManager connection directory"
    fi
  fi

  # Display driver personalization: the release image ships every compiled
  # driver as a .so, so selecting one is a frame.json edit plus a driver-setup
  # run — no rebuild. Only the device key gates the block; width/height/rotate
  # and deviceConfig values ride along with it. Invalid numbers make the
  # patcher exit nonzero and the frame.json stays untouched — the setup portal
  # remains the fallback.
  if [ -n "$cloud_device" ]; then
    cloud_frame_json="$SRV_DIR"/frameos/current/frame.json
    if [ ! -f "$cloud_frame_json" ]; then
      echo "Warning: $cloud_frame_json missing; cannot apply display device '$cloud_device'"
    elif command -v python3 >/dev/null 2>&1 && \\
      FRAMEOS_FRAME_JSON="$cloud_frame_json" FRAMEOS_CLOUD_DEVICE="$cloud_device" \\
      FRAMEOS_CLOUD_WIDTH="$cloud_width" FRAMEOS_CLOUD_HEIGHT="$cloud_height" \\
      FRAMEOS_CLOUD_ROTATE="$cloud_rotate" FRAMEOS_CLOUD_VCOM="$cloud_vcom" \\
      FRAMEOS_CLOUD_UPLOAD_URL="$cloud_upload_url" \\
      python3 -c 'import json, os, sys
path = os.environ["FRAMEOS_FRAME_JSON"]
with open(path) as handle:
    data = json.load(handle)
data["device"] = os.environ["FRAMEOS_CLOUD_DEVICE"]
def set_int(key, name, allowed=None):
    raw = os.environ.get(name, "")
    if not raw:
        return
    try:
        value = int(raw)
    except ValueError:
        sys.exit("invalid " + name + ": " + raw)
    if allowed is not None and value not in allowed:
        sys.exit("invalid " + name + ": " + raw)
    data[key] = value
set_int("width", "FRAMEOS_CLOUD_WIDTH")
set_int("height", "FRAMEOS_CLOUD_HEIGHT")
set_int("rotate", "FRAMEOS_CLOUD_ROTATE", (0, 90, 180, 270))
config = data.get("deviceConfig") or {}
vcom = os.environ.get("FRAMEOS_CLOUD_VCOM", "")
if vcom:
    try:
        config["vcom"] = float(vcom)
    except ValueError:
        sys.exit("invalid FRAMEOS_CLOUD_VCOM: " + vcom)
upload_url = os.environ.get("FRAMEOS_CLOUD_UPLOAD_URL", "")
if upload_url:
    config["uploadUrl"] = upload_url
data["deviceConfig"] = config
tmp = path + ".cloud-tmp"
with open(tmp, "w") as handle:
    json.dump(data, handle, indent=2)
os.replace(tmp, path)'; then
      echo "Applied display device '$cloud_device' to $cloud_frame_json"
      cloud_display_applied=1
    else
      # Covers both "no python3" (busybox-only image) and invalid values.
      echo "Warning: could not apply display device '$cloud_device'; pick the display in the setup portal instead"
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
    cloud_enrolled=1
    echo "Wrote cloud enrollment state to $pending_file"
  fi

  # Only shred once the secrets have actually been consumed. Enrollment
  # redeems the (single-use) claim token, and a written WiFi keyfile consumes
  # the password — after either there is nothing left to recover. When
  # neither happened, the file is the user's only copy of what they typed
  # (e.g. "claim_tokn=FRCT_..." next to a valid cloud_url: recognized keys
  # exist, but no enrollment), so keep it and say why. /boot is mounted
  # root-only (umask=077), so keeping it does not leak to other users.
  if [ "$cloud_enrolled" -eq 0 ] && [ "$cloud_wifi_applied" -eq 0 ] && [ "$cloud_display_applied" -eq 0 ]; then
    echo "Warning: nothing was applied from $CLOUD_FILE; leaving it in place instead of shredding it"
    if [ -n "$cloud_unknown_keys" ]; then
      echo "Warning: unrecognized keys:$cloud_unknown_keys"
      echo "Warning: recognized keys are cloud_url, claim_token, name, wifi_ssid, wifi_password, device, width, height, rotate, vcom, upload_url"
    fi
    echo "Warning: fix $CLOUD_FILE and reboot to enroll"
    return 0
  fi

  if [ "$cloud_enrolled" -eq 0 ] && [ -n "$cloud_unknown_keys" ]; then
    # WiFi was applied but the enrollment keys were mistyped: shredding here
    # would destroy the claim token the user meant to type.
    echo "Warning: no cloud enrollment happened; unrecognized keys:$cloud_unknown_keys"
    echo "Warning: recognized keys are cloud_url, claim_token, name, wifi_ssid, wifi_password, device, width, height, rotate, vcom, upload_url"
    echo "Warning: leaving $CLOUD_FILE in place; fix the keys and reboot to enroll"
    return 0
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

  # After the shred on purpose: driver setup edits /boot/config.txt and may
  # schedule a reboot, and a reboot must not replay personalization. The
  # binary loads its driver .so from the release dir, hence the exports.
  if [ "$cloud_display_applied" -eq 1 ]; then
    echo "Running driver setup for device '$cloud_device'"
    export FRAMEOS_HOME="$SRV_DIR"/frameos/current
    export LD_LIBRARY_PATH="$SRV_DIR/frameos/current/drivers:$SRV_DIR/frameos/current/scenes:/usr/lib:/usr/local/lib"
    if [ "$(id -u)" = "0" ]; then
      "$SRV_DIR"/frameos/current/frameos driver-setup --reboot-if-required || \\
        echo "Warning: driver setup failed; run it again from the setup portal"
    elif command -v sudo >/dev/null 2>&1; then
      sudo -E "$SRV_DIR"/frameos/current/frameos driver-setup --reboot-if-required || \\
        echo "Warning: driver setup failed; run it again from the setup portal"
    else
      echo "Warning: driver setup requires root, but sudo is not available"
    fi
  fi
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

# Nothing to do: no setup JSON, and either no cloud personalization file at
# all or only the untouched all-comments placeholder that generic release
# images ship. Exit before run_setup so a placeholder-only image does no work
# on any boot: no "mount -o remount,rw /" (which is never undone), no line
# appended to the log on the FAT boot partition, and no reinstalling
# /boot/frameos-hostname and /boot/frameos-wifi.nmconnection over /etc (which
# would clobber on-device edits every boot).
if [ ! -f "$SETUP_FILE" ] && ! cloud_config_has_key_lines; then
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
