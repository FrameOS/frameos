from __future__ import annotations

import gzip
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.models.assets import Assets
from app.tasks import buildroot_image as buildroot_image_module
from app.tasks.buildroot_image import (
    BUILDROOT_DEFAULT_BOOT_CONFIG_LINES,
    BUILDROOT_EXPAND_SD_CARD_SCRIPT_PATH,
    BUILDROOT_EXPAND_SD_CARD_SERVICE_NAME,
    FRAMEOS_BUILD_TARGET,
    BuildrootImageBuilder,
    ensure_buildroot_frame_defaults,
    _frame_boot_config_lines,
    _merge_boot_config_lines,
    _network_manager_wifi_connection,
    render_expand_sd_card_script,
    render_expand_sd_card_service,
)
from app.tasks.binary_builder import FrameBinaryBuildResult
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.tasks.setup_json_reset import (
    DEFAULT_SETUP_JSON_RESET_FILE_PATH,
    render_setup_json_reset_script,
    setup_json_reset_file_path,
)
from app.utils.cross_compile import CrossCompiler


REPO_ROOT = Path(__file__).resolve().parents[4]


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


def test_buildroot_firstboot_setup_uses_with_setup_command():
    script = render_setup_json_reset_script("/boot/frameos-setup.json")

    assert "/srv/frameos/current/frameos setup --with-setup=\"$SETUP_FILE\"" in script
    assert "sudo -E /srv/frameos/current/frameos setup --with-setup=\"$SETUP_FILE\"" in script
    assert "LD_LIBRARY_PATH=/srv/frameos/current/drivers:/srv/frameos/current/scenes" in script
    assert "mount -o remount,rw /" in script
    assert "frameos-setup-reset.log" in script
    assert "leaving $SETUP_FILE in place for retry" in script
    assert "request_reboot()" in script
    assert "systemctl reboot" in script
    assert "Reboot command accepted" in script
    assert "with status 0 (reboot requested)" in script
    assert "--from-file" not in script


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


def test_buildroot_config_avoids_ncurses_selecting_packages(tmp_path):
    config_path = tmp_path / "frameos-buildroot.config"

    BuildrootImageBuilder._write_buildroot_config(config_path)
    config = config_path.read_text(encoding="utf-8")

    assert "BR2_PACKAGE_BASH=y" in config
    assert "BR2_PACKAGE_PROCPS_NG" not in config
    assert 'BR2_DL_DIR="/cache/dl"' in config
    assert "BR2_JLEVEL=0" in config
    assert 'BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES="/work/linux-fragment.config"' in config
    assert 'BR2_LINUX_KERNEL_CUSTOM_LOGO_PATH="/work/frameos-boot-logo.png"' in config
    assert "BR2_PACKAGE_DROPBEAR=y" in config
    assert "BR2_PACKAGE_DBUS=y" in config
    assert "BR2_PACKAGE_TZDATA=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX_BINARIES=y" in config
    assert "BR2_PACKAGE_UTIL_LINUX_PARTX=y" in config
    assert "BR2_PACKAGE_E2FSPROGS=y" in config
    assert "BR2_PACKAGE_E2FSPROGS_RESIZE2FS=y" in config
    assert "BR2_PACKAGE_DOSFSTOOLS=y" in config
    assert "BR2_PACKAGE_DOSFSTOOLS_MKFS_FAT=y" in config
    assert "BR2_PACKAGE_NANO=y" in config
    assert "BR2_PACKAGE_IMAGEMAGICK=y" in config
    assert "BR2_PACKAGE_NETWORK_MANAGER=y" in config
    assert "BR2_PACKAGE_NETWORK_MANAGER_WIFI=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_DBUS=y" in config
    assert "BR2_PACKAGE_WPA_SUPPLICANT_NL80211=y" in config
    assert "# BR2_CCACHE is not set" in config
    assert 'BR2_ROOTFS_POST_IMAGE_SCRIPT="/work/post-image.sh"' in config
    assert "/work/partition-post-build.sh" in config


def test_kernel_config_fragment_disables_case_colliding_xtables_targets(tmp_path):
    fragment_path = tmp_path / "linux-fragment.config"

    BuildrootImageBuilder._write_kernel_config_fragment(fragment_path)
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
    assert "unset TERMINFO TERMINFO_DIRS" in script
    assert "FRAMEOS_NCURSES_TERMINFO_LINKS" in script
    assert "for dir in a d f l p s v x;" in script
    assert "rm -f /build/output/build/linux-custom/.stamp_configured" in script
    assert ".stamp_staging_installed" in script
    assert "usr/share/terminfo/a/ansi" in script
    assert "ulimit -n 65535" in script
    assert "dd if=/build/output/images/sdcard.img of=/artifacts/frameos-test.img" in script
    assert "O=/work/output" not in script
    assert "cp /work/output/images/sdcard.img" not in script


