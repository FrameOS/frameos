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
# wifi_password, wifi_country, ... Read once on first boot, then shredded.
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


# --- Release-image placeholder for /boot/frameos-setup.bin -------------------
#
# The big sibling of the frameos-cloud.txt placeholder, for SELF-HOSTED
# backend personalization: a backend-managed frame needs the whole
# frameos-setup.json payload (frame.json + scenes — multi-megabyte) plus the
# hostname / WiFi / SSH / root-password boot files, which the 4096-byte cloud
# region cannot hold. Generic release images pre-create this file as an
# all-comments region of exactly SETUP_BLOB_PLACEHOLDER_SIZE bytes; a
# personalizer overwrites the region IN PLACE in the raw .img — no FAT
# metadata changes, no mtools/debugfs, no rebuild — with:
#
#   line 1: the magic (unchanged)
#   line 2: "size=<decimal>" — byte length of the payload that follows
#   payload: a gzipped POSIX tar of the /boot/frameos-* personalization
#            files (busybox `gunzip | tar -x` unpacks it on-device)
#   padding: "#" bytes to exactly SETUP_BLOB_PLACEHOLDER_SIZE
#
# On first boot the script below extracts the allow-listed members into
# /boot, shreds the blob, and lets the existing per-file handlers run —
# display/driver config comes from `frameos setup` itself (drivers.setup
# writes config.txt and requests the reboot), so no boot-partition merge is
# needed. Neither the magic line nor the total size may ever change.
BOOT_SETUP_BLOB_FILE = "/boot/frameos-setup.bin"
SETUP_BLOB_MAGIC = "# FRAMEOS-SETUP-BLOB-V1"
SETUP_BLOB_PLACEHOLDER_SIZE = 8 * 1024 * 1024
# The /boot files a blob may deliver. Extraction copies exactly these names
# out of the archive — a hostile tar cannot plant anything else.
SETUP_BLOB_MEMBERS = (
    "frameos-setup.json",
    "frameos-hostname",
    "frameos-wifi.nmconnection",
    "frameos-authorized_keys",
    "frameos-root-password",
)

_SETUP_BLOB_PLACEHOLDER_HEADER = (
    SETUP_BLOB_MAGIC
    + """
#
# FrameOS first-boot personalization blob. Generic images ship this file as
# a fixed-size all-comments placeholder; a FrameOS backend's "Build SD card"
# flow overwrites the region in place with a size header and a gzipped tar
# of /boot personalization files (frameos-setup.json, frameos-hostname,
# frameos-wifi.nmconnection, frameos-authorized_keys,
# frameos-root-password). It is read once on first boot, applied, and
# zero-overwritten (it may hold WiFi and access secrets). While the second
# line is a comment like this one it is ignored and left in place, so the
# image stays generic.
"""
)


def render_setup_blob_placeholder() -> bytes:
    """The canonical all-comments /boot/frameos-setup.bin placeholder."""
    header = _SETUP_BLOB_PLACEHOLDER_HEADER.encode("ascii")
    remaining = SETUP_BLOB_PLACEHOLDER_SIZE - len(header)
    if remaining < 0:
        raise ValueError("Setup blob placeholder header exceeds the fixed placeholder size")
    full_lines, partial = divmod(remaining, len(CLOUD_CONFIG_PLACEHOLDER_PAD_LINE))
    placeholder = header + CLOUD_CONFIG_PLACEHOLDER_PAD_LINE * full_lines + b"#" * partial
    if len(placeholder) != SETUP_BLOB_PLACEHOLDER_SIZE:
        raise AssertionError("Setup blob placeholder is not exactly SETUP_BLOB_PLACEHOLDER_SIZE bytes")
    return placeholder


