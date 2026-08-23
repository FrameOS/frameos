"""Post-boot diagnostics snapshot written to the FAT boot partition.

Buildroot images keep journald in RAM and frameos logs on the ext4 data
partition — neither is readable when a user pulls the SD card and puts it in
a laptop. This unit keeps a bounded snapshot file on /boot (FAT, readable
anywhere) continuously refreshed: did frameos start, what did it log, and
what does the network stack look like. It exists to end the guessing game
when a frame comes up with a blank screen and no connectivity.

Refresh cadence: immediately at boot, then every 20 s until uptime reaches
two minutes, then one final refresh and stop. The user never has to guess
how long to wait: within the two-minute window the file is at most 20 s
stale, and after it the final snapshot (labelled as such) sits unchanged
until the next boot. Boot problems show inside that window — the network
check times out at 30 s and the boot hotspot's retries finish well before
two minutes.

Wear/space budget: the file is overwritten in place (staged in tmpfs, one
FAT write per refresh) and every section is size-capped, so it stays under
~256 KB forever and the writes stop entirely two minutes into every boot —
at most ~8 writes per boot.
"""

from __future__ import annotations

import os
from pathlib import Path

POSTBOOT_LOG_SCRIPT_NAME = "frameos-postboot-log.sh"
POSTBOOT_LOG_SCRIPT_PATH = f"/usr/local/bin/{POSTBOOT_LOG_SCRIPT_NAME}"
POSTBOOT_LOG_SERVICE_NAME = "frameos-postboot-log.service"
# "2min" in the name on purpose: this snapshot covers the first two minutes
# after boot, it is not a full or live log. Full logs: /srv/frameos/logs/.
POSTBOOT_LOG_FILE_NAME = "frameos-postboot-2min.log"
BOOT_POSTBOOT_LOG_FILE = f"/boot/{POSTBOOT_LOG_FILE_NAME}"

_POSTBOOT_LOG_SCRIPT = """#!/bin/sh
# FrameOS post-boot diagnostics snapshot.
#
# Refreshes __LOG_NAME__ on the boot partition every __REFRESH_INTERVAL__s
# during the first __STOP_AFTER__s after boot, writes one final snapshot,
# and then stops for good - the boot partition sees no further writes until
# the next boot. Pull the power at any point: within the window the file is
# at most __REFRESH_INTERVAL__s stale, after it the final snapshot is what
# there is to read. It is a bounded SNAPSHOT for reading the SD card on
# another computer - NOT a full log. Full frameos logs are on the ext4
# partition in /srv/frameos/logs/.
set -u

BOOT_DIR="${FRAMEOS_BOOT_DIR:-/boot}"
LOG_FILE="$BOOT_DIR/__LOG_NAME__"
STAGE_FILE="${FRAMEOS_POSTBOOT_STAGE:-/run/frameos-postboot.tmp}"
REFRESH_INTERVAL_SECONDS=__REFRESH_INTERVAL__
STOP_AFTER_SECONDS=__STOP_AFTER__
SECTION_BYTES=49152

uptime_seconds() {
  cut -d. -f1 /proc/uptime 2>/dev/null || echo 0
}

# Everything is staged in $STAGE_FILE (tmpfs) and copied to FAT in one go, so
# the boot partition sees a single write per snapshot.
publish() {
  [ -d "$BOOT_DIR" ] || return 0
  cp "$STAGE_FILE" "$LOG_FILE" 2>/dev/null || return 0
  sync
}

section() {
  printf '\\n===== %s =====\\n' "$1" >> "$STAGE_FILE"
}

# Run a command with its output size-capped; never let a broken tool break
# the snapshot.
grab() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@" 2>&1 | tail -c "$SECTION_BYTES" >> "$STAGE_FILE" || true
  else
    printf '(%s not available)\\n' "$1" >> "$STAGE_FILE"
  fi
}

write_header() {
  {
    printf '%s\\n' "FrameOS post-boot snapshot: $1"
    printf '%s\\n' "Refreshed every ${REFRESH_INTERVAL_SECONDS}s during the first ${STOP_AFTER_SECONDS}s after boot, then final."
    printf '%s\\n' "This is a bounded snapshot, NOT a full log."
    printf '%s\\n' "Full frameos logs: /srv/frameos/logs/ (ext4 data partition)."
    printf 'generated_at=%s uptime_seconds=%s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$(uptime_seconds)"
    printf 'hostname=%s\\n' "$(hostname 2>/dev/null)"
    printf 'current_release=%s\\n' "$(readlink /srv/frameos/current 2>/dev/null)"
    cat /srv/frameos/current/versions.json 2>/dev/null || true
  } > "$STAGE_FILE"
}

write_services() {
  section "services"
  for unit in frameos.service frameos-remote.service wpa_supplicant.service NetworkManager.service; do
    printf '%s: %s\\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null)" >> "$STAGE_FILE"
  done
  grab systemctl --failed --no-pager --plain --no-legend
}

write_network() {
  section "network"
  grab ip addr
  grab ip route
  grab iw dev
  grab iw dev wlan0 link
  if command -v wpa_cli >/dev/null 2>&1; then
    grab wpa_cli -p /var/run/wpa_supplicant -i wlan0 status
  fi
  if command -v rfkill >/dev/null 2>&1; then
    grab rfkill list
  fi
  # The resolver is where a Pi Zero W frame failed while looking connected:
  # udhcpc had set an address and a route, but nothing told systemd-resolved
  # about the DNS servers.
  section "resolver"
  grab ls -l /etc/resolv.conf
  grab cat /etc/resolv.conf
  grab grep '^hosts:' /etc/nsswitch.conf
  if command -v resolvectl >/dev/null 2>&1; then
    grab resolvectl status
  fi
  grab sh -c 'cat /run/frameos/udhcpc-*.lease'
  section "network daemons"
  # busybox ps has no -a/-o flags, so keep this to the lowest common form.
  ps 2>/dev/null | grep -E 'wpa_supplicant|hostapd|udhcpc|dnsmasq|NetworkManager' \\
      | grep -v grep | tail -c "$SECTION_BYTES" >> "$STAGE_FILE" || true
  # The wpa_supplicant config proves what the first-boot mirror wrote, but
  # its secrets must never land on the FAT partition.
  section "wpa_supplicant config (secrets redacted)"
  sed -e 's/^\\([[:space:]]*psk=\\).*/\\1<redacted>/' \\
      -e 's/^\\([[:space:]]*wep_key[0-9]*=\\).*/\\1<redacted>/' \\
      -e 's/^\\([[:space:]]*password=\\).*/\\1<redacted>/' \\
      /etc/wpa_supplicant/wpa_supplicant-wlan0.conf 2>/dev/null \\
      | tail -c "$SECTION_BYTES" >> "$STAGE_FILE" || true
}

write_journal() {
  section "journal: frameos.service (tail)"
  grab journalctl -b -u frameos.service --no-pager -o short-iso
  section "journal: frameos-remote.service (tail)"
  grab journalctl -b -u frameos-remote.service --no-pager -o short-iso
  section "journal: wpa_supplicant.service (tail)"
  grab journalctl -b -u wpa_supplicant.service --no-pager -o short-iso
  section "journal: full boot (tail)"
  grab journalctl -b --no-pager -o short-iso
}

write_frameos_log() {
  section "frameos file log (tail)"
  latest_log="$(ls -1t /srv/frameos/logs/ 2>/dev/null | head -n 1)"
  if [ -n "$latest_log" ]; then
    printf 'file=/srv/frameos/logs/%s\\n' "$latest_log" >> "$STAGE_FILE"
    tail -c "$SECTION_BYTES" "/srv/frameos/logs/$latest_log" >> "$STAGE_FILE" 2>/dev/null || true
  else
    printf '(no files in /srv/frameos/logs/)\\n' >> "$STAGE_FILE"
  fi
}

snapshot() {
  write_header "$1"
  write_services
  write_network
  write_journal
  write_frameos_log
  section "end of snapshot ($1)"
  publish
}

# The first snapshot right away proves the boot reached multi-user even if
# the frame dies moments later; every refresh replaces the file whole.
while [ "$(uptime_seconds)" -lt "$STOP_AFTER_SECONDS" ]; do
  snapshot "at $(uptime_seconds)s uptime (still refreshing)"
  sleep "$REFRESH_INTERVAL_SECONDS"
done

snapshot "final at $(uptime_seconds)s uptime - no further refreshes this boot"
"""