def test_buildroot_partition_scripts_create_frameos_and_assets_partitions(tmp_path):
    partition_post_build_path = tmp_path / "partition-post-build.sh"
    post_image_path = tmp_path / "post-image.sh"

    BuildrootImageBuilder._write_partition_post_build_script(partition_post_build_path)
    BuildrootImageBuilder._write_post_image_script(post_image_path)
    BuildrootImageBuilder._write_post_build_script(tmp_path / "post-build.sh")

    partition_post_build = partition_post_build_path.read_text(encoding="utf-8")
    post_image = post_image_path.read_text(encoding="utf-8")
    post_build = (tmp_path / "post-build.sh").read_text(encoding="utf-8")

    assert "LABEL=BOOT /boot vfat" in partition_post_build
    assert "LABEL=FRAMEOS /srv/frameos ext4" in partition_post_build
    assert "LABEL=ASSETS /srv/assets vfat" in partition_post_build
    assert "frameos-partition-root" in partition_post_build
    assert "assets-partition-root" in partition_post_build
    assert '"$target_dir/etc/cron.d"' in post_build
    assert "image frameos.ext4" in post_image
    assert "image assets.vfat" in post_image
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
    assert "small_card_threshold_sectors=$((4 * 1024 * 1024 * 1024 / sector_size))" in script
    assert "small_frameos_sectors=$((1 * 1024 * 1024 * 1024 / sector_size))" in script
    assert "large_frameos_sectors=$((2 * 1024 * 1024 * 1024 / sector_size))" in script
    assert 'echo "Root unchanged: start $p2_start, size $p2_size sectors"' in script
    assert 'mkfs.vfat -n ASSETS "$assets_dev"' in script
    assert 'resize2fs "$frameos_dev"' in script
    assert 'resize2fs "$root_dev"' not in script
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

    monkeypatch.setattr(buildroot_images, "copy_lgpio_runtime_libraries", lambda _overlay: None)
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


def test_buildroot_boot_logo_is_staged_for_kernel_custom_logo(tmp_path):
    logo_path = tmp_path / "frameos-boot-logo.png"

    BuildrootImageBuilder._write_boot_logo(logo_path)

    assert logo_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


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

    async def fake_exec_local_command(*args, **kwargs):
        command = args[3]
        commands.append(command)
        if "compose-partitions.sh" in command:
            captured["compose_command"] = command
            config = temp_dir / "compose" / "frameos-genimage.cfg"
            captured["config"] = config.read_text(encoding="utf-8")
            images_dir = temp_dir / "compose" / "images"
            (images_dir / "frameos.ext4").write_bytes(b"frameos")
            (images_dir / "assets.vfat").write_bytes(b"assets")
        if "patch-boot.sh" in command:
            captured["patch_command"] = command
            captured["patch_script"] = (temp_dir / "compose" / "patch-boot.sh").read_text(encoding="utf-8")
        return 0, "", ""

    async def fake_log(*args, **kwargs):
        return None

    def fake_replace_partition(_image_path, _partitions, partition_number, partition_image):
        replaced.append((partition_number, partition_image.name))

    monkeypatch.setattr("app.tasks.buildroot_image.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr(
        "app.tasks.buildroot_image._mbr_partitions",
        lambda _path: [
            {"start": 512, "size": 32 * 1024 * 1024},
            {"start": 33554944, "size": 768 * 1024 * 1024},
            {"start": 838861312, "size": 512 * 1024 * 1024},
            {"start": 1375732224, "size": 512 * 1024 * 1024},
        ],
    )
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
    assert 'label = "BOOT"' not in captured["config"]
    assert str(temp_dir) not in captured["config"]
    assert "bash /work/compose-partitions.sh" in captured["compose_command"]
    assert "bash /patch-boot.sh" in captured["patch_command"]
    assert f"-v {tmp_path / 'release-assets'}:/image" in captured["patch_command"]
    assert "-v release-assets:/image" not in captured["patch_command"]
    assert "frameos/frameos-buildroot:test" in captured["compose_command"]
    assert "frameos/frameos-buildroot:test" in captured["patch_command"]
    assert 'tar -C "$work_dir/roots" -cf - frameos assets | tar -C "$compose_roots" -xf -' in (
        temp_dir / "compose" / "compose-partitions.sh"
    ).read_text(encoding="utf-8")
    assert "mlabel -i \"$target\" ::BOOT" in captured["patch_script"]
    assert "mcopy -i \"$target\" -o -s" in captured["patch_script"]
    assert "offset=512" in captured["patch_script"]
    assert (temp_dir / "compose" / "roots" / "assets" / "frameos-assets-placeholder").is_file()
    assert output_image.read_bytes() == b"base"
    assert replaced == [(3, "frameos.ext4"), (4, "assets.vfat")]
    assert len(commands) == 2


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
        command = args[3]
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

    monkeypatch.setattr("app.tasks.buildroot_image.exec_local_command", fake_exec_local_command)
    monkeypatch.setattr(
        "app.tasks.buildroot_image._mbr_partitions",
        lambda _path: [
            {"start": 512, "size": 32 * 1024 * 1024},
            {"start": 33554944, "size": 768 * 1024 * 1024},
            {"start": 838861312, "size": 512 * 1024 * 1024},
            {"start": 1375732224, "size": 512 * 1024 * 1024},
        ],
    )
    monkeypatch.setattr("app.tasks.buildroot_image._replace_partition", fake_replace_partition)
    monkeypatch.setattr(builder, "_log", fake_log)

    await builder._compose_sd_image_from_base(
        temp_dir=temp_dir,
        base_image_path=base_image,
        output_path=output_image,
        image=None,
    )

    assert len(commands) == 2
    assert all("docker run" not in command for command in commands)
    assert commands[0].startswith("FRAMEOS_COMPOSE_WORK_DIR=")
    assert commands[1].startswith("FRAMEOS_IMAGE_DIR=")
    assert output_image.read_bytes() == b"base"
    assert replaced == [(3, "frameos.ext4"), (4, "assets.vfat")]


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


