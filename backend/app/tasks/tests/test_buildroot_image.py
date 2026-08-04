from __future__ import annotations

import asyncio
import gzip
import importlib.util
import json
import re
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from typing import Any

import pytest

from app.models.assets import Assets
from app.tasks import buildroot_image as buildroot_image_module
from app.tasks.buildroot_image import (
    BUILDROOT_CONFIG_CHECK_SCRIPT,
    BUILDROOT_EXPAND_SD_CARD_SCRIPT_PATH,
    BUILDROOT_EXPAND_SD_CARD_SERVICE_NAME,
    BUILDROOT_NETWORK_MANAGER_CONNECTIONS_DIR,
    BUILDROOT_NETWORK_MANAGER_CONNECTIONS_FSTAB_LINE,
    BUILDROOT_NETWORK_MANAGER_STATE_CONNECTIONS_DIR,
    BUILDROOT_WPA_SUPPLICANT_CONF_NAME,
    BUILDROOT_WPA_SUPPLICANT_DIR,
    BUILDROOT_WPA_SUPPLICANT_FSTAB_LINE,
    BUILDROOT_WPA_SUPPLICANT_STATE_DIR,
    FRAMEOS_BUILD_TARGET,
    BuildrootImageBuilder,
    PrecompiledBuildrootSdImageResult,
    buildroot_agent_defaults,
    ensure_buildroot_frame_defaults,
    _buildroot_setup_payload,
    _frame_boot_config_lines,
    _merge_boot_config_lines,
    _network_manager_wifi_connection,
    _wpa_supplicant_conf,
    precompiled_buildroot_sd_image_release_url,
    render_buildroot_frameos_service,
    stage_buildroot_frameos_service,
    render_expand_sd_card_script,
    render_expand_sd_card_service,
    render_post_build_script,
    render_post_image_script,
)
from app.tasks.buildroot_platforms import RASPBERRY_PI_ZERO_2_W, RASPBERRY_PI_ZERO_W
from app.tasks.binary_builder import FrameBinaryBuildResult
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.tasks.setup_json_reset import (
    DEFAULT_SETUP_JSON_RESET_FILE_PATH,
    render_setup_json_reset_service,
    render_setup_json_reset_script,
    setup_json_reset_file_path,
)
from app.utils.build_executor import BuildHostExecutor
from app.utils.build_host import BuildHostConfig
from app.utils.cross_compile import CrossCompiler


REPO_ROOT = Path(__file__).resolve().parents[4]


@pytest.mark.asyncio
async def test_buildroot_progress_updates_after_interval(monkeypatch):
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_PROGRESS_LOG_INTERVAL_SECONDS", 0.01)
    builder = BuildrootImageBuilder(db=None, redis=None, frame=SimpleNamespace(id=1))
    logs: list[tuple[str, str]] = []

    async def fake_log(type: str, line: str) -> None:
        logs.append((type, line))

    builder._log = fake_log

    result = await builder._with_progress_updates("Still working on SD image", asyncio.sleep(0.025, result="done"))

    assert result == "done"
    assert logs
    assert logs[0][0] == "stdout"
    assert logs[0][1].startswith("Still working on SD image (")
    assert "elapsed" in logs[0][1]


@pytest.mark.asyncio
async def test_buildroot_sd_image_queue_job_active_requires_recent_heartbeat(monkeypatch):
    class FakeJob:
        def __init__(self, *_args, **_kwargs):
            pass

        async def status(self):
            return buildroot_image_module.JobStatus.in_progress

    monkeypatch.setattr(buildroot_image_module, "Job", FakeJob)
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS", 60)

    stale_at = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    active = await buildroot_image_module._buildroot_sd_image_queue_job_active(
        None,
        {
            "queueJobId": "buildroot_sd_image:1:stale",
            "status": "building",
            "startedAt": stale_at,
            "lastHeartbeatAt": stale_at,
        },
    )

    assert active is False


@pytest.mark.asyncio
async def test_buildroot_sd_image_queue_job_active_keeps_recent_heartbeat(monkeypatch):
    class FakeJob:
        def __init__(self, *_args, **_kwargs):
            pass

        async def status(self):
            return buildroot_image_module.JobStatus.in_progress

    monkeypatch.setattr(buildroot_image_module, "Job", FakeJob)
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS", 60)

    recent_at = datetime.now(timezone.utc).isoformat()
    active = await buildroot_image_module._buildroot_sd_image_queue_job_active(
        None,
        {
            "queueJobId": "buildroot_sd_image:1:active",
            "status": "building",
            "startedAt": recent_at,
            "lastHeartbeatAt": recent_at,
        },
    )

    assert active is True


@pytest.mark.asyncio
async def test_buildroot_sd_image_queue_job_active_status_error_uses_heartbeat(monkeypatch):
    class FakeJob:
        def __init__(self, *_args, **_kwargs):
            pass

        async def status(self):
            raise RuntimeError("redis unavailable")

    monkeypatch.setattr(buildroot_image_module, "Job", FakeJob)
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS", 60)

    stale_at = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    active = await buildroot_image_module._buildroot_sd_image_queue_job_active(
        None,
        {
            "queueJobId": "buildroot_sd_image:1:stale",
            "status": "building",
            "startedAt": stale_at,
            "lastHeartbeatAt": stale_at,
        },
    )

    assert active is False


@pytest.mark.asyncio
async def test_buildroot_sd_image_queue_job_active_uses_queue_grace_period(monkeypatch):
    class FakeJob:
        def __init__(self, *_args, **_kwargs):
            pass

        async def status(self):
            return buildroot_image_module.JobStatus.queued

    monkeypatch.setattr(buildroot_image_module, "Job", FakeJob)
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS", 60)
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_IMAGE_QUEUE_INACTIVE_AFTER_SECONDS", 600)

    queued_at = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    active = await buildroot_image_module._buildroot_sd_image_queue_job_active(
        None,
        {
            "queueJobId": "buildroot_sd_image:1:queued",
            "status": "queued",
            "startedAt": queued_at,
            "queuedAt": queued_at,
        },
    )

    assert active is True


def test_buildroot_frameos_cross_target_uses_docker_arm64_platform(tmp_path, monkeypatch):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))

    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=FRAMEOS_BUILD_TARGET,
        temp_dir=str(tmp_path / "tmp"),
    )

    assert compiler._platform() == "linux/arm64"
    assert compiler._docker_image() == "debian:bookworm"
    assert (
        resolve_prebuilt_target(
            FRAMEOS_BUILD_TARGET.distro,
            FRAMEOS_BUILD_TARGET.version,
            FRAMEOS_BUILD_TARGET.arch,
        )
        == "debian-bookworm-arm64"
    )


def test_buildroot_network_manager_connection_contains_wifi_credentials():
    connection = _network_manager_wifi_connection("Test WiFi", "secret\\password")

    assert "id=frameos-wifi" in connection
    assert "type=wifi" in connection
    assert "ssid=Test WiFi" in connection
    assert "key-mgmt=wpa-psk" in connection
    assert "psk=secret\\\\password" in connection


def test_buildroot_wpa_supplicant_conf_mirrors_the_supplicant_backend():
    # Platforms without NetworkManager (armv6 / Pi Zero W) read nothing from a
    # .nmconnection keyfile, so the credentials are written in wpa_supplicant
    # form as well - byte-for-byte what supplicant.nim would have generated.
    conf = _wpa_supplicant_conf('Test "WiFi"', "secret\\password")

    assert conf.startswith("# Generated by FrameOS.")
    assert "ctrl_interface=/var/run/wpa_supplicant" in conf
    assert "update_config=1" in conf
    assert 'ssid="Test \\"WiFi\\""' in conf
    assert "scan_ssid=1" in conf
    assert "key_mgmt=WPA-PSK" in conf
    assert 'psk="secret\\\\password"' in conf


def test_buildroot_wpa_supplicant_conf_handles_open_and_hex_psk_networks():
    open_conf = _wpa_supplicant_conf("Cafe Open", "")
    # An open network must not carry key management at all, or wpa_supplicant
    # waits forever for a handshake that never comes.
    assert "key_mgmt=NONE" in open_conf
    assert "psk" not in open_conf

    hex_conf = _wpa_supplicant_conf("Home", "A" * 64)
    assert "psk=" + "a" * 64 in hex_conf
    assert 'psk="' not in hex_conf


