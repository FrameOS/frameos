from __future__ import annotations

import os
import subprocess
from pathlib import Path

from app.tasks.postboot_log import (
    POSTBOOT_LOG_FILE_NAME,
    render_postboot_log_script,
    render_postboot_log_service,
    stage_postboot_log,
)


def test_postboot_log_script_is_posix_shell(tmp_path: Path):
    # Runs under busybox ash on the armv6 image; a bashism would break it.
    script_path = tmp_path / "postboot.sh"
    script_path.write_text(render_postboot_log_script(), encoding="utf-8")
    result = subprocess.run(["/bin/sh", "-n", str(script_path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_postboot_log_script_is_bounded_and_redacts_secrets():
    script = render_postboot_log_script()
    # The filename itself must say this is a time-boxed snapshot, not a log.
    assert POSTBOOT_LOG_FILE_NAME == "frameos-postboot-2min.log"
    assert POSTBOOT_LOG_FILE_NAME in script
    assert "NOT a full log" in script
    # Every section is size-capped so the FAT partition can never fill up.
    assert 'tail -c "$SECTION_BYTES"' in script
    # Wi-Fi secrets must never land on the world-readable FAT partition.
    assert "<redacted>" in script
    assert "psk=" in script
    # Content is staged in tmpfs and copied in one go: one FAT write per
    # snapshot, minimal SD wear.
    assert "/run/frameos-postboot.tmp" in script
    # No un-substituted template placeholders.
    assert "__LOG_NAME__" not in script
    assert "__REFRESH_INTERVAL__" not in script
    assert "__STOP_AFTER__" not in script


def test_postboot_log_script_refreshes_then_stops():
    script = render_postboot_log_script()
    # The user must never have to guess how long to wait: the file refreshes
    # every 20 s during the first two minutes...
    assert "REFRESH_INTERVAL_SECONDS=20" in script
    assert "STOP_AFTER_SECONDS=120" in script
    assert "still refreshing" in script
    # ...and then the writes stop for good, so the boot partition sees a
    # bounded number of writes per boot.
    assert "final at" in script
    assert "no further refreshes this boot" in script
    # Snapshots label their own freshness in the header.
    assert 'Refreshed every ${REFRESH_INTERVAL_SECONDS}s' in script


def test_postboot_log_redaction_pattern_works(tmp_path: Path):
    conf = tmp_path / "wpa_supplicant-wlan0.conf"
    conf.write_text(
        'ctrl_interface=/var/run/wpa_supplicant\nnetwork={\n    ssid="Zebox"\n    psk="super-secret"\n}\n',
        encoding="utf-8",
    )
    redacted = subprocess.run(
        [
            "sed",
            "-e",
            r"s/^\([[:space:]]*psk=\).*/\1<redacted>/",
            str(conf),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "super-secret" not in redacted
    assert "psk=<redacted>" in redacted
    assert 'ssid="Zebox"' in redacted


def test_postboot_log_service_does_not_block_boot():
    service = render_postboot_log_service()
    # A oneshot would hold multi-user.target hostage for the whole two-minute
    # capture window; the unit must run alongside boot, not gate it.
    assert "Type=exec" in service
    assert "Type=oneshot" not in service
    assert "WantedBy=multi-user.target" in service
    assert "RequiresMountsFor=/boot /srv/frameos" in service


def test_postboot_log_staging(tmp_path: Path):
    stage_postboot_log(tmp_path)

    script = tmp_path / "usr" / "local" / "bin" / "frameos-postboot-log.sh"
    unit = tmp_path / "etc" / "systemd" / "system" / "frameos-postboot-log.service"
    link = tmp_path / "etc" / "systemd" / "system" / "multi-user.target.wants" / "frameos-postboot-log.service"

    assert script.is_file()
    assert os.access(script, os.X_OK)
    assert "frameos-postboot-2min.log" in script.read_text(encoding="utf-8")
    assert unit.is_file()
    assert link.is_symlink()
    assert os.readlink(link) == "../frameos-postboot-log.service"

    # Re-staging must be idempotent (the compose path can run repeatedly).
    stage_postboot_log(tmp_path)
    assert link.is_symlink()