def test_buildroot_stage_overlay_leaves_service_install_to_firstboot(tmp_path, monkeypatch):
    frameos_binary = tmp_path / "frameos"
    agent_binary = tmp_path / "frameos_agent"
    frameos_binary.write_bytes(b"frameos")
    agent_binary.write_bytes(b"agent")
    frame = SimpleNamespace(
        id=1,
        frame_host="Frame One.local",
        mode="buildroot",
        network={"wifiSSID": "Test WiFi", "wifiPassword": "secret"},
        buildroot={},
        ssh_keys=[],
    )
    builder = BuildrootImageBuilder(db=object(), redis=None, frame=frame)
    overlay_dir = tmp_path / "overlay"

    monkeypatch.setattr("app.tasks.buildroot_image.get_frame_json", lambda _db, _frame: {"id": 1})
    monkeypatch.setattr("app.tasks.buildroot_image.get_interpreted_scenes_json", lambda _frame: [])
    monkeypatch.setattr("app.tasks.buildroot_image.get_settings_dict", lambda _db, project_id=None: {"ssh_keys": {"keys": []}})
    monkeypatch.setattr("app.tasks.buildroot_image.drivers_for_frame", lambda _frame: {})
    monkeypatch.setattr(BuildrootImageBuilder, "_copy_runtime_libraries", lambda _self, _overlay_dir: None)

    builder._stage_overlay(
        overlay_dir=overlay_dir,
        build_id="build123",
        bootstrap_frame=frame,
        setup_payload={"id": 1},
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
        agent_binary=str(agent_binary),
    )

    assert (overlay_dir / "boot" / "frameos-setup.json").exists()
    assert (overlay_dir / "boot" / "frameos-hostname").read_text(encoding="utf-8") == "frame-one\n"
    assert (overlay_dir / "srv" / "frameos" / "releases" / "release_build123" / "frameos.service").exists()
    assert (overlay_dir / "srv" / "frameos" / "agent" / "releases" / "release_build123" / "frameos_agent.service").exists()
    assert not (overlay_dir / "etc" / "systemd" / "system" / "frameos.service").exists()
    assert not (overlay_dir / "etc" / "systemd" / "system" / "frameos_agent.service").exists()


def test_buildroot_copies_lgpio_runtime_libraries(tmp_path, monkeypatch):
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
    builder._copy_runtime_libraries(tmp_path / "overlay")

    assert (tmp_path / "overlay" / "usr" / "lib" / "liblgpio.so.1").read_bytes() == b"lgpio"
    assert (tmp_path / "overlay" / "usr" / "lib" / "librgpio.so.1").read_bytes() == b"rgpio"


def test_buildroot_requires_lgpio_runtime_libraries(tmp_path, monkeypatch):
    builder = BuildrootImageBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
    )

    monkeypatch.setattr("app.tasks.buildroot_image._lgpio_runtime_library_paths", lambda: [])

    with pytest.raises(RuntimeError, match="requires lgpio runtime libraries"):
        builder._copy_runtime_libraries(tmp_path / "overlay")


def test_buildroot_boot_config_merge_is_written_to_active_boot_location(tmp_path):
    builder = BuildrootImageBuilder(db=None, redis=None, frame=SimpleNamespace(id=1))
    overlay_dir = tmp_path / "overlay"
    existing_config = overlay_dir / "boot" / "config.txt"
    existing_firmware_config = overlay_dir / "boot" / "firmware" / "config.txt"
    existing_config.parent.mkdir(parents=True)
    existing_firmware_config.parent.mkdir(parents=True)
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

    assert lines == list(BUILDROOT_DEFAULT_BOOT_CONFIG_LINES)
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
