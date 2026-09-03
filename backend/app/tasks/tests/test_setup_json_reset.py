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
    CLOUD_CONFIG_MAGIC,
    CLOUD_CONFIG_PLACEHOLDER_PAD_LINE,
    CLOUD_CONFIG_PLACEHOLDER_SIZE,
    DEFAULT_CLOUD_PROVIDER_URL,
    DEFAULT_SETUP_JSON_RESET_FILE_PATH,
    render_cloud_config_placeholder,
    render_setup_json_reset_script,
    render_setup_json_reset_service,
)


class Sandbox:
    def __init__(self, tmp_path: Path, uses_network_manager: bool = True):
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
            render_setup_json_reset_script(
                DEFAULT_SETUP_JSON_RESET_FILE_PATH, uses_network_manager=uses_network_manager
            ),
            encoding="utf-8",
        )
        self.script.chmod(0o755)
        # The script only takes the no-sudo branch when `id -u` returns 0.
        self._write_bin("id", "#!/bin/sh\necho 0\n")
        # Record every `mount` invocation instead of touching the host's real
        # mounts, so tests can assert the read-write remount never happens.
        self.mount_log = tmp_path / "mount.log"
        self._write_bin("mount", f'#!/bin/sh\nprintf \'%s\\n\' "$*" >> {self.mount_log}\nexit 0\n')

    def _write_bin(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)

    def add_fake_frameos(self, exit_status: int = 0, set_display_exit_status: int = 1) -> Path:
        # `set-display` exits 1 by default, like a release binary that predates
        # the subcommand (unknown command → ValueError), so the python3
        # fallback path stays covered; pass 0 to exercise the binary path.
        current = self.srv / "frameos" / "current"
        current.mkdir(parents=True, exist_ok=True)
        argv_log = self.root / "frameos-argv.log"
        frameos = current / "frameos"
        frameos.write_text(
            "#!/bin/sh\n"
            f'printf \'%s\\n\' "$@" >> {argv_log}\n'
            f'printf \'%s\\n\' "$PWD" >> {argv_log.with_name("frameos-cwd.log")}\n'
            f'[ "$1" = set-display ] && exit {set_display_exit_status}\n'
            f"exit {exit_status}\n",
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
                "FRAMEOS_ROOT_SSH_DIR": str(self.root / "root-ssh"),
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

    @property
    def wifi_file(self) -> Path:
        return self.etc / "NetworkManager" / "system-connections" / "frameos-wifi.nmconnection"

    @property
    def wpa_supplicant_file(self) -> Path:
        return self.srv / "frameos" / "state" / "wpa_supplicant" / "wpa_supplicant-wlan0.conf"

    def write_boot_wifi_keyfile(self, content: str) -> Path:
        path = self.boot / "frameos-wifi.nmconnection"
        path.write_text(content, encoding="utf-8")
        return path

    @property
    def log_file(self) -> Path:
        return self.boot / "frameos-setup-reset.log"

    def mount_calls(self) -> str:
        return self.mount_log.read_text(encoding="utf-8") if self.mount_log.exists() else ""

    def shadow_link(self, path: Path) -> Path:
        """A second hard link to `path`, so the inode survives the unlink.

        shred_remove_file zeroes in place (conv=notrunc) and then unlinks; the
        shadow link keeps the inode readable afterwards, which is the only way
        to prove the bytes were actually overwritten and not merely `rm`ed.
        """
        shadow = self.root / f"shadow-{path.name}"
        os.link(path, shadow)
        return shadow


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
    shadow = sandbox.shadow_link(cloud_file)
    original_size = cloud_file.stat().st_size

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
    # Personalization file is gone (shredded, not renamed) — and shredded
    # really means zeroed: the surviving hard link holds no plaintext.
    assert not cloud_file.exists()
    assert shadow.read_bytes() == b"\0" * original_size
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


def test_cloud_enrollment_keeps_the_shared_state_directory_root_owned_and_sticky(tmp_path):
    sandbox = Sandbox(tmp_path)
    (sandbox.etc / "passwd").write_text("root:x:0:0:root:/root:/bin/sh\nframeos:x:990:990::/:/bin/false\n")
    sandbox.write_cloud_file("claim_token=FRCT-state-owner\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert sandbox.pending_file.exists()
    # chown is allowed to fail in this macOS sandbox (there is no frameos
    # account), but chmod proves the account-detected branch ran. On-device
    # the preceding chown keeps this directory root:frameos.
    assert _mode(sandbox.pending_file.parent) == 0o1770


def test_cloud_config_time_zone_rides_the_pending_state_and_name_sets_the_hostname(tmp_path):
    sandbox = Sandbox(tmp_path)
    # A `hostname` on PATH that only records the call: the real one needs
    # root and would rename the developer's machine.
    hostname_log = sandbox.tmp / "hostname-calls"
    (sandbox.bin / "hostname").write_text(f'#!/bin/sh\nprintf \'%s\\n\' "$1" >> "{hostname_log}"\n', encoding="utf-8")
    (sandbox.bin / "hostname").chmod(0o755)
    sandbox.write_cloud_file(
        "cloud_url=https://cloud.example.com\n"
        "claim_token=FRCT-tz\n"
        "name=Kitchen Frame (2nd floor)\n"
        "time_zone=Europe/Brussels\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {
        "claim_token": "FRCT-tz",
        "provider_url": "https://cloud.example.com",
        "name": "Kitchen Frame (2nd floor)",
        "time_zone": "Europe/Brussels",
    }
    # The name becomes the hostname, slugified the way the backend does it,
    # so two cloud cards on one network are not both frame.local.
    assert (sandbox.etc / "hostname").read_text(encoding="utf-8") == "kitchen-frame-2nd-floor\n"
    assert hostname_log.read_text(encoding="utf-8") == "kitchen-frame-2nd-floor\n"

    # Without python3 the fallback writer carries the zone too.
    sandbox.write_cloud_file("claim_token=FRCT-tz2\ntime_zone=Asia/Tokyo\n")
    result = sandbox.run(disable_python3=True)
    assert result.returncode == 0, result.stdout + result.stderr
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {
        "claim_token": "FRCT-tz2",
        "provider_url": DEFAULT_CLOUD_PROVIDER_URL,
        "time_zone": "Asia/Tokyo",
    }


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


def test_cloud_config_display_keys_patch_frame_json_and_run_driver_setup(tmp_path):
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos()
    frame_json = sandbox.srv / "frameos" / "current" / "frame.json"
    frame_json.write_text(
        json.dumps({"device": "framebuffer", "width": 800, "height": 480, "rotate": 0}),
        encoding="utf-8",
    )
    sandbox.write_cloud_file(
        "cloud_url=https://cloud.example.com\n"
        "claim_token=FRCT-abc\n"
        "device=waveshare.EPD_13in3e\n"
        "width=1600\n"
        "height=1200\n"
        "rotate=90\n"
        "vcom=-1.48\n"
        "upload_url=https://frames.example.com/upload\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(frame_json.read_text(encoding="utf-8"))
    assert data["device"] == "waveshare.EPD_13in3e"
    assert data["width"] == 1600
    assert data["height"] == 1200
    assert data["rotate"] == 90
    assert data["deviceConfig"]["vcom"] == -1.48
    assert data["deviceConfig"]["uploadUrl"] == "https://frames.example.com/upload"
    # Driver setup ran (after the shred), with the reboot flag the portal uses.
    argv = argv_log.read_text(encoding="utf-8")
    assert "driver-setup" in argv
    assert "--reboot-if-required" in argv
    # From the release directory: the binary reads ./frame.json from its cwd.
    cwd_log = argv_log.with_name("frameos-cwd.log").read_text(encoding="utf-8").splitlines()
    assert str(sandbox.srv / "frameos" / "current") in cwd_log
    # Enrollment still happened and the secrets are gone from /boot.
    assert sandbox.pending_file.exists()
    assert not (sandbox.boot / "frameos-cloud.txt").exists()


def test_cloud_config_display_prefers_the_frameos_binary_over_python3(tmp_path):
    # Buildroot images have no python3: the binary's own `set-display` patches
    # frame.json. The fake only records argv, so assert the wiring, not the
    # JSON (covered by frameos/src/frameos/tests/test_display_patch.nim).
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos(set_display_exit_status=0)
    frame_json = sandbox.srv / "frameos" / "current" / "frame.json"
    frame_json.write_text(json.dumps({"device": "framebuffer"}), encoding="utf-8")
    sandbox.write_cloud_file(
        "claim_token=FRCT-abc\n"
        "device=http.upload\n"
        "width=800\n"
        "height=480\n"
        "upload_url=https://frames.example.com/upload\n"
    )

    result = sandbox.run(disable_python3=True)

    assert result.returncode == 0, result.stdout + result.stderr
    argv = argv_log.read_text(encoding="utf-8")
    assert "set-display" in argv
    assert f"--frame-json={frame_json}" in argv
    assert "--device=http.upload" in argv
    assert "--width=800" in argv
    assert "--height=480" in argv
    assert "--upload-url=https://frames.example.com/upload" in argv
    assert "driver-setup" in argv
    log = (sandbox.boot / "frameos-setup-reset.log").read_text(encoding="utf-8")
    assert "Applied display device 'http.upload'" in log
    assert "could not apply display device" not in log


def test_cloud_config_display_invalid_value_leaves_frame_json_untouched(tmp_path):
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos()
    frame_json = sandbox.srv / "frameos" / "current" / "frame.json"
    original = json.dumps({"device": "framebuffer", "width": 800, "height": 480})
    frame_json.write_text(original, encoding="utf-8")
    sandbox.write_cloud_file(
        "claim_token=FRCT-abc\n"
        "device=waveshare.EPD_13in3e\n"
        "rotate=45\n"
    )

    result = sandbox.run()

    # A bad number must not half-apply a display config, and must not block
    # enrollment either.
    assert result.returncode == 0, result.stdout + result.stderr
    assert frame_json.read_text(encoding="utf-8") == original
    assert not argv_log.exists() or "driver-setup" not in argv_log.read_text(encoding="utf-8")
    assert sandbox.pending_file.exists()
    assert "could not apply display device" in (sandbox.boot / "frameos-setup-reset.log").read_text(encoding="utf-8")


def test_cloud_config_display_only_file_is_applied_and_shredded(tmp_path):
    # A card personalized only with a display choice (no cloud enrollment)
    # still applies it and still cleans up /boot.
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos()
    frame_json = sandbox.srv / "frameos" / "current" / "frame.json"
    frame_json.write_text(json.dumps({"device": "framebuffer"}), encoding="utf-8")
    sandbox.write_cloud_file("device=waveshare.EPD_7in5_V2\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(frame_json.read_text(encoding="utf-8"))
    assert data["device"] == "waveshare.EPD_7in5_V2"
    assert "driver-setup" in argv_log.read_text(encoding="utf-8")
    assert not (sandbox.boot / "frameos-cloud.txt").exists()
    assert not sandbox.pending_file.exists()


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
    # Larger than one shred block (4096), with a partial final block, so both
    # dd passes are exercised on a payload holding a real secret.
    secret_json = '{"network": {"wifiPassword": "super-secret"}}'
    setup_file.write_text(secret_json + " " * (5000 - len(secret_json)), encoding="utf-8")
    shadow = sandbox.shadow_link(setup_file)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert argv_log.read_text(encoding="utf-8").splitlines() == [
        "setup",
        f"--with-setup={sandbox.boot}/frameos-setup.json",
    ]
    # Shredded and removed — never renamed to setup-done-*.json.
    assert not setup_file.exists()
    # Zeroed, not just unlinked: the hard link that survived the unlink still
    # points at the same inode, and every byte of it is 0x00.
    assert shadow.read_bytes() == b"\0" * 5000
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


def test_cloud_config_placeholder_layout():
    placeholder = render_cloud_config_placeholder()

    # The in-browser personalizer locates the placeholder by these exact
    # bytes and overwrites the 4096-byte region in place; size and magic are
    # load-bearing.
    assert len(placeholder) == CLOUD_CONFIG_PLACEHOLDER_SIZE == 4096
    assert placeholder.startswith(CLOUD_CONFIG_MAGIC.encode("ascii") + b"\n")
    assert CLOUD_CONFIG_MAGIC == "# FRAMEOS-CLOUD-CONFIG-V1"
    text = placeholder.decode("ascii")
    # Only comment lines: first boot must treat the file as "not
    # personalized" and leave it in place.
    assert all(line.startswith("#") for line in text.splitlines())
    # The comments double as manual-editing instructions.
    for key in ("cloud_url", "claim_token", "name", "wifi_ssid", "wifi_password"):
        assert key in text
    assert "first boot" in text
    # Deterministic padding: full 79x'#'+newline lines, then a final partial
    # run of '#' without a trailing newline.
    assert CLOUD_CONFIG_PLACEHOLDER_PAD_LINE == b"#" * 79 + b"\n"
    tail = placeholder[placeholder.rindex(b"\n") + 1:]
    assert tail == b"#" * len(tail) and len(tail) < 80
    assert placeholder[: placeholder.rindex(b"\n") + 1].endswith(CLOUD_CONFIG_PLACEHOLDER_PAD_LINE)
    assert render_cloud_config_placeholder() == placeholder  # deterministic


def test_placeholder_cloud_file_is_a_no_op_and_left_in_place(tmp_path):
    sandbox = Sandbox(tmp_path)
    placeholder = render_cloud_config_placeholder()
    cloud_file = sandbox.boot / "frameos-cloud.txt"
    cloud_file.write_bytes(placeholder)
    # Generic release images keep this file forever, so every boot would
    # otherwise redo the preamble: remount rw, append to the log, reinstall
    # /etc from /boot.
    (sandbox.boot / "frameos-hostname").write_text("from-boot\n", encoding="utf-8")
    (sandbox.etc / "hostname").write_text("edited-on-device\n", encoding="utf-8")
    wifi_dir = sandbox.etc / "NetworkManager" / "system-connections"
    wifi_dir.mkdir(parents=True)
    (sandbox.boot / "frameos-wifi.nmconnection").write_text("[connection]\nid=from-boot\n", encoding="utf-8")
    (wifi_dir / "frameos-wifi.nmconnection").write_text("[connection]\nid=edited-on-device\n", encoding="utf-8")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    # Not personalized: file kept byte-for-byte, nothing enrolled, no WiFi.
    assert cloud_file.read_bytes() == placeholder
    assert not sandbox.pending_file.exists()
    assert not sandbox.cloud_wifi_file.exists()
    # And no work at all: the placeholder is detected before the preamble.
    assert result.stdout == ""
    assert "remount" not in sandbox.mount_calls()
    assert not sandbox.log_file.exists()
    assert (sandbox.etc / "hostname").read_text(encoding="utf-8") == "edited-on-device\n"
    assert "edited-on-device" in (wifi_dir / "frameos-wifi.nmconnection").read_text(encoding="utf-8")


def test_placeholder_cloud_file_is_logged_when_setup_json_also_runs(tmp_path):
    # With a setup JSON present the script runs anyway, and then the untouched
    # placeholder is explained in the log rather than silently skipped.
    sandbox = Sandbox(tmp_path)
    sandbox.add_fake_frameos(exit_status=0)
    (sandbox.boot / "frameos-setup.json").write_text("{}", encoding="utf-8")
    cloud_file = sandbox.boot / "frameos-cloud.txt"
    cloud_file.write_bytes(render_cloud_config_placeholder())

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "placeholder or comments only" in result.stdout
    assert cloud_file.exists()


def test_typo_in_claim_token_key_never_shreds_the_users_only_copy(tmp_path):
    # A valid cloud_url plus a misspelled claim_token: recognized keys exist,
    # so the "zero recognized keys" guard does not fire — but no enrollment
    # happened, and shredding here would destroy the claim token for good.
    sandbox = Sandbox(tmp_path)
    content = "cloud_url=https://cloud.example.com\nclaim_tokn=FRCT-typo\n"
    cloud_file = sandbox.write_cloud_file(content)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert cloud_file.read_text(encoding="utf-8") == content
    assert not sandbox.pending_file.exists()
    assert "nothing was applied" in result.stdout
    assert "claim_tokn" in result.stdout


def test_open_wifi_network_omits_the_security_section(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.write_cloud_file("claim_token=FRCT-open\nwifi_ssid=Open Cafe\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    wifi = sandbox.cloud_wifi_file.read_text(encoding="utf-8")
    assert "ssid=Open Cafe" in wifi
    # key-mgmt=wpa-psk with an empty psk= can never activate.
    assert "[wifi-security]" not in wifi
    assert "key-mgmt" not in wifi
    assert "psk=" not in wifi
    assert "[ipv4]" in wifi


def test_placeholder_cloud_file_with_real_keys_is_processed_and_shredded(tmp_path):
    sandbox = Sandbox(tmp_path)
    placeholder = render_cloud_config_placeholder().decode("ascii")
    # Simulate in-browser personalization: same magic first line, real keys,
    # padded back with comment lines (content between magic and padding
    # replaced in place).
    lines = placeholder.splitlines()
    personalized = "\n".join(
        [lines[0], "cloud_url=https://cloud.example.com", "claim_token=FRCT-patched"] + lines[3:]
    )
    cloud_file = sandbox.write_cloud_file(personalized)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {"claim_token": "FRCT-patched", "provider_url": "https://cloud.example.com"}
    assert not cloud_file.exists()


def test_cloud_file_with_only_unrecognized_keys_warns_and_is_kept(tmp_path):
    sandbox = Sandbox(tmp_path)
    # Typo'd manual edit: KEY=value lines present, but none recognized. /boot
    # is root-only (umask=077), so the file is kept for the user to fix
    # instead of shredding their only copy.
    content = "cloud_urll=https://cloud.example.com\nclaimtoken=FRCT-typo\n"
    cloud_file = sandbox.write_cloud_file(content)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert cloud_file.read_text(encoding="utf-8") == content
    assert not sandbox.pending_file.exists()
    assert not sandbox.cloud_wifi_file.exists()
    assert "no recognized keys" in result.stdout
    assert "cloud_urll" in result.stdout
    assert "claimtoken" in result.stdout
    assert "leaving" in result.stdout


def test_service_condition_fires_on_setup_json_or_cloud_file():
    service = render_setup_json_reset_service(DEFAULT_SETUP_JSON_RESET_FILE_PATH)

    # ConditionPathExists=| lines OR together (systemd triggering conditions),
    # so the unit runs when either file is present.
    assert f"ConditionPathExists=|{DEFAULT_SETUP_JSON_RESET_FILE_PATH}" in service
    assert f"ConditionPathExists=|{BOOT_CLOUD_CONFIG_FILE}" in service
    assert BOOT_CLOUD_CONFIG_FILE == "/boot/frameos-cloud.txt"
    # The pending-enroll file must exist before frameos starts.
    assert "Before=dropbear.service frameos.service frameos-remote.service" in service


# --- WiFi on platforms without NetworkManager (armv6 / Pi Zero W) ------------
#
# There, a .nmconnection keyfile has no reader at all: FrameOS drives
# wpa_supplicant + hostapd instead. A card flashed with WiFi credentials came up
# with no network, because the credentials only ever existed in keyfile form.

_BOOT_WIFI_KEYFILE = (
    "[connection]\n"
    "id=frameos-wifi\n"
    "type=wifi\n"
    "autoconnect=true\n"
    "\n"
    "[wifi]\n"
    "mode=infrastructure\n"
    # Backslashes are doubled by _nm_keyfile_value / nm_keyfile_escape.
    'ssid=Home \\\\ WiFi "quoted"\n'
    "\n"
    "[wifi-security]\n"
    "key-mgmt=wpa-psk\n"
    "psk=hunter2\\\\pass\n"
    "\n"
    "[ipv4]\n"
    "method=auto\n"
)


def test_boot_wifi_keyfile_is_mirrored_into_wpa_supplicant_without_network_manager(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_boot_wifi_keyfile(_BOOT_WIFI_KEYFILE)
    sandbox.add_fake_frameos()
    (sandbox.boot / "frameos-setup.json").write_text("{}\n", encoding="utf-8")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    # The keyfile is still installed, unchanged.
    assert sandbox.wifi_file.exists()
    # ...and now also exists in the form the supplicant backend reads.
    conf = sandbox.wpa_supplicant_file.read_text(encoding="utf-8")
    assert "update_config=1" in conf
    assert "network={" in conf
    # Keyfile escaping is reversed, then wpa_supplicant escaping is applied.
    assert 'ssid="Home \\\\ WiFi \\"quoted\\""' in conf
    assert 'psk="hunter2\\\\pass"' in conf
    assert "key_mgmt=WPA-PSK" in conf
    assert _mode(sandbox.wpa_supplicant_file) == 0o600
    assert _mode(sandbox.wpa_supplicant_file.parent) == 0o700


def test_boot_wifi_keyfile_is_not_mirrored_on_network_manager_platforms(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.write_boot_wifi_keyfile(_BOOT_WIFI_KEYFILE)
    sandbox.add_fake_frameos()
    (sandbox.boot / "frameos-setup.json").write_text("{}\n", encoding="utf-8")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert sandbox.wifi_file.exists()
    assert not sandbox.wpa_supplicant_file.exists()


def test_cloud_wifi_is_mirrored_into_wpa_supplicant_without_network_manager(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_cloud_file(
        "claim_token=FRCT-abc\nwifi_ssid=Home Network\nwifi_password=hunter=two\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert sandbox.cloud_wifi_file.exists()
    conf = sandbox.wpa_supplicant_file.read_text(encoding="utf-8")
    assert 'ssid="Home Network"' in conf
    assert 'psk="hunter=two"' in conf
    assert _mode(sandbox.wpa_supplicant_file) == 0o600
    # The personalization file still gets shredded once the secrets landed.
    assert not (sandbox.boot / "frameos-cloud.txt").exists()


def test_cloud_open_wifi_is_mirrored_as_an_open_wpa_supplicant_network(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_cloud_file("claim_token=FRCT-abc\nwifi_ssid=Cafe Open\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    conf = sandbox.wpa_supplicant_file.read_text(encoding="utf-8")
    assert 'ssid="Cafe Open"' in conf
    # No key management at all, or wpa_supplicant waits forever for a
    # handshake that never comes.
    assert "key_mgmt=NONE" in conf
    assert "psk" not in conf


def test_no_wifi_credentials_leaves_the_wpa_supplicant_config_absent(tmp_path):
    # Nothing to mirror means no config, which is what makes the frame raise
    # its setup hotspot instead of waiting on a network it was never given.
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.add_fake_frameos()
    (sandbox.boot / "frameos-setup.json").write_text("{}\n", encoding="utf-8")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not sandbox.wpa_supplicant_file.exists()


def test_wpa_supplicant_config_is_never_written_with_a_plaintext_psk_in_the_log(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_cloud_file("claim_token=FRCT-abc\nwifi_ssid=Home\nwifi_password=topsecret123\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "topsecret123" not in result.stdout
    assert "topsecret123" not in sandbox.log_file.read_text(encoding="utf-8")


# --- The frameos-setup.bin personalization blob ------------------------------


def _personalized_blob(files: dict[str, bytes]) -> bytes:
    from app.tasks.sd_image_blob_patch import build_setup_blob_payload
    from app.tasks.setup_json_reset import render_setup_blob_region

    return render_setup_blob_region(build_setup_blob_payload(files))


def test_setup_blob_placeholder_layout():
    from app.tasks.setup_json_reset import (
        SETUP_BLOB_MAGIC,
        SETUP_BLOB_PLACEHOLDER_SIZE,
        render_setup_blob_placeholder,
    )

    placeholder = render_setup_blob_placeholder()
    assert len(placeholder) == SETUP_BLOB_PLACEHOLDER_SIZE
    text = placeholder.decode("ascii")
    lines = text.split("\n")
    assert lines[0] == SETUP_BLOB_MAGIC
    # Every line is a comment: the personalizer verifies this before daring
    # to overwrite the region, and first boot treats it as "not personalized".
    assert all(line.startswith("#") for line in lines if line)


def test_pristine_setup_blob_is_a_no_op_and_left_in_place(tmp_path):
    from app.tasks.setup_json_reset import render_setup_blob_placeholder

    sandbox = Sandbox(tmp_path)
    sandbox.add_fake_frameos()
    blob = sandbox.boot / "frameos-setup.bin"
    placeholder = render_setup_blob_placeholder()
    blob.write_bytes(placeholder)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    # The bottom gate exits before run_setup: no log file, no remount, and
    # the placeholder survives byte for byte.
    assert not sandbox.log_file.exists()
    assert sandbox.mount_calls() == ""
    assert blob.read_bytes() == placeholder


def test_personalized_setup_blob_extracts_installs_and_shreds(tmp_path):
    sandbox = Sandbox(tmp_path)
    argv_log = sandbox.add_fake_frameos(exit_status=0)
    blob = sandbox.boot / "frameos-setup.bin"
    blob.write_bytes(
        _personalized_blob(
            {
                "frameos-setup.json": json.dumps({"name": "Blob frame"}).encode("utf-8"),
                "frameos-hostname": b"blob-frame\n",
                "frameos-wifi.nmconnection": b"[wifi]\nssid=BlobNet\n",
                "frameos-authorized_keys": b"ssh-ed25519 AAAA blob@test\n",
            }
        )
    )
    shadow = sandbox.shadow_link(blob)

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Extracting first-boot personalization" in result.stdout
    # The extracted setup JSON drove a real `frameos setup --with-setup=...`.
    argv = argv_log.read_text(encoding="utf-8")
    assert "--with-setup=" in argv
    # The member files went through the existing per-file handlers.
    assert (sandbox.etc / "hostname").read_text(encoding="utf-8") == "blob-frame\n"
    assert sandbox.wifi_file.read_text(encoding="utf-8") == "[wifi]\nssid=BlobNet\n"
    # The blob held every secret its members did: zero-overwritten, removed.
    assert not blob.exists()
    assert set(shadow.read_bytes()) == {0}
    # The extracted setup JSON was shredded by the existing handler too.
    assert not (sandbox.boot / "frameos-setup.json").exists()


def test_setup_blob_without_optional_members_installs_only_what_it_has(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.add_fake_frameos(exit_status=0)
    blob = sandbox.boot / "frameos-setup.bin"
    blob.write_bytes(
        _personalized_blob({"frameos-setup.json": b'{"name": "Minimal"}'})
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (sandbox.etc / "hostname").exists()
    assert not sandbox.wifi_file.exists()
    assert not blob.exists()


def test_cloud_config_authorized_keys_land_in_roots_authorized_keys(tmp_path):
    sandbox = Sandbox(tmp_path)
    ed25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJ4ZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleQ marius@laptop"
    rsa = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC0fakekeyfakekeyfakekey"
    sandbox.write_cloud_file(
        "claim_token=FRCT-abc123\n"
        f"authorized_key={ed25519}\n"
        "authorized_key=\n"
        f"authorized_key = {rsa}\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    authorized_keys = sandbox.root / "root-ssh" / "authorized_keys"
    assert authorized_keys.read_text(encoding="utf-8") == f"{ed25519}\n{rsa}\n"
    assert _mode(authorized_keys) == 0o600
    assert _mode(authorized_keys.parent) == 0o700
    assert "Installing authorized keys from cloud personalization" in result.stdout
    # Still enrolls, and the key lines count as recognized personalization.
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending["claim_token"] == "FRCT-abc123"


def test_cloud_config_without_authorized_keys_writes_no_authorized_keys_file(tmp_path):
    sandbox = Sandbox(tmp_path)
    sandbox.write_cloud_file("claim_token=FRCT-abc123\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (sandbox.root / "root-ssh").exists()


def test_cloud_wifi_country_lands_in_the_wpa_mirror_and_the_pending_state(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_cloud_file(
        "claim_token=FRCT-cc\nwifi_ssid=Home\nwifi_password=hunter2hunter2\nwifi_country=fr\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    conf = sandbox.wpa_supplicant_file.read_text(encoding="utf-8")
    # Upper-cased, and placed with the global settings, before the network block.
    assert "update_config=1\ncountry=FR\nnetwork={" in conf
    # WPA2 and WPA3 both offered, PMF optional, passphrase kept for SAE.
    assert "key_mgmt=WPA-PSK SAE" in conf
    assert "ieee80211w=1" in conf
    assert 'psk="hunter2hunter2"' in conf
    # The runtime applies the same domain on every boot (and, once enrolled,
    # writes it into frame.json) from the pending state.
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending["wifi_country"] == "FR"

    # The busybox-only JSON writer carries it too.
    sandbox.write_cloud_file("claim_token=FRCT-cc2\nwifi_country=EE\n")
    result = sandbox.run(disable_python3=True)
    assert result.returncode == 0, result.stdout + result.stderr
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert pending == {
        "claim_token": "FRCT-cc2",
        "provider_url": DEFAULT_CLOUD_PROVIDER_URL,
        "wifi_country": "EE",
    }


def test_cloud_wifi_country_that_is_not_a_country_code_is_dropped_with_a_warning(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_cloud_file(
        "claim_token=FRCT-cc3\nwifi_ssid=Home\nwifi_password=hunter2hunter2\nwifi_country=France\n"
    )

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "ignoring wifi_country 'France'" in result.stdout
    conf = sandbox.wpa_supplicant_file.read_text(encoding="utf-8")
    assert "country=" not in conf
    pending = json.loads(sandbox.pending_file.read_text(encoding="utf-8"))
    assert "wifi_country" not in pending


def test_wpa_mirror_keeps_a_raw_hex_psk_on_wpa2_only(tmp_path):
    sandbox = Sandbox(tmp_path, uses_network_manager=False)
    sandbox.write_cloud_file("claim_token=FRCT-hex\nwifi_ssid=Home\nwifi_password=" + "A" * 64 + "\n")

    result = sandbox.run()

    assert result.returncode == 0, result.stdout + result.stderr
    conf = sandbox.wpa_supplicant_file.read_text(encoding="utf-8")
    # No passphrase to derive SAE from: WPA-PSK alone, and the PSK lower-cased
    # the way supplicant.nim writes it.
    assert "key_mgmt=WPA-PSK\n" in conf
    assert "SAE" not in conf
    assert "ieee80211w" not in conf
    assert "psk=" + "a" * 64 in conf