def render_setup_blob_region(payload: bytes) -> bytes:
    """A personalized frameos-setup.bin region: magic, size header, payload, padding.

    Raises ValueError when the payload cannot fit — callers fall back to the
    server-side partition-patching path.
    """
    header = (SETUP_BLOB_MAGIC + "\n" + f"size={len(payload)}\n").encode("ascii")
    remaining = SETUP_BLOB_PLACEHOLDER_SIZE - len(header) - len(payload)
    if remaining < 0:
        raise ValueError(
            f"Setup blob payload of {len(payload)} bytes does not fit the "
            f"{SETUP_BLOB_PLACEHOLDER_SIZE}-byte placeholder region"
        )
    region = header + payload + b"#" * remaining
    if len(region) != SETUP_BLOB_PLACEHOLDER_SIZE:
        raise AssertionError("Setup blob region is not exactly SETUP_BLOB_PLACEHOLDER_SIZE bytes")
    return region


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
ROOT_SSH_DIR="${FRAMEOS_ROOT_SSH_DIR:-/root/.ssh}"

SETUP_FILE=__SETUP_FILE_EXPR__
CLOUD_FILE=__CLOUD_FILE_EXPR__
SETUP_BLOB_FILE=__SETUP_BLOB_FILE_EXPR__
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
__WPA_SUPPLICANT_HELPERS__

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

# Has $SETUP_BLOB_FILE been personalized? Generic images ship it as an
# all-comments placeholder; a personalizer rewrites its second line to
# "size=<bytes>". Only the first two lines are read — the payload after them
# is binary.
setup_blob_is_personalized() {
  [ -f "$SETUP_BLOB_FILE" ] || return 1
  sed -n '2p' "$SETUP_BLOB_FILE" | tr -d '\\r' | grep -q '^size=[0-9][0-9]*$'
}

# Unpack the personalization blob: skip the two header lines, gunzip+untar
# the payload into a scratch dir, install only the allow-listed member names
# into their /boot destinations, then shred the blob (it holds the same
# secrets its member files do). The per-file handlers below then treat the
# extracted files exactly like ones staged at image-build time.
handle_setup_blob() {
  echo "Extracting first-boot personalization from $SETUP_BLOB_FILE"
  blob_magic_line="$(head -n 1 "$SETUP_BLOB_FILE" | tr -d '\\r')"
  blob_size_line="$(sed -n '2p' "$SETUP_BLOB_FILE" | tr -d '\\r')"
  blob_payload_size="${blob_size_line#size=}"
  # +2 for the two newlines the header lines end with.
  blob_header_size=$(( ${#blob_magic_line} + ${#blob_size_line} + 2 ))
  blob_extract_dir="${TMPDIR:-/tmp}/frameos-setup-blob.$$"
  rm -rf "$blob_extract_dir"
  mkdir -p "$blob_extract_dir"
  if ! tail -c +$((blob_header_size + 1)) "$SETUP_BLOB_FILE" \\
      | head -c "$blob_payload_size" \\
      | gunzip \\
      | tar -x -C "$blob_extract_dir"; then
    echo "Error: failed to extract the setup blob; leaving it in place for retry"
    rm -rf "$blob_extract_dir"
    return 1
  fi
  for blob_pair in \\
      "frameos-setup.json:$SETUP_FILE" \\
      "frameos-hostname:$HOSTNAME_FILE" \\
      "frameos-wifi.nmconnection:$WIFI_CONNECTION_FILE" \\
      "frameos-authorized_keys:$AUTHORIZED_KEYS_FILE" \\
      "frameos-root-password:$ROOT_PASSWORD_FILE"; do
    blob_member="${blob_pair%%:*}"
    blob_target="${blob_pair#*:}"
    if [ -f "$blob_extract_dir/$blob_member" ]; then
      echo "Setup blob provides $blob_member"
      if ! install -m 600 "$blob_extract_dir/$blob_member" "$blob_target"; then
        echo "Error: failed to install $blob_member from the setup blob"
        rm -rf "$blob_extract_dir"
        return 1
      fi
    fi
  done
  rm -rf "$blob_extract_dir"
  shred_remove_file "$SETUP_BLOB_FILE" || echo "Warning: failed to remove $SETUP_BLOB_FILE"
  return 0
}

handle_cloud_config() {
  echo "Reading cloud personalization from $CLOUD_FILE"
  cloud_url=''
  claim_token=''
  cloud_name=''
  cloud_wifi_ssid=''
  cloud_wifi_password=''
  cloud_wifi_country=''
  cloud_device=''
  cloud_width=''
  cloud_height=''
  cloud_rotate=''
  cloud_vcom=''
  cloud_upload_url=''
  cloud_root_password=''
  cloud_time_zone=''
  cloud_authorized_keys=''
  cloud_recognized=0
  cloud_unknown_keys=''
  cloud_enrolled=0
  cloud_wifi_applied=0
  cloud_display_applied=0
  cloud_root_applied=0
  cloud_hostname_applied=0
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
      # ISO 3166-1 alpha-2 regulatory domain for the radio; anything else is
      # dropped here so no daemon ever sees it.
      wifi_country)
        cloud_wifi_country="$(printf '%s' "$cloud_value" | tr 'a-z' 'A-Z')"
        case "$cloud_wifi_country" in
          [A-Z][A-Z]) ;;
          *)
            echo "Warning: ignoring wifi_country '$cloud_value' (expected a two-letter country code)"
            cloud_wifi_country=''
            ;;
        esac
        cloud_recognized=1 ;;
      device) cloud_device="$cloud_value"; cloud_recognized=1 ;;
      width) cloud_width="$cloud_value"; cloud_recognized=1 ;;
      height) cloud_height="$cloud_value"; cloud_recognized=1 ;;
      rotate) cloud_rotate="$cloud_value"; cloud_recognized=1 ;;
      vcom) cloud_vcom="$cloud_value"; cloud_recognized=1 ;;
      upload_url) cloud_upload_url="$cloud_value"; cloud_recognized=1 ;;
      root_password) cloud_root_password="$cloud_value"; cloud_recognized=1 ;;
      time_zone) cloud_time_zone="$cloud_value"; cloud_recognized=1 ;;
      # Repeatable: one OpenSSH public key per line, for /root/.ssh/authorized_keys.
      authorized_key)
        if [ -n "$cloud_value" ]; then
          cloud_authorized_keys="${cloud_authorized_keys}${cloud_value}