def test_buildroot_sd_image_bakes_wpa_supplicant_conf_only_without_network_manager(tmp_path):
    network = {"wifiSSID": "Home WiFi", "wifiPassword": "hunter2hunter2"}
    conf_relative = Path(BUILDROOT_WPA_SUPPLICANT_STATE_DIR.lstrip("/")) / BUILDROOT_WPA_SUPPLICANT_CONF_NAME

    zero_w = SimpleNamespace(id=1, network=network, buildroot={"platform": RASPBERRY_PI_ZERO_W.key})
    zero_w_overlay = tmp_path / "zero-w-overlay"
    BuildrootImageBuilder(db=None, redis=None, frame=zero_w)._write_state_wpa_supplicant_conf(zero_w_overlay)

    conf_path = zero_w_overlay / conf_relative
    assert conf_path.exists()
    assert 'ssid="Home WiFi"' in conf_path.read_text(encoding="utf-8")
    assert 'psk="hunter2hunter2"' in conf_path.read_text(encoding="utf-8")
    # Same 0600/0700 the keyfiles get; the state partition is not world readable.
    assert stat.S_IMODE(conf_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(conf_path.parent.stat().st_mode) == 0o700

    # The Zero 2 W has NetworkManager and is deliberately left untouched.
    zero_2_w = SimpleNamespace(id=2, network=network, buildroot={"platform": RASPBERRY_PI_ZERO_2_W.key})
    zero_2_w_overlay = tmp_path / "zero-2-w-overlay"
    BuildrootImageBuilder(db=None, redis=None, frame=zero_2_w)._write_state_wpa_supplicant_conf(zero_2_w_overlay)
    assert not (zero_2_w_overlay / conf_relative).exists()

    # No credentials at all: nothing to bake, and the setup hotspot takes over.
    blank = SimpleNamespace(id=3, network={}, buildroot={"platform": RASPBERRY_PI_ZERO_W.key})
    blank_overlay = tmp_path / "blank-overlay"
    BuildrootImageBuilder(db=None, redis=None, frame=blank)._write_state_wpa_supplicant_conf(blank_overlay)
    assert not (blank_overlay / conf_relative).exists()


def test_buildroot_firstboot_mirrors_wifi_into_wpa_supplicant_without_network_manager():
    with_nm = render_setup_json_reset_script("/boot/frameos-setup.json")
    without_nm = render_setup_json_reset_script("/boot/frameos-setup.json", uses_network_manager=False)

    # NetworkManager platforms keep the exact script they had.
    assert "wpa_supplicant" not in with_nm
    assert "__WPA_SUPPLICANT" not in with_nm and "__WPA_SUPPLICANT" not in without_nm

    # The keyfile is still installed either way.
    assert 'install -d -m 700 "$ETC_DIR"/NetworkManager/system-connections' in without_nm
    assert "frameos-cloud-wifi.nmconnection" in without_nm
    # ...and now also mirrored into the directory the supplicant backend reads,
    # which is bind-mounted onto /etc/wpa_supplicant.
    assert 'WPA_SUPPLICANT_STATE_DIR="$SRV_DIR"/frameos/state/wpa_supplicant' in without_nm
    assert BUILDROOT_WPA_SUPPLICANT_CONF_NAME in without_nm
    assert 'wpa_supplicant_conf_from_keyfile "$WIFI_CONNECTION_FILE" || true' in without_nm
    assert 'write_wpa_supplicant_conf "$cloud_wifi_ssid" "$cloud_wifi_password"' in without_nm
    assert "chmod 600 \"$wpa_conf_file\"" in without_nm


def test_buildroot_firstboot_script_is_posix_shell(tmp_path):
    # The armv6 image only has busybox ash; a bashism would break first boot.
    for uses_network_manager in (True, False):
        script = tmp_path / f"firstboot-{uses_network_manager}.sh"
        script.write_text(
            render_setup_json_reset_script("/boot/frameos-setup.json", uses_network_manager=uses_network_manager),
            encoding="utf-8",
        )
        result = subprocess.run(["/bin/sh", "-n", str(script)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr


def test_buildroot_firstboot_setup_uses_with_setup_command():
    script = render_setup_json_reset_script("/boot/frameos-setup.json")
    service = render_setup_json_reset_service("/boot/frameos-setup.json")

    assert '"$SRV_DIR"/frameos/current/frameos setup --with-setup="$SETUP_FILE"' in script
    assert 'sudo -E "$SRV_DIR"/frameos/current/frameos setup --with-setup="$SETUP_FILE"' in script
    assert 'LD_LIBRARY_PATH="$SRV_DIR/frameos/current/drivers:$SRV_DIR/frameos/current/scenes' in script
    # Production defaults stay /boot, /srv, /etc; env vars exist for tests only.
    assert 'BOOT_DIR="${FRAMEOS_BOOT_DIR:-/boot}"' in script
    assert 'SRV_DIR="${FRAMEOS_SRV_DIR:-/srv}"' in script
    assert 'ETC_DIR="${FRAMEOS_ETC_DIR:-/etc}"' in script
    assert 'SETUP_FILE="$BOOT_DIR"/frameos-setup.json' in script
    assert 'CLOUD_FILE="$BOOT_DIR"/frameos-cloud.txt' in script
    assert "mount -o remount,rw /" in script
    assert 'install -d -m 700 "$ETC_DIR"/NetworkManager/system-connections' in script
    assert "root:%s" in script
    assert "chpasswd" in script
    assert 'DROPBEAR_ARGS=""' in script
    assert "systemctl try-restart dropbear.service" in script
    assert 'shred_remove_file "$ROOT_PASSWORD_FILE"' in script
    assert "frameos-setup-reset.log" in script
    assert "leaving $SETUP_FILE in place for retry" in script
    # Consumed secrets are shredded, never renamed to setup-done-*.json.
    assert 'mv -f "$SETUP_FILE"' not in script
    assert 'shred_remove_file "$SETUP_FILE"' in script
    assert 'shred_remove_file "$CLOUD_FILE"' in script
    assert "dd if=/dev/zero" in script
    assert "cloud_enroll_pending.json" in script
    assert "frameos-cloud-wifi.nmconnection" in script
    assert "request_reboot()" in script
    assert "systemctl reboot" in script
    assert "Reboot command accepted" in script
    assert "with status 0 (reboot requested)" in script
    assert "Before=dropbear.service frameos.service frameos-remote.service" in service
    assert "ConditionPathExists=|/boot/frameos-setup.json" in service
    assert "ConditionPathExists=|/boot/frameos-cloud.txt" in service
    assert "--from-file" not in script


@pytest.mark.asyncio
async def test_buildroot_frameos_binary_disables_on_device_fallback(monkeypatch, tmp_path):
    calls = {}
    frame = SimpleNamespace(id=1, project_id=1, rpios={})

    class FakeFrameBinaryBuilder:
        def __init__(self, **kwargs):
            calls["init"] = kwargs

        async def plan_build(self, **kwargs):
            calls["plan"] = kwargs
            return "plan"

        async def build(self, plan, **kwargs):
            calls["build"] = {"plan": plan, **kwargs}
            return "result"

    monkeypatch.setattr(buildroot_image_module, "FrameBinaryBuilder", FakeFrameBinaryBuilder)

    async def fake_log(*_args, **_kwargs):
        return None

    builder = BuildrootImageBuilder(db=object(), redis=object(), frame=frame)
    monkeypatch.setattr(builder, "_log", fake_log)
    result = await builder._build_frameos_binary(
        SimpleNamespace(build_id="build12345678"),
        str(tmp_path),
        frame,
    )

    assert result == "result"
    assert calls["plan"]["target_override"] == FRAMEOS_BUILD_TARGET
    assert calls["plan"]["allow_on_device_fallback"] is False
    assert calls["build"]["plan"] == "plan"
    assert calls["build"]["precompiled_install_all_drivers"] is True


def test_buildroot_defaults_remove_setup_json_reset_file_path():
    frame = SimpleNamespace(
        id=7,
        frame_host="",
        buildroot={
            "platform": "raspberry-pi-zero-2-w",
            "setupJsonResetFilePath": "/custom/setup.json",
        },
        https_proxy={},
        agent={},
        network={},
    )

    ensure_buildroot_frame_defaults(frame)

    assert "setupJsonResetFilePath" not in frame.buildroot
    assert setup_json_reset_file_path(frame) == DEFAULT_SETUP_JSON_RESET_FILE_PATH


def _buildroot_agent_frame(agent: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(
        id=7,
        frame_host="",
        buildroot={"platform": "raspberry-pi-zero-2-w"},
        https_proxy={},
        agent=agent,
        network={},
    )


def test_buildroot_defaults_keep_an_explicit_ssh_only_choice():
    # ensure_buildroot_frame_defaults runs on every save, SD rebuild, deploy
    # preview and sync-apply. Forcing the agent flags on there is what made
    # "Connect via SSH" impossible to keep on a buildroot frame: the UI wrote
    # the choice and the very same request put it back.
    frame = _buildroot_agent_frame(
        {"agentEnabled": False, "agentRunCommands": False, "deployWithAgent": False}
    )

    ensure_buildroot_frame_defaults(frame)

    assert frame.agent["agentEnabled"] is False
    assert frame.agent["agentRunCommands"] is False
    assert frame.agent["deployWithAgent"] is False
    # A secret is still kept around so Remote can be switched back on later
    # without re-flashing or re-provisioning the frame.
    assert frame.agent["agentSharedSecret"]


def test_buildroot_defaults_do_not_disturb_a_remote_driven_frame():
    frame = _buildroot_agent_frame(
        {"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True, "agentSharedSecret": "keep-me"}
    )

    ensure_buildroot_frame_defaults(frame)

    assert frame.agent == {
        "agentEnabled": True,
        "agentRunCommands": True,
        "deployWithAgent": True,
        "agentSharedSecret": "keep-me",
    }


def test_buildroot_agent_defaults_turn_remote_on_for_new_frames():
    # The new-frame path applies these once; a flashed card usually lands
    # somewhere the backend cannot SSH into.
    assert buildroot_agent_defaults() == {
        "agentEnabled": True,
        "agentRunCommands": True,
        "deployWithAgent": True,
    }


def test_buildroot_setup_payload_includes_real_frame_scenes(monkeypatch):
    scenes = [
        {"id": "scene-1", "settings": {"execution": "interpreted"}},
        {"id": "scene-2", "settings": {"execution": "compiled"}},
    ]
    frame = SimpleNamespace(id=1, project_id=7, scenes=scenes)

    monkeypatch.setattr("app.tasks.buildroot_image.get_frame_json", lambda _db, _frame: {"id": 1})

    assert _buildroot_setup_payload(None, frame) == {"id": 1, "scenes": scenes}


def test_buildroot_config_avoids_ncurses_selecting_packages(tmp_path):
    config_path = tmp_path / "frameos-buildroot.config"

    BuildrootImageBuilder._write_buildroot_config(config_path, RASPBERRY_PI_ZERO_2_W)
    config = config_path.read_text(encoding="utf-8")

    assert "BR2_PACKAGE_BASH=y" in config
    assert "BR2_PACKAGE_PROCPS_NG" not in config
    assert 'BR2_DL_DIR="/cache/dl"' in config
    assert "BR2_JLEVEL=0" in config
    assert 'BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES="/work/linux-fragment.config"' in config
    assert 'BR2_LINUX_KERNEL_CUSTOM_LOGO_PATH="/work/frameos-boot-logo.png"' in config
    assert "BR2_PACKAGE_DROPBEAR=y" in config
    assert "BR2_PACKAGE_SHADOW=y" in config
    assert "BR2_PACKAGE_DBUS=y" in config
    assert "BR2_PACKAGE_SYSTEMD_TIMESYNCD=y" in config
    assert "BR2_PACKAGE_DCRON=y" in config
    assert "BR2_PACKAGE_TZDATA=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX_BINARIES=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX_PARTX=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX_RFKILL=y" in config
    assert "BR2_PACKAGE_E2FSPROGS=y" in config
    assert "BR2_PACKAGE_E2FSPROGS_RESIZE2FS=y" in config
    assert "BR2_PACKAGE_DOSFSTOOLS=y" in config
    assert "BR2_PACKAGE_DOSFSTOOLS_MKFS_FAT=y" in config
    assert "BR2_PACKAGE_NANO=y" in config
    assert "BR2_PACKAGE_IMAGEMAGICK=y" in config
    assert "BR2_PACKAGE_IPTABLES=y" in config
    assert "BR2_PACKAGE_IPTABLES_NFTABLES=y" in config
    # BR2_PACKAGE_IPTABLES_NFTABLES_DEFAULT does not exist in Buildroot; asking
    # for it made `make olddefconfig` drop it silently on every build.
    assert "BR2_PACKAGE_IPTABLES_NFTABLES_DEFAULT" not in config
    assert "BR2_PACKAGE_NFTABLES=y" in config
    assert "BR2_PACKAGE_NETWORK_MANAGER=y" in config
    assert "BR2_PACKAGE_NETWORK_MANAGER_CLI=y" in config
    # BR2_PACKAGE_NETWORK_MANAGER_WIFI is not a Buildroot symbol either.
    assert "BR2_PACKAGE_NETWORK_MANAGER_WIFI" not in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_DBUS=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_NL80211=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_AP_SUPPORT=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_CLI=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_PASSPHRASE=y" in config
    assert "BR2_PACKAGE_HOSTAPD_WPA3=y" in config
    assert "BR2_PACKAGE_WIRELESS_REGDB=y" in config
    assert "BR2_CCACHE=y" in config
    assert 'BR2_CCACHE_DIR="/cache/ccache"' in config
    assert 'BR2_CCACHE_INITIAL_SETUP="--max-size=10G"' in config
    assert 'BR2_ROOTFS_POST_IMAGE_SCRIPT="/work/post-image.sh"' in config
    assert "/work/partition-post-build.sh" in config


def _run_buildroot_config_check(tmp_path, requested: str, resolved: str):
    """Run the checker exactly as the Buildroot container does."""
    script_path = tmp_path / "check-buildroot-config.py"
    script_path.write_text(BUILDROOT_CONFIG_CHECK_SCRIPT, encoding="utf-8")
    requested_path = tmp_path / "frameos-buildroot.config"
    resolved_path = tmp_path / ".config"
    requested_path.write_text(requested, encoding="utf-8")
    resolved_path.write_text(resolved, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(script_path), str(requested_path), str(resolved_path)],
        capture_output=True,
        text=True,
    )


def test_buildroot_config_check_passes_when_every_package_survives(tmp_path):
    requested = "BR2_PACKAGE_DNSMASQ=y\nBR2_PACKAGE_IW=y\nBR2_TARGET_GENERIC_HOSTNAME=\"frameos\"\n"
    resolved = (
        "BR2_PACKAGE_DNSMASQ=y\n"
        "BR2_PACKAGE_IW=y\n"
        "BR2_TARGET_GENERIC_HOSTNAME=\"frameos\"\n"
        "# BR2_PACKAGE_IWD is not set\n"
    )

    result = _run_buildroot_config_check(tmp_path, requested, resolved)

    assert result.returncode == 0, result.stderr


def test_buildroot_config_check_fails_on_silently_dropped_packages(tmp_path):
    """The exact regression that shipped a Zero W image with no nmcli: Buildroot
    deletes symbols with unmet dependencies during olddefconfig without a word."""
    requested = (
        "BR2_PACKAGE_DNSMASQ=y\n"
        "BR2_PACKAGE_NETWORK_MANAGER=y\n"
        "BR2_PACKAGE_NETWORK_MANAGER_CLI=y\n"
        "BR2_PACKAGE_IPTABLES_NFTABLES_DEFAULT=y\n"
    )
    resolved = "BR2_PACKAGE_DNSMASQ=y\n"

    result = _run_buildroot_config_check(tmp_path, requested, resolved)

    assert result.returncode == 1
    assert "BR2_PACKAGE_NETWORK_MANAGER=y" in result.stderr
    assert "BR2_PACKAGE_NETWORK_MANAGER_CLI=y" in result.stderr
    assert "BR2_PACKAGE_IPTABLES_NFTABLES_DEFAULT=y" in result.stderr
    assert "BR2_PACKAGE_DNSMASQ" not in result.stderr
    assert "3 requested package symbol" in result.stderr


def test_buildroot_config_check_flags_explicitly_disabled_packages(tmp_path):
    requested = "BR2_PACKAGE_WPA_SUPPLICANT_CLI=y\n"
    resolved = "# BR2_PACKAGE_WPA_SUPPLICANT_CLI is not set\n"

    result = _run_buildroot_config_check(tmp_path, requested, resolved)

    assert result.returncode == 1
    assert "explicitly disabled" in result.stderr


def test_buildroot_config_check_ignores_host_dependent_toolchain_symbols(tmp_path):
    """Bootlin toolchains only exist for some hosts; falling back to the
    from-source Buildroot toolchain is intentional, not a dropped package."""
    requested = (
        "BR2_TOOLCHAIN_EXTERNAL=y\n"
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_ARMV6_EABIHF_GLIBC_STABLE=y\n"
        "BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV=y\n"
        "BR2_PACKAGE_IW=y\n"
    )
    resolved = "BR2_TOOLCHAIN_BUILDROOT=y\nBR2_PACKAGE_IW=y\n"

    result = _run_buildroot_config_check(tmp_path, requested, resolved)

    assert result.returncode == 0, result.stderr


def test_buildroot_build_script_verifies_config_after_olddefconfig(tmp_path):
    script_path = tmp_path / "buildroot-build.sh"

    BuildrootImageBuilder._write_build_script(script_path, "frameos-test.img", RASPBERRY_PI_ZERO_W)
    script = script_path.read_text(encoding="utf-8")

    olddefconfig_at = script.index("olddefconfig")
    check_at = script.index("python3 - /work/frameos-buildroot.config /build/output/.config")
    make_at = script.index("phase_start buildroot_make")
    # The check has to run after the config is resolved but before anything is built.
    assert olddefconfig_at < check_at < make_at
    assert "phase_start verify_buildroot_config" in script
    assert "requested package symbol" in script


def test_kernel_config_fragment_disables_case_colliding_xtables_targets(tmp_path):
    fragment_path = tmp_path / "linux-fragment.config"

    BuildrootImageBuilder._write_kernel_config_fragment(fragment_path, RASPBERRY_PI_ZERO_2_W)
    fragment = fragment_path.read_text(encoding="utf-8")

    assert "# CONFIG_NETFILTER_XT_TARGET_DSCP is not set" in fragment
    assert "# CONFIG_NETFILTER_XT_TARGET_HL is not set" in fragment
    assert "# CONFIG_NETFILTER_XT_TARGET_RATEEST is not set" in fragment
    assert "# CONFIG_NETFILTER_XT_TARGET_TCPMSS is not set" in fragment
    assert "# CONFIG_NETFILTER_XT_MATCH_RATEEST is not set" in fragment
    assert "# CONFIG_IP_NF_TARGET_ECN is not set" in fragment
    assert "# CONFIG_IP_NF_TARGET_TTL is not set" in fragment
    assert "# CONFIG_IP6_NF_TARGET_HL is not set" in fragment
    assert "# CONFIG_CAN is not set" in fragment
    assert "# CONFIG_DVB_CORE is not set" in fragment
    assert "# CONFIG_STAGING is not set" in fragment


def test_buildroot_script_builds_output_on_container_filesystem(tmp_path):
    script_path = tmp_path / "buildroot-build.sh"

    BuildrootImageBuilder._write_build_script(script_path, "frameos-test.img", RASPBERRY_PI_ZERO_2_W)
    script = script_path.read_text(encoding="utf-8")

    assert "O=/build/output" in script
    assert "rsync" in script
    assert "gfortran" in script
    assert "libssl-dev" in script
    assert "export CC=\"/usr/bin/gcc\"" in script
    assert "export CXX=\"/usr/bin/g++\"" in script
    assert "export FC=\"/usr/bin/gfortran\"" in script
    assert "export HOSTCC=\"/usr/bin/gcc\"" in script
    assert "export HOSTCXX=\"/usr/bin/g++\"" in script
    assert "export HOSTFC=\"/usr/bin/gfortran\"" in script
    assert "CXXFLAGS=\"-O2 -pipe -std=gnu++17\"" in script
    assert "HOSTCXXFLAGS=\"-O2 -pipe -std=gnu++17\"" in script
    assert "unset TERMINFO TERMINFO_DIRS" in script
    assert "FRAMEOS_NCURSES_TERMINFO_LINKS" in script
    assert "for dir in a d f l p s v x;" in script
    assert "rm -f /build/output/build/linux-custom/.stamp_configured" in script
    assert ".stamp_staging_installed" in script
    assert "usr/share/terminfo/a/ansi" in script
    assert "ulimit -n 65535" in script
    assert 'timing_file="/artifacts/buildroot-timings.tsv"' in script
    assert 'package_timing_file="/artifacts/buildroot-package-timings.json"' in script
    assert "phase_start buildroot_make" in script
    assert "phase_start summarize_package_timings" in script
    assert ".frameos-bootstrap-script-version" in script
    assert "dd if=/build/output/images/sdcard.img of=/artifacts/frameos-test.img" in script
    assert "O=/work/output" not in script
    assert "cp /work/output/images/sdcard.img" not in script


def test_buildroot_partition_scripts_create_frameos_and_assets_partitions(tmp_path):
    partition_post_build_path = tmp_path / "partition-post-build.sh"
    post_image_path = tmp_path / "post-image.sh"

    BuildrootImageBuilder._write_partition_post_build_script(partition_post_build_path)
    BuildrootImageBuilder._write_post_image_script(post_image_path, RASPBERRY_PI_ZERO_2_W)
    BuildrootImageBuilder._write_post_build_script(tmp_path / "post-build.sh", RASPBERRY_PI_ZERO_2_W)

    partition_post_build = partition_post_build_path.read_text(encoding="utf-8")
    post_image = post_image_path.read_text(encoding="utf-8")
    post_build = (tmp_path / "post-build.sh").read_text(encoding="utf-8")

    assert "LABEL=BOOT /boot vfat" in partition_post_build
    assert "LABEL=FRAMEOS /srv/frameos ext4" in partition_post_build
    assert "LABEL=ASSETS /srv/assets vfat" in partition_post_build
    assert BUILDROOT_NETWORK_MANAGER_CONNECTIONS_FSTAB_LINE in partition_post_build
    assert (
        "[[:space:]](/boot|/srv/(frameos|assets)|/etc/NetworkManager/system-connections"
        "|/etc/wpa_supplicant)[[:space:]]"
        in partition_post_build
    )
    assert BUILDROOT_WPA_SUPPLICANT_FSTAB_LINE in partition_post_build
    assert 'mkdir -p "$frameos_root/state/wpa_supplicant"' in partition_post_build
    assert 'chmod 700 "$target_dir/etc/wpa_supplicant"' in partition_post_build
    assert 'mkdir -p "$frameos_root/state/NetworkManager/system-connections"' in partition_post_build
    assert (
        'chown 0:0 "$frameos_root/state/NetworkManager" '
        '"$frameos_root/state/NetworkManager/system-connections"'
    ) in partition_post_build
    assert 'chmod 700 "$frameos_root/state/NetworkManager/system-connections"' in partition_post_build
    assert 'chown 0:0 "$target_dir/etc/NetworkManager/system-connections"' in partition_post_build
    assert "frameos-partition-root" in partition_post_build
    assert "assets-partition-root" in partition_post_build
    assert '"$target_dir/etc/cron.d"' in post_build
    assert "brcmfmac43430-sdio" in post_build
    assert "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin" in post_build
    assert "c91cd2804cf7463aab913e7247c176049f16bbd6" in post_build
    assert "raspberrypi,model-zero-2-2" in post_build
    assert "image frameos.ext4" in post_image
    assert "image assets.vfat" in post_image
    assert 'frameos_partition_size="$(partition_size_for_root "${BASE_DIR:?BASE_DIR is required}/frameos-partition-root" "30M")"' in post_image
    assert 'assets_partition_size="$(partition_size_for_root "${BASE_DIR:?BASE_DIR is required}/assets-partition-root" "30M")"' in post_image
    assert "size = $frameos_partition_size" in post_image
    assert "size = $assets_partition_size" in post_image
    assert 'rootfs_image="${BINARIES_DIR:?BINARIES_DIR is required}/rootfs.ext4"' in post_image
    assert 'resize2fs -M "$rootfs_image"' in post_image
    assert "console=tty1" in post_image
    assert "fbcon=logo-count:1" in post_image
    assert "gpu_mem=32" in post_image
    assert "partition frameos" in post_image
    assert "partition assets" in post_image


def test_buildroot_expand_sd_card_service_runs_before_local_mounts():
    service = render_expand_sd_card_service()
    script = render_expand_sd_card_script()

    assert f"ExecStart={BUILDROOT_EXPAND_SD_CARD_SCRIPT_PATH}" in service
    assert "DefaultDependencies=no" in service
    assert "Before=local-fs-pre.target local-fs.target" in service
    assert "WantedBy=local-fs-pre.target" in service
    assert "ConditionPathExists=!/var/lib/frameos/sd-card-expanded" in service

    assert "FRAMEOS_EXPAND_DISK" in script
    assert "FRAMEOS_EXPAND_DRY_RUN" in script
    assert "mount -o remount,rw / 2>/dev/null || true" in script
    assert 'mkdir -p "$(dirname "$marker")" 2>/dev/null || true' in script
    assert "root_target_sectors=$((1 * 1024 * 1024 * 1024 / sector_size))" in script
    assert "small_card_threshold_sectors=$((4 * 1024 * 1024 * 1024 / sector_size))" in script
    assert "small_frameos_sectors=$((1 * 1024 * 1024 * 1024 / sector_size))" in script
    assert "large_frameos_sectors=$((2 * 1024 * 1024 * 1024 / sector_size))" in script
    assert "chunk_sectors=$((4 * 1024 * 1024 / sector_size))" in script
    assert 'move_partition_data "FRAMEOS" "$p3_start" "$frameos_start" "$p3_size"' in script
    assert 'echo "New root start/size: $p2_start/$target_root_size sectors"' in script
    assert '$(partition_device "$disk" 2) : start= $p2_start, size= $target_root_size, type=83' in script
    assert '$(partition_device "$disk" 3) : start= $frameos_start, size= $target_frameos_size, type=83' in script
    assert 'assets_label()' in script
    assert 'if [ "$(assets_label)" != "ASSETS" ]; then' in script
    assert 'echo "Formatting missing ASSETS filesystem on $assets_dev"' in script
    assert 'mkfs.vfat -n ASSETS "$assets_dev"' in script
    assert 'resize2fs "$root_dev"' in script
    assert 'resize2fs "$frameos_dev"' in script
    assert 'date -u > "$marker" 2>/dev/null || true' in script
    assert 'sfdisk --no-reread --force "$disk"' in script
    assert 'partx -u "$disk"' in script


def test_buildroot_sd_image_stages_local_fonts_into_assets_partition(tmp_path, monkeypatch):
    local_fonts = tmp_path / "local-fonts"
    local_fonts.mkdir()
    (local_fonts / "FrameOSFont.ttf").write_bytes(b"font")
    (local_fonts / "README.md").write_text("fonts\n", encoding="utf-8")
    (local_fonts / "ignore.otf").write_bytes(b"ignored")
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_LOCAL_FONTS_DIR", local_fonts)

    frame = SimpleNamespace(id=1, project_id=1, upload_fonts="")
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)
    assets_dir = tmp_path / "overlay" / "srv" / "assets"

    builder._stage_font_assets(assets_dir)

    assert (assets_dir / "fonts" / "FrameOSFont.ttf").read_bytes() == b"font"
    assert (assets_dir / "fonts" / "README.md").read_text(encoding="utf-8") == "fonts\n"
    assert not (assets_dir / "fonts" / "ignore.otf").exists()


def test_buildroot_sd_image_stages_custom_font_assets(tmp_path, monkeypatch):
    local_fonts = tmp_path / "local-fonts"
    local_fonts.mkdir()
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_LOCAL_FONTS_DIR", local_fonts)

    custom_font = Assets(project_id=4, path="fonts/custom/Nice.ttf", data=b"custom-font")

    class FakeQuery:
        def filter(self, *_args):
            return self

        def all(self):
            return [custom_font]

    class FakeDb:
        def query(self, model):
            assert model is Assets
            return FakeQuery()

    frame = SimpleNamespace(id=1, project_id=4, upload_fonts="")
    builder = BuildrootImageBuilder(db=FakeDb(), redis=None, frame=frame)
    assets_dir = tmp_path / "overlay" / "srv" / "assets"

    builder._stage_font_assets(assets_dir)

    assert (assets_dir / "fonts" / "custom" / "Nice.ttf").read_bytes() == b"custom-font"


def test_buildroot_sd_image_respects_upload_fonts_none(tmp_path, monkeypatch):
    local_fonts = tmp_path / "local-fonts"
    local_fonts.mkdir()
    (local_fonts / "FrameOSFont.ttf").write_bytes(b"font")
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_LOCAL_FONTS_DIR", local_fonts)

    frame = SimpleNamespace(id=1, project_id=1, upload_fonts="none")
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)
    assets_dir = tmp_path / "overlay" / "srv" / "assets"

    builder._stage_font_assets(assets_dir)

    assert not (assets_dir / "fonts").exists()


def test_base_bootstrap_overlay_installs_expand_sd_card_service(tmp_path, monkeypatch):
    module_path = REPO_ROOT / "tools" / "buildroot-images" / "buildroot_images.py"
    spec = importlib.util.spec_from_file_location("buildroot_images_tool", module_path)
    assert spec and spec.loader
    buildroot_images = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = buildroot_images
    spec.loader.exec_module(buildroot_images)

    overlay = tmp_path / "overlay"

    buildroot_images.write_base_bootstrap_overlay(overlay)

    service_path = overlay / "etc" / "systemd" / "system" / BUILDROOT_EXPAND_SD_CARD_SERVICE_NAME
    service_link = (
        overlay
        / "etc"
        / "systemd"
        / "system"
        / "local-fs-pre.target.wants"
        / BUILDROOT_EXPAND_SD_CARD_SERVICE_NAME
    )
    script_path = overlay / BUILDROOT_EXPAND_SD_CARD_SCRIPT_PATH.lstrip("/")

    assert service_path.read_text(encoding="utf-8") == render_expand_sd_card_service()
    assert service_link.is_symlink()
    assert service_link.readlink().as_posix() == f"../{BUILDROOT_EXPAND_SD_CARD_SERVICE_NAME}"
    assert script_path.read_text(encoding="utf-8") == render_expand_sd_card_script()
    assert oct(script_path.stat().st_mode & 0o777) == "0o755"
    assert (overlay / BUILDROOT_NETWORK_MANAGER_CONNECTIONS_DIR.lstrip("/")).is_dir()
    nm_state_dir = overlay / BUILDROOT_NETWORK_MANAGER_STATE_CONNECTIONS_DIR.lstrip("/")
    assert nm_state_dir.is_dir()
    assert oct(nm_state_dir.stat().st_mode & 0o777) == "0o700"
    assert (overlay / BUILDROOT_WPA_SUPPLICANT_DIR.lstrip("/")).is_dir()
    wpa_state_dir = overlay / BUILDROOT_WPA_SUPPLICANT_STATE_DIR.lstrip("/")
    assert wpa_state_dir.is_dir()
    assert oct(wpa_state_dir.stat().st_mode & 0o777) == "0o700"
    fstab_text = (overlay / "etc" / "fstab").read_text(encoding="utf-8")
    assert BUILDROOT_NETWORK_MANAGER_CONNECTIONS_FSTAB_LINE in fstab_text
    assert BUILDROOT_WPA_SUPPLICANT_FSTAB_LINE in fstab_text
    # /boot must be root-only: it can hold one-time provisioning secrets.
    assert "LABEL=BOOT /boot vfat defaults,noatime,umask=077 0 0" in fstab_text
    assert "umask=000 0 0\nLABEL=FRAMEOS" not in fstab_text
    multi_user_wants = overlay / "etc" / "systemd" / "system" / "multi-user.target.wants"
    for service in ("dcron.service", "systemd-timesyncd.service"):
        link = multi_user_wants / service
        assert link.is_symlink()
        assert link.readlink().as_posix() == f"/usr/lib/systemd/system/{service}"


def test_partition_post_build_script_mounts_boot_root_only():
    script = buildroot_image_module.PARTITION_POST_BUILD_SCRIPT
    assert "LABEL=BOOT /boot vfat defaults,noatime,umask=077 0 0" in script
    assert "LABEL=BOOT /boot vfat defaults,noatime,umask=000 0 0" not in script
    assert buildroot_image_module.BUILDROOT_NETWORK_MANAGER_CONNECTIONS_FSTAB_LINE in script


def test_buildroot_boot_logo_is_staged_for_kernel_custom_logo(tmp_path):
    logo_path = tmp_path / "frameos-boot-logo.png"

    BuildrootImageBuilder._write_boot_logo(logo_path)

    assert logo_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_precompiled_buildroot_sd_image_release_url_uses_release_image_name(monkeypatch):
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_PRECOMPILED_SD_IMAGE_RELEASE_BASE_URL", "https://example.test/releases")
    monkeypatch.setattr(buildroot_image_module, "release_version", lambda: "2026.6.3")

    assert precompiled_buildroot_sd_image_release_url("raspberry-pi-zero-2-w") == (
        "https://example.test/releases/v2026.6.3/"
        "frameos-2026.6.3-raspberry-pi-zero-2-w-buildroot.img.gz"
    )


def test_precompiled_sd_image_status_does_not_require_cached_base_metadata(tmp_path):
    image_path = tmp_path / "frameos.img.gz"
    image_path.write_bytes(b"image")
    frame = SimpleNamespace(
        mode="buildroot",
        buildroot={
            "compilationMode": "precompiled",
            "sdImage": {
                "status": "ready",
                "path": str(image_path),
                "compilationMode": "precompiled",
                "customizationVersion": buildroot_image_module.BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
                "frameosVersion": buildroot_image_module.current_frameos_version(),
                "precompiledSdImage": {
                    "releaseUrl": "https://example.test/releases/v2026.6.3/frameos.img.gz",
                    "cacheHit": False,
                },
            },
        },
        scenes=[],
    )

    sd_image = buildroot_image_module.latest_buildroot_sd_image(
        frame,
        {
            "object_key": "buildroot-images/new-base.img.gz",
            "sha256": "new-base-sha256",
        },
    )

    assert sd_image is not None
    assert sd_image["status"] == "ready"


def test_precompiled_sd_image_goes_stale_when_release_version_moves_on(tmp_path):
    # A precompiled SD image embeds the release binaries pinned by
    # versions.json at build time. After the backend updates to a newer
    # release, the old image must not keep advertising itself as "ready" —
    # flashing it would boot outdated (possibly broken) binaries.
    image_path = tmp_path / "frameos.img.gz"
    image_path.write_bytes(b"image")
    frame = SimpleNamespace(
        mode="buildroot",
        buildroot={
            "compilationMode": "precompiled",
            "sdImage": {
                "status": "ready",
                "path": str(image_path),
                "compilationMode": "precompiled",
                "customizationVersion": buildroot_image_module.BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
                "frameosVersion": "2026.8.0",
                "precompiledSdImage": {
                    "releaseUrl": "https://example.test/releases/v2026.8.0/frameos.img.gz",
                    "cacheHit": False,
                },
            },
        },
        scenes=[],
    )

    current = buildroot_image_module.current_frameos_version()
    assert current != "2026.8.0"

    sd_image = buildroot_image_module.latest_buildroot_sd_image(frame)

    assert sd_image is not None
    assert sd_image["status"] == "stale"
    assert "2026.8.0" in sd_image["error"]


def test_base_composed_sd_image_is_not_marked_stale_by_version_pin(tmp_path):
    # Images composed from a Buildroot base plus a locally built binary are
    # governed by the base-image staleness check, not the precompiled release
    # pin: a locally built binary is not tied to versions.json.
    image_path = tmp_path / "frameos.img.gz"
    image_path.write_bytes(b"image")
    frame = SimpleNamespace(
        mode="buildroot",
        buildroot={
            "compilationMode": "shared",
            "sdImage": {
                "status": "ready",
                "path": str(image_path),
                "compilationMode": "shared",
                "customizationVersion": buildroot_image_module.BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
                "frameosVersion": "2026.8.0",
                "baseImage": {
                    "objectKey": "buildroot-images/base.img.gz",
                    "sha256": "base-sha256",
                },
            },
        },
        scenes=[],
    )

    sd_image = buildroot_image_module.latest_buildroot_sd_image(
        frame,
        {
            "object_key": "buildroot-images/base.img.gz",
            "sha256": "base-sha256",
        },
    )

    assert sd_image is not None
    assert sd_image["status"] == "ready"


@pytest.mark.asyncio
async def test_buildroot_run_allows_precompiled_sd_image_without_build_environment(monkeypatch):
    frame = SimpleNamespace(
        id=1,
        project_id=7,
        mode="buildroot",
        buildroot={"compilationMode": "precompiled"},
        scenes=[{"id": "scene-1", "settings": {"execution": "interpreted"}}],
    )
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)

    async def fake_run_with_context():
        return {"status": "ready"}

    monkeypatch.setattr(
        buildroot_image_module,
        "_get_frame_settings",
        lambda _db, _frame: {"buildEnvironment": {"provider": "none"}},
    )
    monkeypatch.setattr(builder, "_run_with_context", fake_run_with_context)

    assert await builder.run() == {"status": "ready"}
    assert builder.build_environment_provider == "none"


@pytest.mark.asyncio
async def test_buildroot_run_hassio_precompiled_uses_container_even_with_build_host(monkeypatch):
    monkeypatch.setenv("HASSIO_RUN_MODE", "ingress")
    frame = SimpleNamespace(
        id=1,
        project_id=7,
        mode="buildroot",
        buildroot={"compilationMode": "precompiled"},
        scenes=[{"id": "scene-1", "settings": {"execution": "interpreted"}}],
    )
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)

    async def fake_run_with_context():
        assert builder.build_environment_provider == "none"
        assert builder.build_executor_config is None
        assert builder.executor is not None
        assert builder.executor.uses_local_filesystem is True
        return {"status": "ready"}

    def fail_selected_build_executor():
        raise AssertionError("precompiled Home Assistant SD image customization should not select a build host")

    monkeypatch.setattr(
        buildroot_image_module,
        "_get_frame_settings",
        lambda _db, _frame: {
            "buildEnvironment": {"provider": "buildHost"},
            "buildHost": {
                "enabled": True,
                "host": "builder.local",
                "user": "ubuntu",
                "sshKey": "dummy-key",
            },
        },
    )
    monkeypatch.setattr(builder, "_selected_build_executor", fail_selected_build_executor)
    monkeypatch.setattr(builder, "_run_with_context", fake_run_with_context)

    assert await builder.run() == {"status": "ready"}


