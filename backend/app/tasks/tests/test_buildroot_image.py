from __future__ import annotations

from types import SimpleNamespace

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


def test_buildroot_script_builds_output_on_container_filesystem(tmp_path):
    script_path = tmp_path / "buildroot-build.sh"

    BuildrootImageBuilder._write_build_script(script_path, "frameos-test.img")
    script = script_path.read_text(encoding="utf-8")

    assert "O=/build/output" in script
    assert "dd if=/build/output/images/sdcard.img of=/artifacts/frameos-test.img" in script
    assert "O=/work/output" not in script
    assert "cp /work/output/images/sdcard.img" not in script


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