"
        fi
        cloud_recognized=1 ;;
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
      echo "Warning: recognized keys are cloud_url, claim_token, name, wifi_ssid, wifi_password, wifi_country, device, width, height, rotate, vcom, upload_url, root_password, time_zone, authorized_key"
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
__WPA_SUPPLICANT_FROM_CLOUD__
  fi

  # The frame's name doubles as its hostname (slugified like the backend's
  # _hostname_for_frame), so two cloud cards on one network are not both
  # frame.local. Written straight to /etc/hostname — /boot/frameos-hostname
  # is the self-hosted card's channel and is left alone.
  if [ -n "$cloud_name" ]; then
    cloud_hostname="$(printf '%s' "$cloud_name" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//' | cut -c1-63)"
    if [ -n "$cloud_hostname" ] && [ "$cloud_hostname" != "$(cat "$ETC_DIR"/hostname 2>/dev/null)" ]; then
      echo "Setting hostname from cloud personalization: $cloud_hostname"
      if printf '%s\\n' "$cloud_hostname" > "$ETC_DIR"/hostname; then
        hostname "$cloud_hostname" 2>/dev/null || true
        cloud_hostname_applied=1
      else
        echo "Warning: failed to write hostname"
      fi
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
    elif [ -x "$SRV_DIR"/frameos/current/frameos ] && \\
      "$SRV_DIR"/frameos/current/frameos set-display \\
        --frame-json="$cloud_frame_json" --device="$cloud_device" \\
        --width="$cloud_width" --height="$cloud_height" --rotate="$cloud_rotate" \\
        --vcom="$cloud_vcom" --upload-url="$cloud_upload_url"; then
      # The binary patches its own frame.json (Buildroot images ship neither
      # python3 nor jq, so the python fallback below never ran there).
      echo "Applied display device '$cloud_device' to $cloud_frame_json"
      cloud_display_applied=1
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
      # Both the binary and python3 refused (or are missing): invalid values.
      echo "Warning: could not apply display device '$cloud_device'; pick the display in the setup portal instead"
    fi
  fi

  # Same semantics as the /boot/frameos-root-password path above (which runs
  # before this function and therefore cannot be reused for cloud-built
  # images): setting a password also re-enables dropbear password logins.
  # Without this key the image keeps its build-time default — passwordless
  # root on the console, SSH refusing password logins entirely.
  if [ -n "$cloud_root_password" ]; then
    echo "Setting root password from cloud personalization"
    if printf 'root:%s\\n' "$cloud_root_password" | chpasswd; then
      install -d -m 755 "$ETC_DIR"/default
      printf '%s\\n' 'DROPBEAR_ARGS=""' > "$ETC_DIR"/default/dropbear
      if command -v systemctl >/dev/null 2>&1; then
        systemctl try-restart dropbear.service || true
      fi
      cloud_root_applied=1
    else
      echo "Warning: failed to set root password from cloud personalization"
    fi
  fi

  # SSH keys picked in the provider's SD-image builder: the same file the
  # self-hosted /boot/frameos-authorized_keys path installs, written from the
  # personalization instead. Public keys only, so nothing here is secret.
  if [ -n "$cloud_authorized_keys" ]; then
    echo "Installing authorized keys from cloud personalization"
    if install -d -m 700 "$ROOT_SSH_DIR"; then
      if printf '%s' "$cloud_authorized_keys" > "$ROOT_SSH_DIR"/authorized_keys; then
        chmod 600 "$ROOT_SSH_DIR"/authorized_keys
      else
        echo "Warning: failed to write $ROOT_SSH_DIR/authorized_keys"
      fi
    else
      echo "Warning: failed to create $ROOT_SSH_DIR"
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
      FRAMEOS_CLOUD_TIME_ZONE="$cloud_time_zone" FRAMEOS_CLOUD_WIFI_COUNTRY="$cloud_wifi_country" \\
      python3 -c 'import json, os