@pytest.mark.asyncio
async def test_precompiled_sd_image_patch_uses_local_image_tools_without_docker(monkeypatch):
    builder = BuildrootImageBuilder(db=None, redis=None, frame=SimpleNamespace(id=1))
    builder.build_environment_provider = "docker"
    builder.executor = SimpleNamespace(uses_local_filesystem=True)

    async def fail_compose_tools_image():
        raise AssertionError("precompiled SD image patch should not require Docker when local image tools are available")

    monkeypatch.setattr(builder, "_host_has_boot_patch_tools", lambda: True)
    monkeypatch.setattr(builder, "_compose_tools_image", fail_compose_tools_image)

    assert await builder._precompiled_sd_image_patch_image() is None


@pytest.mark.asyncio
async def test_buildroot_run_rejects_source_sd_image_without_build_environment(monkeypatch):
    frame = SimpleNamespace(
        id=1,
        project_id=7,
        mode="buildroot",
        buildroot={"compilationMode": "static"},
        scenes=[],
    )
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)

    monkeypatch.setattr(
        buildroot_image_module,
        "_get_frame_settings",
        lambda _db, _frame: {"buildEnvironment": {"provider": "none"}},
    )

    with pytest.raises(RuntimeError, match="precompiled Buildroot SD image mode"):
        await builder.run()


