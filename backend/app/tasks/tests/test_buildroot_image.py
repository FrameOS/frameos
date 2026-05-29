from __future__ import annotations

import gzip
import json
from types import SimpleNamespace

import pytest

from app.tasks.buildroot_image import (
    FRAMEOS_BUILD_TARGET,
    BuildrootImageBuilder,
    _network_manager_wifi_connection,
)
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.utils.cross_compile import CrossCompiler


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


def test_buildroot_config_avoids_ncurses_selecting_packages(tmp_path):
    config_path = tmp_path / "frameos-buildroot.config"

    BuildrootImageBuilder._write_buildroot_config(config_path)
    config = config_path.read_text(encoding="utf-8")

    assert "BR2_PACKAGE_BASH" not in config
    assert "BR2_PACKAGE_PROCPS_NG" not in config
    assert 'BR2_DL_DIR="/cache/dl"' in config
    assert "BR2_PACKAGE_DROPBEAR=y" in config
    assert "# BR2_CCACHE is not set" in config
    assert 'BR2_ROOTFS_POST_IMAGE_SCRIPT="/work/post-image.sh"' in config
    assert "/work/partition-post-build.sh" in config


def test_buildroot_script_builds_output_on_container_filesystem(tmp_path):
    script_path = tmp_path / "buildroot-build.sh"

    BuildrootImageBuilder._write_build_script(script_path, "frameos-test.img")
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
    assert "for path in /build/output/build/host-cmake-*;" in script
    assert "ulimit -n 65535" in script
    assert "dd if=/build/output/images/sdcard.img of=/artifacts/frameos-test.img" in script
    assert "O=/work/output" not in script
    assert "cp /work/output/images/sdcard.img" not in script


def test_buildroot_partition_scripts_create_frameos_and_assets_partitions(tmp_path):
    partition_post_build_path = tmp_path / "partition-post-build.sh"
    post_image_path = tmp_path / "post-image.sh"

    BuildrootImageBuilder._write_partition_post_build_script(partition_post_build_path)
    BuildrootImageBuilder._write_post_image_script(post_image_path)

    partition_post_build = partition_post_build_path.read_text(encoding="utf-8")
    post_image = post_image_path.read_text(encoding="utf-8")

    assert "LABEL=FRAMEOS /srv/frameos ext4" in partition_post_build
    assert "LABEL=ASSETS /srv/assets vfat" in partition_post_build
    assert "frameos-partition-root" in partition_post_build
    assert "assets-partition-root" in partition_post_build
    assert "image frameos.ext4" in post_image
    assert "image assets.vfat" in post_image
    assert "partition frameos" in post_image
    assert "partition assets" in post_image


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

    async def fake_exec_local_command(*args, **kwargs):
        captured["command"] = args[3]
        return 0, "", ""

    async def fake_log(*args, **kwargs):
        return None

    monkeypatch.setattr("app.tasks.buildroot_image.exec_local_command", fake_exec_local_command)
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

    assert "--ulimit nofile=65535:65535" in captured["command"]


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


def test_buildroot_output_cache_key_tracks_bootstrap_inputs(tmp_path, monkeypatch):
    overlay_dir = tmp_path / "overlay"
    overlay_dir.mkdir(parents=True)
    config_path = tmp_path / "frameos-buildroot.config"
    post_build_path = tmp_path / "post-build.sh"
    partition_post_build_path = tmp_path / "partition-post-build.sh"
    post_image_path = tmp_path / "post-image.sh"

    BuildrootImageBuilder._write_buildroot_config(config_path)
    BuildrootImageBuilder._write_post_build_script(post_build_path)
    BuildrootImageBuilder._write_partition_post_build_script(partition_post_build_path)
    BuildrootImageBuilder._write_post_image_script(post_image_path)

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