data = {"claim_token": os.environ["FRAMEOS_CLAIM_TOKEN"], "provider_url": os.environ["FRAMEOS_CLOUD_URL"]}
if os.environ.get("FRAMEOS_CLOUD_NAME"):
    data["name"] = os.environ["FRAMEOS_CLOUD_NAME"]
if os.environ.get("FRAMEOS_CLOUD_TIME_ZONE"):
    data["time_zone"] = os.environ["FRAMEOS_CLOUD_TIME_ZONE"]
if os.environ.get("FRAMEOS_CLOUD_WIFI_COUNTRY"):
    data["wifi_country"] = os.environ["FRAMEOS_CLOUD_WIFI_COUNTRY"]
print(json.dumps(data))' > "$pending_file" 2>/dev/null; then
      :
    else
      # No usable python3 (busybox-only image): hand-rolled JSON with
      # sanitized values.
      json_claim_token="$(json_fallback_sanitize "$claim_token")"
      json_cloud_url="$(json_fallback_sanitize "$cloud_url")"
      json_cloud_name="$(json_fallback_sanitize "$cloud_name")"
      json_cloud_time_zone="$(json_fallback_sanitize "$cloud_time_zone")"
      json_extra=''
      if [ -n "$json_cloud_name" ]; then
        json_extra="$json_extra, \\"name\\": \\"$json_cloud_name\\""
      fi
      if [ -n "$json_cloud_time_zone" ]; then
        json_extra="$json_extra, \\"time_zone\\": \\"$json_cloud_time_zone\\""
      fi
      # Validated above to exactly two ASCII letters: nothing to sanitize.
      if [ -n "$cloud_wifi_country" ]; then
        json_extra="$json_extra, \\"wifi_country\\": \\"$cloud_wifi_country\\""
      fi
      printf '{"claim_token": "%s", "provider_url": "%s"%s}\\n' \\
        "$json_claim_token" "$json_cloud_url" "$json_extra" > "$pending_file"
    fi
    umask "$old_umask"
    chmod 600 "$pending_file"
    # frameos.service runs as the `frameos` user on generic images
    # (docs/buildroot-privileges.md §3); the runtime must be able to read
    # the claim token it is about to redeem. No-op where the user does not
    # exist (backend-personalized root images).
    if grep -q '^frameos:' "$ETC_DIR"/passwd 2>/dev/null; then
      chown frameos:frameos "$pending_file" 2>/dev/null || chown frameos "$pending_file" 2>/dev/null || true
      chown frameos:frameos "$pending_dir" 2>/dev/null || true
    fi
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
  if [ "$cloud_enrolled" -eq 0 ] && [ "$cloud_wifi_applied" -eq 0 ] && [ "$cloud_display_applied" -eq 0 ] && [ "$cloud_root_applied" -eq 0 ]; then
    echo "Warning: nothing was applied from $CLOUD_FILE; leaving it in place instead of shredding it"
    if [ -n "$cloud_unknown_keys" ]; then
      echo "Warning: unrecognized keys:$cloud_unknown_keys"
      echo "Warning: recognized keys are cloud_url, claim_token, name, wifi_ssid, wifi_password, wifi_country, device, width, height, rotate, vcom, upload_url, root_password, time_zone, authorized_key"
    fi
    echo "Warning: fix $CLOUD_FILE and reboot to enroll"
    return 0
  fi

  if [ "$cloud_enrolled" -eq 0 ] && [ -n "$cloud_unknown_keys" ]; then
    # WiFi was applied but the enrollment keys were mistyped: shredding here
    # would destroy the claim token the user meant to type.
    echo "Warning: no cloud enrollment happened; unrecognized keys:$cloud_unknown_keys"
    echo "Warning: recognized keys are cloud_url, claim_token, name, wifi_ssid, wifi_password, wifi_country, device, width, height, rotate, vcom, upload_url, root_password, time_zone, authorized_key"
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
  cloud_root_password=''

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