def test_buildroot_no_build_environment_message_mentions_hassio_container(monkeypatch):
    monkeypatch.setenv("HASSIO_RUN_MODE", "ingress")

    message = buildroot_image_module.buildroot_sd_image_no_build_environment_message(
        "precompiled Buildroot SD image mode with no compiled scenes"
    )

    assert "Home Assistant add-on" in message
    assert "existing add-on container" in message
    assert "Docker" not in message


@pytest.mark.asyncio
async def test_precompiled_sd_image_shortcut_patches_root_and_boot_only(tmp_path, monkeypatch):
    frame_data = {
        "id": 42,
        "project_id": 7,
        "mode": "buildroot",
        "frame_host": "Kitchen Frame.local",
        "network": {},
        "buildroot": {
            "platform": "raspberry-pi-zero-2-w",
            "compilationMode": "precompiled",
        },
        "scenes": [],
        "gpio_buttons": [],
        "schedule": None,
        "device": "web_only",
        "device_config": {},
        "ssh_keys": [],
        "upload_fonts": None,
    }
    frame = SimpleNamespace(**frame_data)
    frame.to_dict = lambda: dict(frame_data)
    release_archive = tmp_path / "release.img.gz"
    release_archive.write_bytes(gzip.compress(b"release-image", mtime=0))
    output_image = tmp_path / "output.img"
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)
    commands: list[str] = []
    logs: list[tuple[str, str]] = []
    captured: dict[str, str] = {}

    async def fake_download_precompiled_buildroot_sd_image(**_kwargs):
        return PrecompiledBuildrootSdImageResult(
            release_url="https://example.test/releases/v2026.6.3/frameos.img.gz",
            archive_path=release_archive,
            cache_hit=True,
        )

    async def fake_exec_local_command(*args, **kwargs):
        command = args[0]
        commands.append(command)
        if "patch-root.sh" in command:
            captured["root_patch_script"] = (tmp_path / ".output-root-patch" / "patch-root.sh").read_text(
                encoding="utf-8"
            )
        if "patch-boot.sh" in command:
            captured["boot_patch_script"] = (tmp_path / "tmp" / "precompiled-compose" / "patch-boot.sh").read_text(
                encoding="utf-8"
            )
        return 0, "", ""

    builder.executor = SimpleNamespace(run=fake_exec_local_command)

    async def fake_log(level, message):
        logs.append((level, message))

    def fail_replace_partition(*_args, **_kwargs):
        raise AssertionError("precompiled SD image shortcut must not replace non-BOOT partitions")

    temp_dir = tmp_path / "tmp"
    temp_dir.mkdir()
    monkeypatch.setattr(
        "app.tasks.buildroot_image.download_precompiled_buildroot_sd_image",
        fake_download_precompiled_buildroot_sd_image,
    )
    monkeypatch.setattr(
        "app.tasks.buildroot_image._mbr_partitions",
        lambda _path: [
            {"start": 512, "size": 32 * 1024 * 1024},
            {"start": 33554944, "size": 768 * 1024 * 1024},
            {"start": 838861312, "size": 30 * 1024 * 1024},
            {"start": 870318080, "size": 30 * 1024 * 1024},
        ],
    )
    monkeypatch.setattr("app.tasks.buildroot_image._replace_partition", fail_replace_partition)
    monkeypatch.setattr(builder, "_log", fake_log)

    result = await builder._try_compose_precompiled_sd_image(
        temp_dir=temp_dir,
        output_path=output_image,
        bootstrap_frame=builder._buildroot_bootstrap_frame(),
        setup_payload={"frame": "config"},
        image=None,
    )

    assert result is not None
    assert result.cache_hit is True
    assert output_image.read_bytes() == b"release-image"
    assert len(commands) == 2
    assert "patch-root.sh" in commands[0]
    assert "patch-boot.sh" in commands[1]
    assert all("compose-partitions.sh" not in command for command in commands)
    assert "write $service_root/etc/systemd/system/frameos.service /etc/systemd/system/frameos.service" in captured[
        "root_patch_script"
    ]
    assert "symlink /etc/systemd/system/multi-user.target.wants/frameos.service ../frameos.service" in captured[
        "root_patch_script"
    ]
    assert "write $service_root/etc/hostname /etc/hostname" in captured["root_patch_script"]
    # Older cached base images get the current first-boot script/unit and
    # fstab (root-only /boot) patched into their root partition.
    assert (
        "write $service_root/usr/local/bin/frameos-setup-reset.sh /usr/local/bin/frameos-setup-reset.sh"
        in captured["root_patch_script"]
    )
    assert "sif /usr/local/bin/frameos-setup-reset.sh mode 0100755" in captured["root_patch_script"]
    assert (
        "write $service_root/etc/systemd/system/frameos-firstboot-setup.service "
        "/etc/systemd/system/frameos-firstboot-setup.service"
    ) in captured["root_patch_script"]
    assert (
        "symlink /etc/systemd/system/multi-user.target.wants/frameos-firstboot-setup.service "
        "../frameos-firstboot-setup.service"
    ) in captured["root_patch_script"]
    assert "write $service_root/etc/fstab /etc/fstab" in captured["root_patch_script"]
    assert "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin" in captured["root_patch_script"]
    assert "c91cd2804cf7463aab913e7247c176049f16bbd6" in captured["root_patch_script"]
    boot_root = temp_dir / "overlay" / "boot"
    assert (boot_root / "frameos-setup.json").is_file()
    assert (boot_root / "frameos-hostname").read_text(encoding="utf-8") == "kitchen-frame\n"
    assert not (boot_root / "frameos-wifi.nmconnection").exists()
    assert "managed_boot_files=(" in captured["boot_patch_script"]
    assert "frameos-wifi.nmconnection" in captured["boot_patch_script"]
    # Self-hosted personalization clears any stale cloud personalization file
    # (backend-managed frames must not carry the release placeholder).
    assert "frameos-cloud.txt" in captured["boot_patch_script"]
    assert 'mdel -i "$target"' in captured["boot_patch_script"]
    # Release placeholders are copied first (contiguity for the in-browser
    # in-place patcher) and excluded from the later bulk copy.
    assert 'if [ -f "$boot_root/frameos-cloud.txt" ]' in captured["boot_patch_script"]
    assert "! -name frameos-cloud.txt" in captured["boot_patch_script"]
    # The script is built by f-string interpolation, so a stray brace turns it
    # into a syntax error only the frame owner would ever see.
    script_file = tmp_path / "tmp" / "precompiled-compose" / "patch-boot.sh"
    assert subprocess.run(["bash", "-n", str(script_file)]).returncode == 0
    # A stalled boot patch is diagnosed from the log alone, so every step has
    # to announce itself rather than leaving a silent gap.
    assert 'step "labelling BOOT partition' in captured["boot_patch_script"]
    assert 'step "copying boot overlay files"' in captured["boot_patch_script"]
    assert 'step "mtools missing, installing it with apt"' in captured["boot_patch_script"]


