"""Tests for the generated first-boot setup script and service.

The script is executed for real in a sandbox: FRAMEOS_BOOT_DIR / FRAMEOS_SRV_DIR /
FRAMEOS_ETC_DIR point at temp directories (production defaults stay /boot, /srv,
/etc), a fake `id` reports uid 0, and a fake frameos binary records its argv.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

from app.tasks.setup_json_reset import (
    BOOT_CLOUD_CONFIG_FILE,
    DEFAULT_CLOUD_PROVIDER_URL,
    DEFAULT_SETUP_JSON_RESET_FILE_PATH,
    render_setup_json_reset_script,
    render_setup_json_reset_service,
)


class Sandbox:
    def __init__(self, tmp_path: Path):
        self.root = tmp_path
        self.boot = tmp_path / "boot"
        self.srv = tmp_path / "srv"
        self.etc = tmp_path / "etc"
        self.bin = tmp_path / "bin"
        self.tmp = tmp_path / "tmp"
        for path in (self.boot, self.srv / "frameos" / "state", self.etc, self.bin, self.tmp):
            path.mkdir(parents=True, exist_ok=True)
        self.script = tmp_path / "frameos-setup-reset.sh"
        self.script.write_text(
            render_setup_json_reset_script(DEFAULT_SETUP_JSON_RESET_FILE_PATH),
            encoding="utf-8",
        )
        self.script.chmod(0o755)
        # The script only takes the no-sudo branch when `id -u` returns 0.
        self._write_bin("id", "#!/bin/sh\necho 0\n")

    def _write_bin(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)

    def add_fake_frameos(self, exit_status: int = 0) -> Path:
        current = self.srv / "frameos" / "current"
        current.mkdir(parents=True, exist_ok=True)
        argv_log = self.root / "frameos-argv.log"
        frameos = current / "frameos"
        frameos.write_text(
            f'#!/bin/sh\nprintf \'%s\\n\' "$@" > {argv_log}\nexit {exit_status}\n',
            encoding="utf-8",
        )
        frameos.chmod(0o755)
        return argv_log

    def write_cloud_file(self, content: str) -> Path:
        path = self.boot / "frameos-cloud.txt"
        path.write_text(content, encoding="utf-8")
        return path

    def run(self, *, disable_python3: bool = False) -> subprocess.CompletedProcess:
        if disable_python3:
            self._write_bin("python3", "#!/bin/sh\nexit 1\n")
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{self.bin}:{env.get('PATH', '/usr/bin:/bin')}",
                "FRAMEOS_BOOT_DIR": str(self.boot),
                "FRAMEOS_SRV_DIR": str(self.srv),
                "FRAMEOS_ETC_DIR": str(self.etc),
                "TMPDIR": str(self.tmp),
            }
        )
        return subprocess.run(
            ["/bin/sh", str(self.script)],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    @property
    def pending_file(self) -> Path:
        return self.srv / "frameos" / "current" / "state" / "cloud_enroll_pending.json"

    @property
    def cloud_wifi_file(self) -> Path:
        return self.etc / "NetworkManager" / "system-connections" / "frameos-cloud-wifi.nmconnection"


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_cloud_config_written_to_pending_enroll_state_and_shredded(tmp_path):
    sandbox = Sandbox(tmp_path)
    # CRLF endings, comments, and stray whitespace must all be tolerated.
    cloud_file = sandbox.write_cloud_file(
        "# frameos-cloud.txt — read once on first boot, then shredded\r\n"
        "cloud_url=https://cloud.example.com\r\n"
        "claim_token = FRCT-abc123\r\n"
        "  name = Kitchen frame\r\n"
        "wifi_ssid=Home Network\r\n"
        "wifi_password=hunter=two\r\n"
        "\r\n"
        "unknown_key=ignored\r\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {
        "claim_token": "FRCT-abc123",
        "provider_url": "https://cloud.example.com",
        "name": "Kitchen frame",
    }
    assert _mode(sandbox.pending_file) == 0o600
    assert _mode(sandbox.pending_file.parent) == 0o700
    # Personalization file is gone (shredded, not renamed).
    assert not cloud_file.exists()
    assert not list(sandbox.boot.glob("setup-done-*"))
    # WiFi keyfile mirrors the frameos-wifi handling: autoconnect + wpa-psk.
    wifi = sandbox.cloud_wifi_file.read_text(encoding="utf-8")
    assert "id=frameos-cloud-wifi" in wifi
    assert "autoconnect=true" in wifi
    assert "ssid=Home Network" in wifi
    assert "key-mgmt=wpa-psk" in wifi
    assert "psk=hunter=two" in wifi
    assert _mode(sandbox.cloud_wifi_file) == 0o600
    # The persistent log stays for debugging.
    assert "cloud personalization" in (sandbox.boot / "frameos-setup-reset.log").read_text(encoding="utf-8").lower()


def test_cloud_config_defaults_url_and_omits_optional_fields(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.write_cloud_file("claim_token=FRCT-xyz\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {"claim_token": "FRCT-xyz", "provider_url": DEFAULT_CLOUD_PROVIDER_URL}
    assert not sandbox.cloud_wifi_file.exists()


def test_cloud_config_without_claim_token_still_shreds_file(tmp_path):
    sandbox = Sandbox(tmp_path)
    cloud_file = sandbox.write_cloud_file("wifi_ssid=OnlyWifi\nwifi_password=secret\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not sandbox.pending_file.exists()
    assert not cloud_file.exists()
    assert sandbox.cloud_wifi_file.exists()


def test_cloud_config_fallback_json_writer_sanitizes_values(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.write_cloud_file(
        'cloud_url=https://cloud.example.com\n'
        'claim_token=FRCT-with"quote\\and-backslash\n'
        'name=Fancy "name"\n'
    )

    result = sandbox.run(disable_python3=True)

    assert result.returncode == 0, result.stdout + result.stderr
    # Without python3, quotes/backslashes/control chars are stripped from
    # values (documented restriction) but the output stays valid JSON.
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {
        "claim_token": "FRCT-withquoteand-backslash",
        "provider_url": "https://cloud.example.com",
        "name": "Fancy name",
    }
    assert _mode(sandbox.pending_file) == 0o600


def test_cloud_only_boot_does_not_invoke_frameos_setup(tmp_path):
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos(exit_status=0)
    sandbox.write_cloud_file("claim_token=FRCT-abc\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not argv_log.exists()
    assert sandbox.pending_file.exists()


def test_setup_json_is_shredded_after_successful_setup(tmp_path):
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos(exit_status=0)
    setup_file = sandbox.boot / "frameos-setup.json"
    setup_file.write_text('{"network": {"wifiPassword": "super-secret"}}', encoding="utf-8")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert argv_log.read_text(encoding="utf-8").splitlines() == [
        "setup",
        f"--with-setup={sandbox.boot}/frameos-setup.json",
    ]
    # Shredded and removed — never renamed to setup-done-*.json.
    assert not setup_file.exists()
    assert not list(sandbox.boot.glob("setup-done-*"))
    assert (sandbox.boot / "frameos-setup-reset.log").exists()


def test_setup_json_left_in_place_when_setup_fails(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.add_fake_frameos(exit_status=1)
    setup_file = sandbox.boot / "frameos-setup.json"
    setup_file.write_text("{}", encoding="utf-8")

    result = sandbox.run()

    assert result.returncode == 1
    assert setup_file.exists()


def test_setup_json_and_cloud_file_are_both_processed(tmp_path):
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos(exit_status=0)
    setup_file = sandbox.boot / "frameos-setup.json"
    setup_file.write_text("{}", encoding="utf-8")
    sandbox.write_cloud_file("claim_token=FRCT-both\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert argv_log.exists()
    assert json.loads(sandbox.pending_file.read_text(encoding="utf-8"))["claim_token"] == "FRCT-both"
    assert not setup_file.exists()
    assert not (sandbox.boot / "frameos-cloud.txt").exists()


def test_script_exits_zero_when_nothing_to_do(tmp_path):
    sandbox = Sandbox(tmp_path)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (sandbox.boot / "frameos-setup-reset.log").exists()


def test_service_condition_fires_on_setup_json_or_cloud_file():
    service = render_setup_json_reset_service(DEFAULT_SETUP_JSON_RESET_FILE_PATH)

    # ConditionPathExists=| lines OR together (systemd triggering conditions),
    # so the unit runs when either file is present.
    assert f"ConditionPathExists=|{DEFAULT_SETUP_JSON_RESET_FILE_PATH}" in service
    assert f"ConditionPathExists=|{BOOT_CLOUD_CONFIG_FILE}" in service
    assert BOOT_CLOUD_CONFIG_FILE == "/boot/frameos-cloud.txt"
    # The pending-enroll file must exist before frameos starts.
    assert "Before=dropbear.service frameos.service frameos-remote.service" in service