if setup_blob_is_personalized; then
  if ! handle_setup_blob; then
    return 1
  fi
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
__WPA_SUPPLICANT_FROM_BOOT_KEYFILE__
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

# Nothing to do: no setup JSON, and neither personalization region carries
# real content (generic release images ship both frameos-cloud.txt and
# frameos-setup.bin as untouched all-comments placeholders). Exit before
# run_setup so a placeholder-only image does no work on any boot: no
# "mount -o remount,rw /" (which is never undone), no line appended to the
# log on the FAT boot partition, and no reinstalling /boot/frameos-hostname
# and /boot/frameos-wifi.nmconnection over /etc (which would clobber
# on-device edits every boot).
if [ ! -f "$SETUP_FILE" ] && ! cloud_config_has_key_lines && ! setup_blob_is_personalized; then
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


# --- wpa_supplicant mirror for images without NetworkManager -----------------
#
# The armv6 (Pi Zero W) image has no NetworkManager: its Kconfig dependencies do
# not resolve on ARM1176, so Buildroot drops the package
# (buildroot_platforms.py, uses_network_manager=False) and FrameOS drives
# wpa_supplicant + hostapd there instead. A .nmconnection keyfile is therefore
# read by absolutely nothing on that image, and a card flashed with Wi-Fi
# credentials came up with no network at all.
#
# On those platforms the first-boot script writes the same credentials a second
# time, in wpa_supplicant form, into /srv/frameos/state/wpa_supplicant — the
# state partition that buildroot_image.py bind-mounts onto /etc/wpa_supplicant,
# which is exactly where frameos/src/frameos/network/supplicant.nim persists and
# reads its own config. NetworkManager platforms are untouched.
#
# POSIX sh only (busybox ash): no bashisms, no arrays, no [[ ]].
_WPA_SUPPLICANT_HELPERS = """
# Mirror of frameos/src/frameos/network/supplicant.nim's config generation.
WPA_SUPPLICANT_STATE_DIR="$SRV_DIR"/frameos/state/wpa_supplicant

# Reverse of nm_keyfile_escape above: doubled backslashes become single ones.
nm_keyfile_unescape() {
  printf '%s' "$1" | sed 's/\\\\\\\\/\\\\/g'
}

# wpa_supplicant quoted string: backslash and double quote are escaped.
wpa_quote_value() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')"
}

# Read one key out of one section of a NetworkManager keyfile.
nm_keyfile_field() {
  tr -d '\\r' < "$1" | awk -v want_section="$2" -v want_key="$3" '
    /^[[:space:]]*\\[/ {
      section = $0
      sub(/^[[:space:]]*\\[/, "", section)
      sub(/\\].*$/, "", section)
      next
    }
    section == want_section {
      pos = index($0, "=")
      if (pos == 0) next
      key = substr($0, 1, pos - 1)
      gsub(/[[:space:]]/, "", key)
      if (key != want_key) next
      value = substr($0, pos + 1)
      sub(/^[[:space:]]+/, "", value)
      print value
      exit
    }
  '
}

write_wpa_supplicant_conf() {
  wpa_ssid="$1"
  wpa_psk="$2"
  # Optional ISO 3166-1 alpha-2 regulatory domain (already validated by the
  # caller). Without it the radio stays in the world domain, where 2.4 GHz
  # channels 12/13 cannot be joined.
  wpa_country="${3:-}"
  if [ -z "$wpa_ssid" ]; then
    echo "Warning: no SSID for the wpa_supplicant configuration; skipping"
    return 1
  fi
  if ! install -d -m 700 "$WPA_SUPPLICANT_STATE_DIR"; then
    echo "Warning: failed to create $WPA_SUPPLICANT_STATE_DIR"
    return 1
  fi
  wpa_conf_file="$WPA_SUPPLICANT_STATE_DIR"/wpa_supplicant-wlan0.conf
  wpa_write_ok=0
  old_umask="$(umask)"
  umask 077
  if {
    printf '%s\\n' '# Generated by FrameOS. Edits are overwritten on the next Wi-Fi setup.'
    # A wpa_supplicant built without CONFIG_CTRL_IFACE rejects the whole config
    # file over an unknown ctrl_interface field, and then the frame has no
    # Wi-Fi at all. wpa_cli's presence is the same signal supplicant.nim uses.
    if command -v wpa_cli >/dev/null 2>&1; then
      printf '%s\\n' 'ctrl_interface=/var/run/wpa_supplicant' 'ctrl_interface_group=0'
    fi
    printf '%s\\n' 'update_config=1'
    case "$wpa_country" in
      [A-Za-z][A-Za-z]) printf 'country=%s\\n' "$(printf '%s' "$wpa_country" | tr 'a-z' 'A-Z')" ;;
    esac
    printf '%s\\n' 'network={'
    printf '    ssid=%s\\n' "$(wpa_quote_value "$wpa_ssid")"
    printf '%s\\n' '    scan_ssid=1'
    if [ -z "$wpa_psk" ]; then
      # Open network: any key management at all makes wpa_supplicant wait
      # forever for a handshake that never comes.
      printf '%s\\n' '    key_mgmt=NONE'
    elif [ "${#wpa_psk}" -eq 64 ] && [ -z "$(printf '%s' "$wpa_psk" | tr -d '0-9a-fA-F')" ]; then
      # A raw PSK has no passphrase to derive SAE from: WPA2 only.
      printf '%s\\n' '    key_mgmt=WPA-PSK'
      printf '    psk=%s\\n' "$(printf '%s' "$wpa_psk" | tr 'A-F' 'a-f')"
    else
      # WPA2-PSK and WPA3-SAE both offered; wpa_supplicant picks whichever
      # the access point advertises (the image builds it with WPA3).
      printf '%s\\n' '    key_mgmt=WPA-PSK SAE'
      printf '%s\\n' '    ieee80211w=1'
      printf '    psk=%s\\n' "$(wpa_quote_value "$wpa_psk")"
    fi
    printf '%s\\n' '}'
  } > "$wpa_conf_file"; then
    wpa_write_ok=1
  fi
  umask "$old_umask"
  wpa_psk=''
  if [ "$wpa_write_ok" -ne 1 ]; then
    echo "Warning: failed to write $wpa_conf_file"
    return 1
  fi
  chmod 600 "$wpa_conf_file" || true
  echo "Wrote wpa_supplicant configuration for '$wpa_ssid' to $wpa_conf_file"
  return 0
}

wpa_supplicant_conf_from_keyfile() {
  wpa_kf_ssid="$(nm_keyfile_unescape "$(nm_keyfile_field "$1" wifi ssid)")"
  if [ -z "$wpa_kf_ssid" ]; then
    wpa_kf_ssid="$(nm_keyfile_unescape "$(nm_keyfile_field "$1" 802-11-wireless ssid)")"
  fi
  wpa_kf_psk="$(nm_keyfile_unescape "$(nm_keyfile_field "$1" wifi-security psk)")"
  if [ -z "$wpa_kf_psk" ]; then
    wpa_kf_psk="$(nm_keyfile_unescape "$(nm_keyfile_field "$1" 802-11-wireless-security psk)")"
  fi
  write_wpa_supplicant_conf "$wpa_kf_ssid" "$wpa_kf_psk"
  wpa_kf_status=$?
  wpa_kf_psk=''
  return "$wpa_kf_status"
}
"""