@pytest.mark.asyncio
async def test_precompiled_sd_image_shortcut_does_not_fallback_when_disabled(tmp_path, monkeypatch):
    frame = SimpleNamespace(
        id=42,
        project_id=7,
        mode="buildroot",
        buildroot={"platform": "raspberry-pi-zero-2-w", "compilationMode": "precompiled"},
        scenes=[],
    )
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)
    logs: list[tuple[str, str]] = []

    async def fake_download_precompiled_buildroot_sd_image(**_kwargs):
        return PrecompiledBuildrootSdImageResult(
            release_url="https://example.test/releases/v2026.6.3/frameos.img.gz",
            archive_path=tmp_path / "release.img.gz",
            cache_hit=False,
        )

    def fake_stage_boot_overlay(*, overlay_dir, **_kwargs):
        (overlay_dir / "boot").mkdir(parents=True)

    async def fake_compose_sd_image_from_precompiled_release(**_kwargs):
        raise RuntimeError("mtools unavailable")

    async def fake_log(level, message):
        logs.append((level, message))

    monkeypatch.setattr(
        "app.tasks.buildroot_image.download_precompiled_buildroot_sd_image",
        fake_download_precompiled_buildroot_sd_image,
    )
    monkeypatch.setattr(builder, "_stage_boot_overlay", fake_stage_boot_overlay)
    monkeypatch.setattr(
        builder,
        "_compose_sd_image_from_precompiled_release",
        fake_compose_sd_image_from_precompiled_release,
    )
    monkeypatch.setattr(builder, "_log", fake_log)

    with pytest.raises(RuntimeError, match="Could not customize full precompiled Buildroot SD image release"):
        await builder._try_compose_precompiled_sd_image(
            temp_dir=tmp_path / "tmp",
            output_path=tmp_path / "output.img",
            bootstrap_frame=SimpleNamespace(),
            setup_payload={},
            image=None,
            allow_fallback=False,
        )

    assert not any("Falling back to composed image" in message for _level, message in logs)