POSTBOOT_LOG_REFRESH_INTERVAL_SECONDS = 20
POSTBOOT_LOG_STOP_AFTER_SECONDS = 120


def render_postboot_log_script() -> str:
    return (
        _POSTBOOT_LOG_SCRIPT
        .replace("__LOG_NAME__", POSTBOOT_LOG_FILE_NAME)
        .replace("__REFRESH_INTERVAL__", str(POSTBOOT_LOG_REFRESH_INTERVAL_SECONDS))
        .replace("__STOP_AFTER__", str(POSTBOOT_LOG_STOP_AFTER_SECONDS))
    )


def render_postboot_log_service(script_path: str = POSTBOOT_LOG_SCRIPT_PATH) -> str:
    # Type=exec on purpose: the script keeps running until the two-minute
    # snapshot is written, and a oneshot would hold multi-user.target hostage
    # for that long.
    return f"""[Unit]
Description=FrameOS post-boot diagnostics snapshot on the boot partition
After=frameos.service frameos-remote.service
RequiresMountsFor=/boot /srv/frameos

[Service]
Type=exec
ExecStart={script_path}

[Install]
WantedBy=multi-user.target
"""


def stage_postboot_log(root: Path) -> None:
    """Stage the snapshot script and unit into a rootfs overlay/patch dir."""
    script_path = root / POSTBOOT_LOG_SCRIPT_PATH.lstrip("/")
    script_path.parent.mkdir(parents=True, exist_ok=True)
    script_path.write_text(render_postboot_log_script(), encoding="utf-8")
    os.chmod(script_path, 0o755)

    systemd_dir = root / "etc" / "systemd" / "system"
    wants_dir = systemd_dir / "multi-user.target.wants"
    wants_dir.mkdir(parents=True, exist_ok=True)
    (systemd_dir / POSTBOOT_LOG_SERVICE_NAME).write_text(render_postboot_log_service(), encoding="utf-8")
    link = wants_dir / POSTBOOT_LOG_SERVICE_NAME
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(f"../{POSTBOOT_LOG_SERVICE_NAME}")


__all__ = [
    "BOOT_POSTBOOT_LOG_FILE",
    "POSTBOOT_LOG_FILE_NAME",
    "POSTBOOT_LOG_SCRIPT_PATH",
    "POSTBOOT_LOG_SERVICE_NAME",
    "render_postboot_log_script",
    "render_postboot_log_service",
    "stage_postboot_log",
]