def test_buildroot_authorized_keys_enable_dropbear(tmp_path, monkeypatch):
    overlay_dir = tmp_path / "overlay"
    wants_dir = overlay_dir / "etc" / "systemd" / "system" / "multi-user.target.wants"
    wants_dir.mkdir(parents=True)
    builder = BuildrootImageBuilder(
        db=object(),
        redis=None,
        frame=SimpleNamespace(id=1, ssh_keys=["main"]),
    )

    monkeypatch.setattr(
        "app.tasks.buildroot_image.get_settings_dict",
        lambda _db: {
            "ssh_keys": {
                "keys": [
                    {"id": "main", "public": "ssh-ed25519 AAA-main frameos"},
                    {"id": "other", "public": "ssh-ed25519 AAA-other frameos"},
                ]
            }
        },
    )

    builder._write_authorized_keys(overlay_dir, wants_dir)

    assert (overlay_dir / "root" / ".ssh" / "authorized_keys").read_text(encoding="utf-8") == (
        "ssh-ed25519 AAA-main frameos\n"
    )
    assert (overlay_dir / "etc" / "default" / "dropbear").read_text(encoding="utf-8") == (
        'DROPBEAR_ARGS="-s -g"\n'
    )
    assert (wants_dir / "dropbear.service").readlink().as_posix() == "/usr/lib/systemd/system/dropbear.service"


def test_buildroot_copies_lgpio_runtime_libraries_when_required(tmp_path, monkeypatch):
    liblgpio = tmp_path / "liblgpio.so.1"
    librgpio = tmp_path / "librgpio.so.1"
    liblgpio.write_bytes(b"lgpio")
    librgpio.write_bytes(b"rgpio")
    builder = BuildrootImageBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
    )

    monkeypatch.setattr("app.tasks.buildroot_image._lgpio_runtime_library_paths", lambda: [liblgpio, librgpio])
    monkeypatch.setattr(
        "app.tasks.buildroot_image.drivers_for_frame",
        lambda _frame: {"waveshare": SimpleNamespace(link_flags=("-llgpio",))},
    )

    builder._copy_runtime_libraries(tmp_path / "overlay")

    assert (tmp_path / "overlay" / "usr" / "lib" / "liblgpio.so.1").read_bytes() == b"lgpio"
    assert (tmp_path / "overlay" / "usr" / "lib" / "librgpio.so.1").read_bytes() == b"rgpio"


def test_buildroot_boot_config_merge_is_written_to_all_boot_locations(tmp_path):
    builder = BuildrootImageBuilder(db=None, redis=None, frame=SimpleNamespace(id=1))
    overlay_dir = tmp_path / "overlay"
    existing_config = overlay_dir / "boot" / "config.txt"
    existing_firmware_config = overlay_dir / "boot" / "firmware" / "config.txt"
    existing_config.write_text("dtoverlay=spi1-1cs\n#dtoverlay=spi0-0cs\n", encoding="utf-8")
    existing_firmware_config.write_text("disable_splash=1\n", encoding="utf-8")

    builder._write_boot_config(
        overlay_dir,
        ["dtoverlay=spi0-0cs", "dtoverlay=spi0-1cs", "dtoverlay=spi0-0cs"],
    )

    assert "dtoverlay=spi0-0cs" in existing_config.read_text(encoding="utf-8")
    assert "dtoverlay=spi0-1cs" in existing_config.read_text(encoding="utf-8")
    assert "#dtoverlay=spi0-0cs" not in existing_config.read_text(encoding="utf-8")
    assert "dtoverlay=spi0-0cs" in existing_firmware_config.read_text(encoding="utf-8")
    assert "dtoverlay=spi0-1cs" in existing_firmware_config.read_text(encoding="utf-8")


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
                "setupJsonResetFilePath": "/boot/frameos-setup.json",
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
    assert bootstrap_frame.buildroot["setupJsonResetFilePath"] == "/boot/frameos-setup.json"
    assert "sdImage" not in bootstrap_frame.buildroot


def test_buildroot_setup_payload_supports_gzip(tmp_path):
    payload = {"name": "Frame", "scenes": []}
    output_path = tmp_path / "boot" / "frameos-setup.json.gz"

    BuildrootImageBuilder._write_setup_payload(output_path, payload)

    decoded = gzip.decompress(output_path.read_bytes()).decode("utf-8")
    assert json.loads(decoded) == payload