def _write_test_mbr(path: Path, partitions: list[tuple[int, int]]) -> None:
    mbr = bytearray(512)
    mbr[510:512] = b"\x55\xaa"
    for index, (start, size) in enumerate(partitions):
        entry = 446 + index * 16
        mbr[entry] = 0x80 if index == 0 else 0
        mbr[entry + 4] = 0x0C if index in (0, 3) else 0x83
        mbr[entry + 8 : entry + 12] = (start // 512).to_bytes(4, "little")
        mbr[entry + 12 : entry + 16] = (size // 512).to_bytes(4, "little")
    path.write_bytes(bytes(mbr))


def test_shrink_data_partitions_rewrites_mbr_and_truncates_image(tmp_path):
    image = tmp_path / "base.img"
    frameos = tmp_path / "frameos.ext4"
    assets = tmp_path / "assets.vfat"
    partitions = [
        (512, 32 * 1024 * 1024),
        (32 * 1024 * 1024 + 512, 160 * 1024 * 1024),
        (192 * 1024 * 1024 + 512, 100 * 1024 * 1024),
        (292 * 1024 * 1024 + 512, 100 * 1024 * 1024),
    ]
    _write_test_mbr(image, partitions)
    with image.open("r+b") as image_file:
        image_file.truncate(partitions[-1][0] + partitions[-1][1])
    frameos.write_bytes(b"\0" * (30 * 1024 * 1024))
    assets.write_bytes(b"\0" * (30 * 1024 * 1024))

    shrunk = buildroot_image_module._shrink_data_partitions(
        image,
        buildroot_image_module._mbr_partitions(image),
        frameos_image=frameos,
        assets_image=assets,
    )

    assert shrunk[2] == {"start": partitions[2][0], "size": 30 * 1024 * 1024}
    expected_assets_start = buildroot_image_module._align_up_bytes(partitions[2][0] + 30 * 1024 * 1024)
    assert shrunk[3] == {
        "start": expected_assets_start,
        "size": 30 * 1024 * 1024,
    }
    assert image.stat().st_size == shrunk[3]["start"] + shrunk[3]["size"]


def test_shrink_data_partitions_can_grow_trailing_data_partitions(tmp_path):
    image = tmp_path / "base.img"
    frameos = tmp_path / "frameos.ext4"
    assets = tmp_path / "assets.vfat"
    partitions = [
        (512, 32 * 1024 * 1024),
        (32 * 1024 * 1024 + 512, 160 * 1024 * 1024),
        (192 * 1024 * 1024 + 512, 30 * 1024 * 1024),
        (222 * 1024 * 1024 + 512, 30 * 1024 * 1024),
    ]
    _write_test_mbr(image, partitions)
    with image.open("r+b") as image_file:
        image_file.truncate(partitions[-1][0] + partitions[-1][1])
    frameos.write_bytes(b"\0" * (70 * 1024 * 1024))
    assets.write_bytes(b"\0" * (30 * 1024 * 1024))

    grown = buildroot_image_module._shrink_data_partitions(
        image,
        buildroot_image_module._mbr_partitions(image),
        frameos_image=frameos,
        assets_image=assets,
    )

    assert grown[2] == {"start": partitions[2][0], "size": 70 * 1024 * 1024}
    expected_assets_start = buildroot_image_module._align_up_bytes(partitions[2][0] + 70 * 1024 * 1024)
    assert grown[3] == {
        "start": expected_assets_start,
        "size": 30 * 1024 * 1024,
    }
    assert image.stat().st_size == grown[3]["start"] + grown[3]["size"]


def test_partition_size_for_root_grows_with_payload_size(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    payload = root / "payload.bin"
    with payload.open("wb") as handle:
        handle.truncate(40 * 1024 * 1024)

    assert buildroot_image_module._partition_size_for_root(root, minimum_size="30M") == "58M"


@pytest.mark.asyncio
async def test_precompiled_sd_image_accepts_larger_data_partitions(tmp_path, monkeypatch):
    release_image = tmp_path / "release.img"
    output_image = tmp_path / "output.img"
    boot_overlay = tmp_path / "tmp" / "overlay" / "boot"
    boot_overlay.mkdir(parents=True)
    (boot_overlay / "frameos-setup.json").write_text("{}", encoding="utf-8")
    partitions = [
        (512, 32 * 1024 * 1024),
        (32 * 1024 * 1024 + 512, 160 * 1024 * 1024),
        (192 * 1024 * 1024 + 512, 100 * 1024 * 1024),
        (292 * 1024 * 1024 + 512, 100 * 1024 * 1024),
    ]
    _write_test_mbr(release_image, partitions)
    with release_image.open("r+b") as image_file:
        image_file.truncate(partitions[-1][0] + partitions[-1][1])

    builder = BuildrootImageBuilder(db=object(), redis=None, frame=SimpleNamespace(id=1))
    patched: dict[str, Any] = {}

    async def fake_log(*args, **kwargs):
        return None

    async def fake_patch_boot_partition(output_path_arg, partitions_arg, boot_root_arg, *, image):
        patched["output_path"] = output_path_arg
        patched["partitions"] = partitions_arg
        patched["boot_root"] = boot_root_arg
        patched["image"] = image

    async def fake_patch_root_partition(output_path_arg, partitions_arg, *, image):
        patched["root_output_path"] = output_path_arg
        patched["root_partitions"] = partitions_arg
        patched["root_image"] = image

    monkeypatch.setattr(builder, "_log", fake_log)
    monkeypatch.setattr(builder, "_patch_root_partition", fake_patch_root_partition)
    monkeypatch.setattr(builder, "_patch_boot_partition", fake_patch_boot_partition)

    await builder._compose_sd_image_from_precompiled_release(
        temp_dir=tmp_path / "tmp",
        release_image_path=release_image,
        output_path=output_image,
        image=None,
    )

    assert output_image.read_bytes() == release_image.read_bytes()
    assert patched["root_output_path"] == output_image
    assert patched["root_image"] is None
    assert patched["root_partitions"][1] == {"start": partitions[1][0], "size": partitions[1][1]}
    assert patched["output_path"] == output_image
    assert patched["boot_root"] == tmp_path / "tmp" / "precompiled-compose" / "roots" / "boot"
    assert patched["image"] is None
    assert patched["partitions"][2] == {"start": partitions[2][0], "size": partitions[2][1]}
    assert patched["partitions"][3] == {"start": partitions[3][0], "size": partitions[3][1]}


@pytest.mark.asyncio
async def test_buildroot_docker_run_raises_nofile_limit(tmp_path, monkeypatch):
    temp_dir = tmp_path / "tmp"
    artifact_dir = tmp_path / "artifacts"
    cache_dir = tmp_path / "cache"
    source_dir = tmp_path / "source"
    output_dir = tmp_path / "output"
    for path in (temp_dir, artifact_dir, cache_dir, source_dir, output_dir):
        path.mkdir(parents=True)

    builder = BuildrootImageBuilder(db=object(), redis=None, frame=SimpleNamespace(id=1))
    captured = {}

    async def fake_docker_run(**kwargs):
        captured.update(kwargs)
        return 0, "", ""

    async def fake_log(*args, **kwargs):
        return None

    builder.executor = SimpleNamespace(docker_run=fake_docker_run)
    monkeypatch.setattr(builder, "_log", fake_log)

    await builder._run_buildroot(
        temp_dir,
        artifact_dir,
        cache_dir,
        source_dir,
        output_dir,
        image="frameos/frameos-buildroot:test",
        skip_apt_install=True,
    )

    assert captured["ulimits"] == ["nofile=65535:65535"]


@pytest.mark.asyncio
async def test_buildroot_image_selection_allows_build_host(monkeypatch):
    commands: list[str] = []

    class FakeExecutor:
        uses_container_images_directly = False

        async def run(self, command, **_kwargs):
            commands.append(command)
            return 0, "", ""

    frame = SimpleNamespace(id=1, project_id=7)
    builder = BuildrootImageBuilder(db=object(), redis=None, frame=frame)
    builder.executor = FakeExecutor()

    monkeypatch.setattr(
        "app.tasks.buildroot_image.get_settings_dict",
        lambda _db, project_id=None: {"buildEnvironment": {"provider": "buildHost"}},
    )

    image = await builder._ensure_buildroot_image()

    assert image
    assert any(command.startswith("docker image inspect ") for command in commands)
    assert any("command -v genimage" in command for command in commands)


@pytest.mark.asyncio
async def test_cached_base_composer_uses_container_visible_srcpaths(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    temp_dir = tmp_path / "tmp"
    frameos_overlay = temp_dir / "overlay" / "srv" / "frameos"
    assets_overlay = temp_dir / "overlay" / "srv" / "assets"
    boot_overlay = temp_dir / "overlay" / "boot"
    root_overlay = frameos_overlay / "bootstrap" / "root"
    frameos_overlay.mkdir(parents=True)
    assets_overlay.mkdir(parents=True)
    boot_overlay.mkdir(parents=True)
    root_overlay.mkdir(parents=True)
    (frameos_overlay / "frameos").write_bytes(b"binary")
    (boot_overlay / "frameos-setup.json").write_text("{}", encoding="utf-8")
    (root_overlay / "etc").mkdir(parents=True)
    base_image = tmp_path / "base.img"
    output_dir = Path("release-assets")
    output_dir.mkdir()
    output_image = output_dir / "output.img"
    base_image.write_bytes(b"base")
    captured: dict[str, str] = {}
    commands: list[str] = []
    replaced: list[tuple[int, str]] = []
    builder = BuildrootImageBuilder(db=object(), redis=None, frame=SimpleNamespace(id=1))

    async def fake_docker_run(**kwargs):
        commands.append(kwargs["workspace"])
        if kwargs["workspace"] == "compose":
            captured["compose"] = kwargs
            config = temp_dir / "compose" / "frameos-genimage.cfg"
            captured["config"] = config.read_text(encoding="utf-8")
            images_dir = temp_dir / "compose" / "images"
            (images_dir / "frameos.ext4").write_bytes(b"frameos")
            (images_dir / "assets.vfat").write_bytes(b"assets")
        if kwargs["workspace"] == "boot-patch":
            captured["patch"] = kwargs
            captured["patch_script"] = (temp_dir / "compose" / "patch-boot.sh").read_text(encoding="utf-8")
        if kwargs["workspace"] == "root-patch":
            captured["root_patch"] = kwargs
            captured["root_patch_script"] = (output_image.parent / ".output-root-patch" / "patch-root.sh").read_text(
                encoding="utf-8"
            )
        return 0, "", ""

    async def fake_log(*args, **kwargs):
        return None

    def fake_replace_partition(_image_path, _partitions, partition_number, partition_image):
        replaced.append((partition_number, partition_image.name))

    def fake_shrink_data_partitions(_image_path, partitions, **_kwargs):
        return partitions

    builder.executor = SimpleNamespace(docker_run=fake_docker_run)
    def fake_partition_size_for_root(root, *, minimum_size):
        assert minimum_size == "30M"
        return {"frameos": "42M", "assets": "58M"}[root.name]

    monkeypatch.setattr("app.tasks.buildroot_image._partition_size_for_root", fake_partition_size_for_root)
    monkeypatch.setattr(
        "app.tasks.buildroot_image._mbr_partitions",
        lambda _path: [
            {"start": 512, "size": 32 * 1024 * 1024},
            {"start": 33554944, "size": 768 * 1024 * 1024},
            {"start": 838861312, "size": 512 * 1024 * 1024},
            {"start": 1375732224, "size": 512 * 1024 * 1024},
        ],
    )
    monkeypatch.setattr("app.tasks.buildroot_image._shrink_data_partitions", fake_shrink_data_partitions)
    monkeypatch.setattr("app.tasks.buildroot_image._replace_partition", fake_replace_partition)
    monkeypatch.setattr(builder, "_log", fake_log)

    await builder._compose_sd_image_from_base(
        temp_dir=temp_dir,
        base_image_path=base_image,
        output_path=output_image,
        image="frameos/frameos-buildroot:test",
    )

    compose_root = re.search(r'srcpath = "([^"]+)/frameos"', captured["config"])
    assert compose_root
    assert compose_root.group(1).startswith("/tmp/frameos-compose-roots-")
    assert f'srcpath = "{compose_root.group(1)}/assets"' in captured["config"]
    assert f'srcpath = "{compose_root.group(1)}/rootfs"' not in captured["config"]
    assert f'srcpath = "{compose_root.group(1)}/boot"' not in captured["config"]
    assert "size = 42M" in captured["config"]
    assert "size = 58M" in captured["config"]
    assert 'label = "BOOT"' not in captured["config"]
    assert str(temp_dir) not in captured["config"]
    assert captured["compose"]["args"] == ["bash", "/work/compose-partitions.sh"]
    assert captured["root_patch"]["args"] == ["bash", "/patch-root.sh"]
    assert captured["patch"]["args"] == ["bash", "/patch-boot.sh"]
    root_patch_mounts = captured["root_patch"]["mounts"]
    assert root_patch_mounts[0].source == output_image.resolve()
    assert root_patch_mounts[0].target == "/image/output.img"
    assert root_patch_mounts[1].target == "/root-service"
    assert "write $service_root/etc/systemd/system/frameos.service /etc/systemd/system/frameos.service" in captured[
        "root_patch_script"
    ]
    assert "write $service_root/etc/hostname /etc/hostname" in captured["root_patch_script"]
    assert "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin" in captured["root_patch_script"]
    assert "c91cd2804cf7463aab913e7247c176049f16bbd6" in captured["root_patch_script"]
    patch_mounts = captured["patch"]["mounts"]
    assert patch_mounts[0].source == output_image.resolve()
    assert patch_mounts[0].target == "/image/output.img"
    assert captured["compose"]["image"] == "frameos/frameos-buildroot:test"
    assert captured["patch"]["image"] == "frameos/frameos-buildroot:test"
    assert 'tar -C "$work_dir/roots" -cf - frameos assets | tar -C "$compose_roots" -xf -' in (
        temp_dir / "compose" / "compose-partitions.sh"
    ).read_text(encoding="utf-8")
    assert "mlabel -i \"$target\" ::BOOT" in captured["patch_script"]
    assert "mcopy -i \"$target\" -o -s" in captured["patch_script"]
    assert "offset=512" in captured["patch_script"]
    assert (temp_dir / "compose" / "roots" / "assets" / "frameos-assets-placeholder").is_file()
    assert output_image.read_bytes() == b"base"
    assert replaced == [(3, "frameos.ext4"), (4, "assets.vfat")]
    assert len(commands) == 3


@pytest.mark.asyncio
async def test_cached_base_composer_runs_docker_on_build_host_paths(tmp_path, monkeypatch):
    temp_dir = tmp_path / "tmp"
    frameos_overlay = temp_dir / "overlay" / "srv" / "frameos"
    assets_overlay = temp_dir / "overlay" / "srv" / "assets"
    boot_overlay = temp_dir / "overlay" / "boot"
    frameos_overlay.mkdir(parents=True)
    assets_overlay.mkdir(parents=True)
    boot_overlay.mkdir(parents=True)
    (frameos_overlay / "frameos").write_bytes(b"binary")
    (boot_overlay / "frameos-setup.json").write_text("{}", encoding="utf-8")
    base_image = tmp_path / "base.img"
    output_image = tmp_path / "output.img"
    base_image.write_bytes(b"base")
    commands: list[str] = []
    synced_dirs: list[tuple[str, str]] = []
    downloaded_dirs: list[tuple[str, str]] = []
    synced_files: list[tuple[str, str]] = []
    downloaded_files: list[tuple[str, str]] = []
    replaced: list[tuple[int, str]] = []

    class FakeBuildHostSession:
        async def sync_dir_tarball(self, local_path, remote_path):
            synced_dirs.append((local_path, remote_path))

        async def download_dir_tarball(self, remote_path, local_path):
            downloaded_dirs.append((remote_path, local_path))
            local = Path(local_path)
            local.mkdir(parents=True, exist_ok=True)
            images = local / "images"
            images.mkdir(exist_ok=True)
            (images / "frameos.ext4").write_bytes(b"frameos")
            (images / "assets.vfat").write_bytes(b"assets")

        async def run(self, command, **_kwargs):
            commands.append(command)
            return 0, "", ""

        async def remove_path(self, _remote_path):
            return None

        async def ensure_dir(self, _remote_path):
            return None

        async def sync_file(self, local_path, remote_path):
            synced_files.append((local_path, remote_path))

        async def download_file(self, remote_path, local_path):
            downloaded_files.append((remote_path, local_path))

    builder = BuildrootImageBuilder(db=object(), redis=None, frame=SimpleNamespace(id=1))
    executor = BuildHostExecutor(
        BuildHostConfig(host="builder.local", user="ubuntu", ssh_key="dummy-key")
    )
    executor.session = FakeBuildHostSession()
    executor.remote_root = PurePosixPath("/tmp/frameos-buildroot-test")
    builder.executor = executor

    async def fake_log(*args, **kwargs):
        return None

    def fake_replace_partition(_image_path, _partitions, partition_number, partition_image):
        replaced.append((partition_number, partition_image.name))

    def fake_shrink_data_partitions(_image_path, partitions, **_kwargs):
        return partitions

    monkeypatch.setattr(
        "app.tasks.buildroot_image._mbr_partitions",
        lambda _path: [
            {"start": 512, "size": 32 * 1024 * 1024},
            {"start": 33554944, "size": 768 * 1024 * 1024},
            {"start": 838861312, "size": 512 * 1024 * 1024},
            {"start": 1375732224, "size": 512 * 1024 * 1024},
        ],
    )
    monkeypatch.setattr("app.tasks.buildroot_image._shrink_data_partitions", fake_shrink_data_partitions)
    monkeypatch.setattr("app.tasks.buildroot_image._replace_partition", fake_replace_partition)
    monkeypatch.setattr(builder, "_log", fake_log)

    await builder._compose_sd_image_from_base(
        temp_dir=temp_dir,
        base_image_path=base_image,
        output_path=output_image,
        image="frameos/frameos-buildroot:test",
    )

    assert "-v /tmp/frameos-buildroot-test/compose/mount-0-compose:/work" in commands[0]
    assert str(temp_dir / "compose") not in commands[0]
    assert synced_dirs[0] == (
        str(temp_dir / "compose"),
        "/tmp/frameos-buildroot-test/compose/mount-0-compose",
    )
    assert (
        "/tmp/frameos-buildroot-test/compose/mount-0-compose",
        str(temp_dir / "compose"),
    ) in downloaded_dirs
    assert "-v /tmp/frameos-buildroot-test/root-patch/mount-0-output.img:/image/output.img" in commands[1]
    assert "-v /tmp/frameos-buildroot-test/boot-patch/mount-0-output.img:/image/output.img" in commands[2]
    assert any(local.endswith("output.img") and remote.endswith("/boot-patch/mount-0-output.img") for local, remote in synced_files)
    assert any(
        local.endswith("patch-boot.sh") and remote.endswith("/boot-patch/mount-2-patch-boot.sh")
        for local, remote in synced_files
    )
    assert any(
        local.endswith("patch-root.sh") and remote.endswith("/root-patch/mount-2-patch-root.sh")
        for local, remote in synced_files
    )
    assert replaced == [(3, "frameos.ext4"), (4, "assets.vfat")]


@pytest.mark.asyncio
async def test_cached_base_composer_runs_without_docker_when_image_is_not_required(tmp_path, monkeypatch):
    temp_dir = tmp_path / "tmp"
    frameos_overlay = temp_dir / "overlay" / "srv" / "frameos"
    assets_overlay = temp_dir / "overlay" / "srv" / "assets"
    boot_overlay = temp_dir / "overlay" / "boot"
    frameos_overlay.mkdir(parents=True)
    assets_overlay.mkdir(parents=True)
    boot_overlay.mkdir(parents=True)
    (frameos_overlay / "frameos").write_bytes(b"binary")
    (boot_overlay / "frameos-setup.json").write_text("{}", encoding="utf-8")
    base_image = tmp_path / "base.img"
    output_image = tmp_path / "output.img"
    base_image.write_bytes(b"base")
    commands: list[str] = []
    replaced: list[tuple[int, str]] = []
    builder = BuildrootImageBuilder(db=object(), redis=None, frame=SimpleNamespace(id=1))

    async def fake_exec_local_command(*args, **kwargs):
        command = args[0]
        commands.append(command)
        if "compose-partitions.sh" in command:
            images_dir = temp_dir / "compose" / "images"
            (images_dir / "frameos.ext4").write_bytes(b"frameos")
            (images_dir / "assets.vfat").write_bytes(b"assets")
        return 0, "", ""

    async def fake_log(*args, **kwargs):
        return None

    def fake_replace_partition(_image_path, _partitions, partition_number, partition_image):
        replaced.append((partition_number, partition_image.name))

    def fake_shrink_data_partitions(_image_path, partitions, **_kwargs):
        return partitions

    builder.executor = SimpleNamespace(run=fake_exec_local_command)
    monkeypatch.setattr(
        "app.tasks.buildroot_image._mbr_partitions",
        lambda _path: [
            {"start": 512, "size": 32 * 1024 * 1024},
            {"start": 33554944, "size": 768 * 1024 * 1024},
            {"start": 838861312, "size": 512 * 1024 * 1024},
            {"start": 1375732224, "size": 512 * 1024 * 1024},
        ],
    )
    monkeypatch.setattr("app.tasks.buildroot_image._shrink_data_partitions", fake_shrink_data_partitions)
    monkeypatch.setattr("app.tasks.buildroot_image._replace_partition", fake_replace_partition)
    monkeypatch.setattr(builder, "_log", fake_log)

    await builder._compose_sd_image_from_base(
        temp_dir=temp_dir,
        base_image_path=base_image,
        output_path=output_image,
        image=None,
    )

    assert len(commands) == 3
    assert all("docker run" not in command for command in commands)
    assert commands[0].startswith("FRAMEOS_COMPOSE_WORK_DIR=")
    assert commands[1].startswith("FRAMEOS_IMAGE_DIR=")
    assert "patch-root.sh" in commands[1]
    assert commands[2].startswith("FRAMEOS_IMAGE_DIR=")
    assert "patch-boot.sh" in commands[2]
    assert output_image.read_bytes() == b"base"
    assert replaced == [(3, "frameos.ext4"), (4, "assets.vfat")]


def test_stage_buildroot_frameos_service_enables_runtime(tmp_path):
    stage_buildroot_frameos_service(tmp_path)

    service = tmp_path / "etc" / "systemd" / "system" / "frameos.service"
    wants_link = tmp_path / "etc" / "systemd" / "system" / "multi-user.target.wants" / "frameos.service"

    assert service.is_file()
    service_text = service.read_text(encoding="utf-8")
    assert "User=root" in service_text
    assert "Wants=NetworkManager.service" in service_text
    assert "After=network.target NetworkManager.service" in service_text
    assert "ExecStart=/srv/frameos/current/frameos" in service_text
    assert "Environment=FRAMEOS_HOME=/srv/frameos/current" in service_text
    assert (
        "Environment=LD_LIBRARY_PATH=/srv/frameos/current/drivers:/srv/frameos/current/scenes:/usr/lib:/usr/local/lib"
        in service_text
    )
    assert wants_link.is_symlink()
    assert wants_link.readlink().as_posix() == "../frameos.service"


def test_buildroot_service_writes_console_output_and_environment(tmp_path):
    service_path = tmp_path / "frameos.service"
    output_path = tmp_path / "rendered.service"
    service_path.write_text(
        "[Unit]\nDescription=Test\n\n[Service]\nUser=%I\nExecStart=/bin/frameos\n\n[Install]\nWantedBy=multi-user.target\n",
        encoding="utf-8",
    )

    BuildrootImageBuilder._write_service(
        service_path,
        output_path,
        user="root",
        console_output=True,
        environment={"LD_LIBRARY_PATH": "/usr/lib"},
    )
    service = output_path.read_text(encoding="utf-8")

    assert "User=root" in service
    assert "Environment=LD_LIBRARY_PATH=/usr/lib" in service
    assert "StandardOutput=journal+console" in service
    assert "StandardError=journal+console" in service
    assert "StandardInput=tty" not in service
    assert "TTYPath=/dev/tty1" not in service


def test_buildroot_output_cache_key_tracks_bootstrap_inputs(tmp_path, monkeypatch):
    overlay_dir = tmp_path / "overlay"
    overlay_dir.mkdir(parents=True)
    config_path = tmp_path / "frameos-buildroot.config"
    post_build_path = tmp_path / "post-build.sh"
    partition_post_build_path = tmp_path / "partition-post-build.sh"
    post_image_path = tmp_path / "post-image.sh"

    BuildrootImageBuilder._write_buildroot_config(config_path, RASPBERRY_PI_ZERO_2_W)
    BuildrootImageBuilder._write_post_build_script(post_build_path, RASPBERRY_PI_ZERO_2_W)
    BuildrootImageBuilder._write_partition_post_build_script(partition_post_build_path)
    BuildrootImageBuilder._write_post_image_script(post_image_path, RASPBERRY_PI_ZERO_2_W)

    builder = BuildrootImageBuilder(db=object(), redis=None, frame=SimpleNamespace(id=1))

    key_base = builder._buildroot_output_cache_key(
        "build-id",
        overlay_dir,
        config_path,
        post_build_path,
        partition_post_build_path,
        post_image_path,
        build_image="frameos/frameos-buildroot:test",
        skip_apt_install=True,
    )
    monkeypatch.setattr("app.tasks.buildroot_image.BUILDROOT_HOST_CXXFLAGS", "-std=gnu++20")
    key_modified = builder._buildroot_output_cache_key(
        "build-id",
        overlay_dir,
        config_path,
        post_build_path,
        partition_post_build_path,
        post_image_path,
        build_image="frameos/frameos-buildroot:test",
        skip_apt_install=True,
    )

    assert key_base != key_modified


def test_buildroot_writes_authorized_keys_to_boot_overlay(tmp_path, monkeypatch):
    authorized_keys = tmp_path / "boot" / "frameos-authorized_keys"
    builder = BuildrootImageBuilder(
        db=object(),
        redis=None,
        frame=SimpleNamespace(id=1, ssh_keys=["main"]),
    )

    monkeypatch.setattr(
        "app.tasks.buildroot_image.get_settings_dict",
        lambda _db, project_id=None: {
            "ssh_keys": {
                "keys": [
                    {"id": "main", "public": "ssh-ed25519 AAA-main frameos"},
                    {"id": "other", "public": "ssh-ed25519 AAA-other frameos"},
                ]
            }
        },
    )

    builder._write_boot_authorized_keys(authorized_keys)

    assert authorized_keys.read_text(encoding="utf-8") == (
        "ssh-ed25519 AAA-main frameos\n"
    )
    assert oct(authorized_keys.stat().st_mode & 0o777) == "0o600"


def test_buildroot_writes_root_password_to_boot_overlay(tmp_path):
    root_password = tmp_path / "boot" / "frameos-root-password"
    builder = BuildrootImageBuilder(
        db=object(),
        redis=None,
        frame=SimpleNamespace(id=1, ssh_pass="secret-root-password"),
    )

    builder._write_boot_root_password(root_password)

    assert root_password.read_text(encoding="utf-8") == "secret-root-password"
    assert oct(root_password.stat().st_mode & 0o777) == "0o600"


def test_buildroot_skips_empty_root_password(tmp_path):
    root_password = tmp_path / "boot" / "frameos-root-password"
    root_password.parent.mkdir(parents=True)
    root_password.write_text("old", encoding="utf-8")
    builder = BuildrootImageBuilder(
        db=object(),
        redis=None,
        frame=SimpleNamespace(id=1, ssh_pass=""),
    )

    builder._write_boot_root_password(root_password)

    assert not root_password.exists()


def test_buildroot_rejects_root_password_with_line_breaks(tmp_path):
    builder = BuildrootImageBuilder(
        db=object(),
        redis=None,
        frame=SimpleNamespace(id=1, ssh_pass="bad\npassword"),
    )

    with pytest.raises(ValueError, match="Root user password"):
        builder._write_boot_root_password(tmp_path / "frameos-root-password")


def test_buildroot_stage_overlay_leaves_service_install_to_firstboot(tmp_path, monkeypatch):
    frameos_binary = tmp_path / "frameos"
    remote_binary = tmp_path / "frameos_remote"
    frameos_binary.write_bytes(b"frameos")
    remote_binary.write_bytes(b"agent")
    frame = SimpleNamespace(
        id=1,
        frame_host="Frame One.local",
        mode="buildroot",
        network={"wifiSSID": "Test WiFi", "wifiPassword": "secret"},
        buildroot={},
        ssh_keys=[],
        scenes=[
            {"id": "scene-1", "settings": {"execution": "interpreted"}},
            {"id": "scene-2", "settings": {"execution": "compiled"}},
        ],
    )
    builder = BuildrootImageBuilder(db=object(), redis=None, frame=frame)
    bootstrap_frame = SimpleNamespace(**{**frame.__dict__, "device": "web_only", "scenes": []})
    overlay_dir = tmp_path / "overlay"

    monkeypatch.setattr("app.tasks.buildroot_image.get_frame_json", lambda _db, _frame: {"id": 1})
    monkeypatch.setattr(
        "app.tasks.buildroot_image.get_interpreted_scenes_json",
        lambda _frame: [
            scene
            for scene in getattr(_frame, "scenes", [])
            if scene.get("settings", {}).get("execution") == "interpreted"
        ],
    )
    monkeypatch.setattr("app.tasks.buildroot_image.get_settings_dict", lambda _db, project_id=None: {"ssh_keys": {"keys": []}})
    monkeypatch.setattr("app.tasks.buildroot_image.drivers_for_frame", lambda _frame: {})

    builder._stage_overlay(
        overlay_dir=overlay_dir,
        build_id="build123",
        bootstrap_frame=bootstrap_frame,
        setup_payload={"id": 1, "scenes": frame.scenes},
        frameos_build=FrameBinaryBuildResult(
            build_id="build123",
            target=FRAMEOS_BUILD_TARGET,
            compilation_mode="precompiled",
            source_dir=str(tmp_path),
            build_dir=str(tmp_path),
            archive_path=str(tmp_path / "archive.tar.gz"),
            binary_path=str(frameos_binary),
            driver_library_paths=[],
            driver_library_names=[],
            scene_library_paths=[],
            scene_library_names=[],
            cross_compiled=True,
            prebuilt_entry=None,
            prebuilt_target=None,
            log_path=None,
        ),
        remote_binary=str(remote_binary),
    )

    assert (overlay_dir / "boot" / "frameos-setup.json").exists()
    setup_payload = json.loads((overlay_dir / "boot" / "frameos-setup.json").read_text(encoding="utf-8"))
    assert setup_payload["scenes"] == frame.scenes
    release_dir = overlay_dir / "srv" / "frameos" / "releases" / "release_build123"
    scenes_payload = json.loads(gzip.decompress((release_dir / "scenes.json.gz").read_bytes()).decode("utf-8"))
    all_scenes_payload = json.loads(gzip.decompress((release_dir / "all_scenes.json.gz").read_bytes()).decode("utf-8"))
    assert scenes_payload == [frame.scenes[0]]
    assert all_scenes_payload == frame.scenes
    assert (overlay_dir / "boot" / "frameos-hostname").read_text(encoding="utf-8") == "frame-one\n"
    remote_release_dir = overlay_dir / "srv" / "frameos" / "remote" / "releases" / "release_build123"
    assert (remote_release_dir / "frame.json").read_text(encoding="utf-8") == (
        release_dir / "frame.json"
    ).read_text(encoding="utf-8")
    assert (release_dir / "frameos.service").exists()
    nm_state_dir = overlay_dir / BUILDROOT_NETWORK_MANAGER_STATE_CONNECTIONS_DIR.lstrip("/")
    assert nm_state_dir.is_dir()
    assert oct(nm_state_dir.stat().st_mode & 0o777) == "0o700"
    nm_connections_dir = overlay_dir / BUILDROOT_NETWORK_MANAGER_CONNECTIONS_DIR.lstrip("/")
    assert nm_connections_dir.is_dir()
    assert oct(nm_connections_dir.stat().st_mode & 0o777) == "0o700"
    frameos_service = (release_dir / "frameos.service").read_text(encoding="utf-8")
    assert "User=root" in frameos_service
    assert "Environment=FRAMEOS_HOME=/srv/frameos/current" in frameos_service
    assert "/srv/frameos/runtime/frameos-last-exit" in frameos_service
    assert (
        "Environment=LD_LIBRARY_PATH=/srv/frameos/current/drivers:/srv/frameos/current/scenes:/usr/lib:/usr/local/lib"
        in frameos_service
    )
    assert "StandardOutput=journal+console" not in frameos_service
    assert "StandardError=journal+console" not in frameos_service
    assert (remote_release_dir / "frameos-remote.service").exists()
    assert not (overlay_dir / "etc" / "systemd" / "system" / "frameos.service").exists()
    assert not (overlay_dir / "etc" / "systemd" / "system" / "frameos-remote.service").exists()


def test_buildroot_boot_config_merge_is_written_to_active_boot_location(tmp_path):
    builder = BuildrootImageBuilder(db=None, redis=None, frame=SimpleNamespace(id=1))
    overlay_dir = tmp_path / "overlay"
    existing_config = overlay_dir / "boot" / "config.txt"
    existing_firmware_config = overlay_dir / "boot" / "firmware" / "config.txt"
    existing_config.parent.mkdir(parents=True, exist_ok=True)
    existing_firmware_config.parent.mkdir(parents=True, exist_ok=True)
    existing_config.write_text("dtoverlay=spi1-1cs\n#dtoverlay=spi0-0cs\n", encoding="utf-8")
    existing_firmware_config.write_text("disable_splash=1\n", encoding="utf-8")

    builder._write_boot_config(
        overlay_dir,
        ["dtoverlay=spi0-0cs", "dtoverlay=spi0-1cs", "dtoverlay=spi0-0cs"],
    )

    assert "dtoverlay=spi0-0cs" in existing_config.read_text(encoding="utf-8")
    assert "dtoverlay=spi0-1cs" in existing_config.read_text(encoding="utf-8")
    assert "#dtoverlay=spi0-0cs" not in existing_config.read_text(encoding="utf-8")
    firmware_config = existing_firmware_config.read_text(encoding="utf-8")
    assert "dtoverlay=spi0-0cs" not in firmware_config
    assert "dtoverlay=spi0-1cs" not in firmware_config


def test_buildroot_boot_config_defaults_minimize_gpu_memory(monkeypatch):
    monkeypatch.setattr("app.tasks.buildroot_image.drivers_for_frame", lambda _frame: {})

    lines = _frame_boot_config_lines(SimpleNamespace(id=1))

    assert lines == list(RASPBERRY_PI_ZERO_2_W.default_boot_config_lines)
    assert "gpu_mem=32" in lines


def test_buildroot_boot_config_merge_replaces_stale_gpu_memory_lines():
    merged = _merge_boot_config_lines(
        "\n".join([
            "disable_splash=1",
            "gpu_mem=76",
            "gpu_mem_512=128",
            "dtoverlay=spi0-0cs",
            "",
        ]),
        ["gpu_mem=32"],
    )

    assert "disable_splash=1" in merged
    assert "dtoverlay=spi0-0cs" in merged
    assert "gpu_mem=32" in merged
    assert "gpu_mem=76" not in merged
    assert "gpu_mem_512=128" not in merged


def test_buildroot_bootstrap_frame_uses_web_only_and_clears_scenes():
    frame = SimpleNamespace(
        id=1,
        to_dict=lambda: {
            "id": 1,
            "name": "Frame",
            "mode": "buildroot",
            "frame_host": "frame.local",
            "frame_port": 8787,
            "frame_access_key": "abc",
            "frame_access": "private",
            "frame_admin_auth": {"enabled": False, "user": "", "pass": ""},
            "https_proxy": {"enable": False, "port": 8443, "expose_only_port": True, "certs": {}},
            "ssh_user": "root",
            "ssh_pass": None,
            "ssh_port": 22,
            "ssh_keys": [],
            "server_host": "server.local",
            "server_port": 8989,
            "server_api_key": "def",
            "server_send_logs": True,
            "status": "uninitialized",
            "archived": False,
            "version": None,
            "width": 0,
            "height": 0,
            "device": "waveshare.epd2in13_V3",
            "device_config": {},
            "color": None,
            "interval": 300,
            "metrics_interval": 60,
            "scaling_mode": "contain",
            "rotate": 0,
            "flip": None,
            "background_color": None,
            "debug": False,
            "scenes": [{"id": "scene-1"}],
            "last_log_at": None,
            "log_to_file": None,
            "assets_path": "/srv/assets",
            "save_assets": True,
            "upload_fonts": "",
            "reboot": {"enabled": "false"},
            "control_code": {"enabled": "false"},
            "schedule": {"events": [{"id": "evt-1"}]},
            "gpio_buttons": [{"pin": 5, "label": "A"}],
            "network": {"wifiSSID": "Test", "wifiPassword": "secret"},
            "agent": {"agentEnabled": True, "agentRunCommands": True, "agentSharedSecret": "secret"},
            "mountpoints": {"enabled": False, "items": []},
            "error_behavior": {"mode": "show_error_retry"},
            "palette": {},
            "buildroot": {
                "platform": "raspberry-pi-zero-2-w",
                "sdImage": {"status": "ready"},
            },
            "rpios": {"compilationMode": "precompiled"},
            "terminal_history": [],
            "apps": [],
            "image_url": None,
            "background_color": None,
            "last_successful_deploy": None,
            "last_successful_deploy_at": None,
        },
    )
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)

    bootstrap_frame = builder._buildroot_bootstrap_frame()

    assert bootstrap_frame.device == "web_only"
    assert bootstrap_frame.scenes == []
    assert bootstrap_frame.gpio_buttons == []
    assert bootstrap_frame.schedule is None
    assert bootstrap_frame.buildroot["platform"] == "raspberry-pi-zero-2-w"
    assert "sdImage" not in bootstrap_frame.buildroot


def test_buildroot_setup_payload_supports_gzip(tmp_path):
    payload = {"name": "Frame", "scenes": []}
    output_path = tmp_path / "boot" / "frameos-setup.json.gz"

    BuildrootImageBuilder._write_setup_payload(output_path, payload)

    decoded = gzip.decompress(output_path.read_bytes()).decode("utf-8")
    assert json.loads(decoded) == payload


def test_buildroot_config_for_zero_w_selects_bootlin_armv6_toolchain(tmp_path):
    config_path = tmp_path / "frameos-buildroot.config"

    BuildrootImageBuilder._write_buildroot_config(config_path, RASPBERRY_PI_ZERO_W)
    config = config_path.read_text(encoding="utf-8")

    assert "BR2_TOOLCHAIN_EXTERNAL=y" in config
    assert "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_ARMV6_EABIHF_GLIBC_STABLE=y" in config
    assert "BR2_PACKAGE_BRCMFMAC_SDIO_FIRMWARE_RPI=y" in config


def test_buildroot_config_for_zero_w_uses_wpa_supplicant_instead_of_network_manager(tmp_path):
    """The Bootlin ARMv6 toolchain ships 4.19 kernel headers, below
    NetworkManager's `depends on BR2_TOOLCHAIN_HEADERS_AT_LEAST_4_20`, so
    Buildroot dropped it silently and the board shipped with no nmcli at all."""
    zero_w_path = tmp_path / "zero-w.config"
    zero_2_w_path = tmp_path / "zero-2-w.config"

    BuildrootImageBuilder._write_buildroot_config(zero_w_path, RASPBERRY_PI_ZERO_W)
    BuildrootImageBuilder._write_buildroot_config(zero_2_w_path, RASPBERRY_PI_ZERO_2_W)
    zero_w = zero_w_path.read_text(encoding="utf-8")
    zero_2_w = zero_2_w_path.read_text(encoding="utf-8")

    assert "BR2_PACKAGE_NETWORK_MANAGER" not in zero_w
    assert "BR2_PACKAGE_NETWORK_MANAGER=y" in zero_2_w

    # Both boards get the full wpa_supplicant/hostapd stack the portal drives.
    for config in (zero_w, zero_2_w):
        assert "BR2_PACKAGE_WPA_SUPPLICANT=y" in config
        assert "BR2_PACKAGE_WPA_SUPPLICANT_CLI=y" in config
        assert "BR2_PACKAGE_WPA_SUPPLICANT_PASSPHRASE=y" in config
        assert "BR2_PACKAGE_WPA_SUPPLICANT_NL80211=y" in config
        assert "BR2_PACKAGE_WPA_SUPPLICANT_AP_SUPPORT=y" in config
        assert "BR2_PACKAGE_HOSTAPD=y" in config
        assert "BR2_PACKAGE_DNSMASQ=y" in config
        assert "BR2_PACKAGE_IW=y" in config
        assert "BR2_PACKAGE_WIRELESS_REGDB=y" in config


def test_buildroot_build_script_uses_platform_defconfig(tmp_path):
    script_path = tmp_path / "buildroot-build.sh"

    BuildrootImageBuilder._write_build_script(script_path, "frameos-test.img", RASPBERRY_PI_ZERO_W)
    script = script_path.read_text(encoding="utf-8")

    assert "O=/build/output raspberrypi0w_defconfig" in script
    assert "raspberrypizero2w" not in script


def test_post_build_script_wifi_firmware_is_platform_specific():
    zero_2_w = render_post_build_script(RASPBERRY_PI_ZERO_2_W)
    zero_w = render_post_build_script(RASPBERRY_PI_ZERO_W)

    assert "raspberrypi,model-zero-2-w" in zero_2_w
    assert "firmware-nonfree" in zero_2_w

    # The Zero W uses the stock brcmfmac43430 firmware from linux-firmware;
    # only device-tree name symlinks are needed.
    assert "raspberrypi,model-zero-w" in zero_w
    assert "raspberrypi,model-zero-2-w" not in zero_w
    assert "firmware-nonfree" not in zero_w
    assert "brcmfmac43436-sdio.bin" not in zero_w


def test_post_image_script_keeps_gpu_memory_reserve_for_zero_w():
    post_image = render_post_image_script(RASPBERRY_PI_ZERO_W)

    assert 'line = "gpu_mem=32"' in post_image
    assert "genimage" in post_image


def test_zero_w_frame_uses_armv6_cross_target(tmp_path, monkeypatch):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))

    frame = SimpleNamespace(id=1, buildroot={"platform": "raspberry-pi-zero-w"})
    builder = BuildrootImageBuilder(db=None, redis=None, frame=frame)
    target = builder.platform.build_target_copy()

    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=frame,
        deployer=SimpleNamespace(build_id="build12345678"),
        target=target,
        temp_dir=str(tmp_path / "tmp"),
    )

    assert compiler._platform() == "linux/arm/v6"
    # No distro publishes linux/arm/v6 containers; the build must run in an
    # amd64 container with the standalone ARMv6 toolchain.
    assert compiler._container_platform() == "linux/amd64"
    toolchain = compiler._target_cross_toolchain("linux/amd64")
    assert toolchain is not None
    assert toolchain.tarball_url and "armv6-eabihf" in toolchain.tarball_url
    setup_script = compiler._target_cross_toolchain_setup_script(toolchain)
    assert "relocate-sdk.sh" in setup_script
    assert "sha256sum -c -" in setup_script
    assert 'export CC="$toolchain_root/bin/arm-buildroot-linux-gnueabihf-gcc"' in setup_script
    flags = " ".join(compiler._cpu_feature_cflags())
    assert "-march=armv6zk" in flags
    assert "-mfloat-abi=hard" in flags


