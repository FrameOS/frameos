from __future__ import annotations

import shlex
from typing import Any

from app.models.frame import Frame

DEFAULT_SETUP_JSON_RESET_FILE_PATH = "/boot/frameos-setup.json"
SETUP_JSON_RESET_SERVICE_NAME = "frameos-firstboot-setup.service"
SETUP_JSON_RESET_SCRIPT_NAME = "frameos-setup-reset.sh"
SETUP_JSON_RESET_SERVICE_PATH = f"/etc/systemd/system/{SETUP_JSON_RESET_SERVICE_NAME}"
SETUP_JSON_RESET_SCRIPT_PATH = f"/usr/local/bin/{SETUP_JSON_RESET_SCRIPT_NAME}"


def setup_json_reset_file_path(frame: Frame | Any, *, default_if_missing: bool = False) -> str:
    if getattr(frame, "mode", None) != "buildroot" and not default_if_missing:
        return ""
    buildroot = frame.buildroot if isinstance(getattr(frame, "buildroot", None), dict) else {}
    raw_value = buildroot.get("setupJsonResetFilePath")
    if raw_value is None:
        if default_if_missing or getattr(frame, "mode", None) == "buildroot":
            return DEFAULT_SETUP_JSON_RESET_FILE_PATH
        return ""
    return str(raw_value).strip()


def setup_json_reset_enabled(frame: Frame | Any) -> bool:
    return bool(setup_json_reset_file_path(frame))


def render_setup_json_reset_script(setup_file_path: str) -> str:
    quoted_setup_file_path = shlex.quote(setup_file_path)
    return f"""#!/bin/sh
set -eu

SETUP_FILE={quoted_setup_file_path}

if [ ! -f "$SETUP_FILE" ]; then
  exit 0
fi

setup_status=0
if sudo /srv/frameos/current/frameos setup --with-setup="$SETUP_FILE"; then
  setup_status=0
else
  setup_status=$?
fi

timestamp=$(date +%Y%m%d-%H%M)
case "$SETUP_FILE" in
  *.json.gz) done_suffix=".json.gz" ;;
  *.gz) done_suffix=".gz" ;;
  *) done_suffix=".json" ;;
esac
done_path="$(dirname "$SETUP_FILE")/setup-done-${{timestamp}}${{done_suffix}}"
mv -f "$SETUP_FILE" "$done_path"

if [ "$setup_status" -eq 2 ]; then
  sudo reboot
fi

exit "$setup_status"
"""


def render_setup_json_reset_service(setup_file_path: str, script_path: str = SETUP_JSON_RESET_SCRIPT_PATH) -> str:
    quoted_setup_file_path = shlex.quote(setup_file_path)
    quoted_script_path = shlex.quote(script_path)
    return f"""[Unit]
Description=FrameOS setup JSON reset
DefaultDependencies=no
After=local-fs.target systemd-sysusers.service
Before=frameos.service frameos_agent.service
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
