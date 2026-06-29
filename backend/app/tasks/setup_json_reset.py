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


def setup_json_reset_file_path(frame: Frame | Any, *, default_if_missing: bool = False) -> str:
    if getattr(frame, "mode", None) != "buildroot" and not default_if_missing:
        return ""
    return DEFAULT_SETUP_JSON_RESET_FILE_PATH


def setup_json_reset_enabled(frame: Frame | Any) -> bool:
    return bool(setup_json_reset_file_path(frame))


def render_setup_json_reset_script(setup_file_path: str) -> str:
    quoted_setup_file_path = shlex.quote(setup_file_path)
    quoted_log_file_path = shlex.quote(BOOT_SETUP_RESET_LOG_FILE)
    return f"""#!/bin/sh
set -eu

SETUP_FILE={quoted_setup_file_path}
LOG_FILE={quoted_log_file_path}
STATUS_FILE=/tmp/frameos-setup-reset.status

request_reboot() {{
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
}}

run_setup() {{
echo "FrameOS first-boot setup started at $(date -Iseconds 2>/dev/null || date)"
echo "Setup file: $SETUP_FILE"
echo "User id: $(id -u)"
echo "Mounts:"
findmnt /boot /srv/frameos 2>/dev/null || mount | grep -E ' /boot | /srv/frameos ' || true
echo "Current release:"
ls -la /srv/frameos /srv/frameos/current 2>/dev/null || true
echo "Remounting root filesystem read-write"
if mount -o remount,rw /; then
  echo "Root filesystem is read-write"
else
  echo "Warning: failed to remount root filesystem read-write"
fi

if [ -f {shlex.quote(BOOT_HOSTNAME_FILE)} ]; then
  echo "Installing hostname from {shlex.quote(BOOT_HOSTNAME_FILE)}"
  if ! install -m 644 {shlex.quote(BOOT_HOSTNAME_FILE)} /etc/hostname; then
    echo "Warning: failed to install hostname"
  fi
fi

if [ -f {shlex.quote(BOOT_WIFI_CONNECTION_FILE)} ]; then
  echo "Installing NetworkManager WiFi connection from {shlex.quote(BOOT_WIFI_CONNECTION_FILE)}"
  if install -d -m 700 /etc/NetworkManager/system-connections; then
    if ! install -m 600 {shlex.quote(BOOT_WIFI_CONNECTION_FILE)} /etc/NetworkManager/system-connections/frameos-wifi.nmconnection; then
      echo "Warning: failed to install NetworkManager WiFi connection"
    fi
  else
    echo "Warning: failed to create NetworkManager connection directory"
  fi
fi

if [ -f {shlex.quote(BOOT_AUTHORIZED_KEYS_FILE)} ]; then
  echo "Installing authorized keys from {shlex.quote(BOOT_AUTHORIZED_KEYS_FILE)}"
  if install -d -m 700 /root/.ssh; then
    if ! install -m 600 {shlex.quote(BOOT_AUTHORIZED_KEYS_FILE)} /root/.ssh/authorized_keys; then
      echo "Warning: failed to install authorized keys"
    fi
  else
    echo "Warning: failed to create /root/.ssh"
  fi
fi

if [ -f {shlex.quote(BOOT_ROOT_PASSWORD_FILE)} ]; then
  echo "Installing root password from {shlex.quote(BOOT_ROOT_PASSWORD_FILE)}"
  root_password="$(cat {shlex.quote(BOOT_ROOT_PASSWORD_FILE)})"
  if [ -n "$root_password" ]; then
    if printf 'root:%s\\n' "$root_password" | chpasswd; then
      install -d -m 755 /etc/default
      printf '%s\\n' 'DROPBEAR_ARGS=""' > /etc/default/dropbear
      rm -f {shlex.quote(BOOT_ROOT_PASSWORD_FILE)}
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

export FRAMEOS_HOME=/srv/frameos/current
export LD_LIBRARY_PATH=/srv/frameos/current/drivers:/srv/frameos/current/scenes:/usr/lib:/usr/local/lib

setup_status=0
echo "Running FrameOS setup"
set +e
if [ "$(id -u)" = "0" ]; then
  /srv/frameos/current/frameos setup --with-setup="$SETUP_FILE"
elif command -v sudo >/dev/null 2>&1; then
  sudo -E /srv/frameos/current/frameos setup --with-setup="$SETUP_FILE"
else
  echo "FrameOS setup requires root, but sudo is not available"
  false
fi
setup_status=$?
set -e

timestamp=$(date +%Y%m%d-%H%M)
case "$SETUP_FILE" in
  *.json.gz) done_suffix=".json.gz" ;;
  *.gz) done_suffix=".gz" ;;
  *) done_suffix=".json" ;;
esac
done_path="$(dirname "$SETUP_FILE")/setup-done-${{timestamp}}${{done_suffix}}"
if [ "$setup_status" -eq 0 ] || [ "$setup_status" -eq 2 ]; then
  echo "FrameOS setup finished with status $setup_status; moving setup file to $done_path"
  if ! mv -f "$SETUP_FILE" "$done_path"; then
    echo "Error: failed to move setup file to $done_path; setup would re-run on every boot"
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
}}

if [ ! -f "$SETUP_FILE" ]; then
  exit 0
fi

# Stream everything to stdout so it reaches the boot console and journal
# (the service runs with StandardOutput=journal+console), while tee keeps
# the persistent copy on /boot. The pipe hides run_setup's exit status, so
# it is passed out-of-band through a status file.
rm -f "$STATUS_FILE"
{{
  setup_rc=0
  run_setup 2>&1 || setup_rc=$?
  echo "$setup_rc" > "$STATUS_FILE"
}} | tee -a "$LOG_FILE"
exit "$(cat "$STATUS_FILE" 2>/dev/null || echo 1)"
"""


def render_setup_json_reset_service(setup_file_path: str, script_path: str = SETUP_JSON_RESET_SCRIPT_PATH) -> str:
    quoted_setup_file_path = shlex.quote(setup_file_path)
    quoted_script_path = shlex.quote(script_path)
    return f"""[Unit]
Description=FrameOS setup JSON reset
DefaultDependencies=no
After=local-fs.target systemd-sysusers.service
Before=dropbear.service frameos.service frameos-remote.service
RequiresMountsFor=/boot /srv/frameos
ConditionPathExists={quoted_setup_file_path}

[Service]
Type=oneshot
RemainAfterExit=yes
StandardOutput=journal+console
StandardError=journal+console
ExecStart={quoted_script_path}

[Install]
WantedBy=multi-user.target
"""