def test_resolve_base_entry_falls_back_to_remote_manifest_for_missing_platform(tmp_path, monkeypatch):
    # A checked-in manifest that predates the first pi-zero-w base publish:
    # the platform must resolve via the archive manifest instead of erroring.
    local_manifest = tmp_path / "manifest.json"
    local_manifest.write_text(
        json.dumps({"entries": [{"platform": "raspberry-pi-zero-2-w", "object_key": "a", "sha256": "b"}]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_BASE_MANIFEST_FILE", str(local_manifest))

    remote_entry = {
        "platform": "raspberry-pi-zero-w",
        "frameos_version": "2026.7.6",
        "object_key": "buildroot-images/raspberry-pi-zero-w/x.img.gz",
        "sha256": "deadbeef",
    }

    async def fake_remote_manifest():
        return {"entries": [remote_entry]}

    monkeypatch.setattr(buildroot_image_module, "_remote_buildroot_base_manifest", fake_remote_manifest)

    entry = asyncio.run(buildroot_image_module.resolve_buildroot_base_entry("raspberry-pi-zero-w"))
    assert entry == remote_entry


def test_resolve_base_entry_reports_missing_platform_when_remote_also_lacks_it(tmp_path, monkeypatch):
    local_manifest = tmp_path / "manifest.json"
    local_manifest.write_text(json.dumps({"entries": []}), encoding="utf-8")
    monkeypatch.setattr(buildroot_image_module, "BUILDROOT_BASE_MANIFEST_FILE", str(local_manifest))

    async def fake_remote_manifest():
        return {"entries": []}

    monkeypatch.setattr(buildroot_image_module, "_remote_buildroot_base_manifest", fake_remote_manifest)

    with pytest.raises(RuntimeError, match="No Buildroot base image is available for raspberry-pi-zero-w"):
        asyncio.run(buildroot_image_module.resolve_buildroot_base_entry("raspberry-pi-zero-w"))


def test_frameos_service_names_network_manager_only_where_it_exists():
    # A Wants= pointing at a unit Buildroot never built logs a failed
    # dependency on every boot; armv6 runs wpa_supplicant instead.
    with_nm = render_buildroot_frameos_service(True)
    assert "Wants=NetworkManager.service" in with_nm
    assert "After=network.target NetworkManager.service" in with_nm

    without_nm = render_buildroot_frameos_service(False)
    assert "NetworkManager" not in without_nm
    assert "After=network.target" in without_nm