_WPA_SUPPLICANT_FROM_BOOT_KEYFILE = """  echo "Mirroring the WiFi credentials into wpa_supplicant form (no NetworkManager on this platform)"
  wpa_supplicant_conf_from_keyfile "$WIFI_CONNECTION_FILE" || true"""

_WPA_SUPPLICANT_FROM_CLOUD = """    echo "Mirroring the cloud WiFi credentials into wpa_supplicant form (no NetworkManager on this platform)"
    if write_wpa_supplicant_conf "$cloud_wifi_ssid" "$cloud_wifi_password" "$cloud_wifi_country"; then
      cloud_wifi_applied=1
    fi"""


def render_setup_json_reset_script(setup_file_path: str, uses_network_manager: bool = True) -> str:
    """The first-boot script.

    `uses_network_manager=False` (armv6 / Pi Zero W, see
    buildroot_platforms.py) additionally mirrors every WiFi credential into a
    wpa_supplicant config, because nothing on such an image reads a
    NetworkManager keyfile. The NetworkManager keyfile is still written either
    way, so NetworkManager platforms behave exactly as before.
    """
    replacements = {
        "__WPA_SUPPLICANT_HELPERS__": "" if uses_network_manager else _WPA_SUPPLICANT_HELPERS,
        "__WPA_SUPPLICANT_FROM_BOOT_KEYFILE__": (
            "" if uses_network_manager else _WPA_SUPPLICANT_FROM_BOOT_KEYFILE
        ),
        "__WPA_SUPPLICANT_FROM_CLOUD__": "" if uses_network_manager else _WPA_SUPPLICANT_FROM_CLOUD,
        "__SETUP_FILE_EXPR__": _boot_path_expression(setup_file_path),
        "__CLOUD_FILE_EXPR__": _boot_path_expression(BOOT_CLOUD_CONFIG_FILE),
        "__SETUP_BLOB_FILE_EXPR__": _boot_path_expression(BOOT_SETUP_BLOB_FILE),
        "__LOG_FILE_EXPR__": _boot_path_expression(BOOT_SETUP_RESET_LOG_FILE),
        "__HOSTNAME_FILE_EXPR__": _boot_path_expression(BOOT_HOSTNAME_FILE),
        "__WIFI_CONNECTION_FILE_EXPR__": _boot_path_expression(BOOT_WIFI_CONNECTION_FILE),
        "__AUTHORIZED_KEYS_FILE_EXPR__": _boot_path_expression(BOOT_AUTHORIZED_KEYS_FILE),
        "__ROOT_PASSWORD_FILE_EXPR__": _boot_path_expression(BOOT_ROOT_PASSWORD_FILE),
        "__DEFAULT_CLOUD_PROVIDER_URL__": shlex.quote(DEFAULT_CLOUD_PROVIDER_URL),
    }
    script = _SETUP_RESET_SCRIPT_TEMPLATE
    for placeholder, value in replacements.items():
        if not value:
            # The optional blocks sit on a line of their own; drop the line
            # rather than leaving a blank one behind.
            script = script.replace(placeholder + "\n", "")
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
