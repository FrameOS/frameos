from __future__ import annotations

import pytest

from app.tasks.buildroot_platforms import (
    BUILDROOT_PLATFORMS,
    DEFAULT_BUILDROOT_PLATFORM,
    RASPBERRY_PI_32,
    RASPBERRY_PI_64,
    enabled_buildroot_platforms,
    get_buildroot_platform,
    normalize_buildroot_platform,
)
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.utils.cross_compile import PLATFORM_MAP, can_cross_compile_target


def test_default_platform_is_the_unified_64_bit_image():
    assert DEFAULT_BUILDROOT_PLATFORM == "raspberry-pi-64"
    assert normalize_buildroot_platform(None) == "raspberry-pi-64"
    assert normalize_buildroot_platform("") == "raspberry-pi-64"


def test_legacy_zero_2_w_keys_normalize_to_the_unified_image():
    # "raspberry-pi-zero-2-w" was its own single-model platform before it
    # folded into raspberry-pi-64; frames created back then store these.
    for alias in (
        "raspberry-pi-zero-2-w",
        "pi-zero2",
        "raspberrypizero2w",
        "raspberrypizero2w_64_defconfig",
        "pi-zero-2-w",
    ):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-64"


def test_pi_32_platform_normalizes_from_aliases():
    # "raspberry-pi-zero-w" is the pre-rename canonical key: frames created
    # before the unified 32-bit image store it in their config.
    for alias in (
        "raspberry-pi-zero-w",
        "pi-zero-w",
        "pi-zero",
        "pi-1",
        "raspberry-pi-1",
        "raspberrypi0",
        "raspberrypi0w",
        "raspberrypizerow",
        "raspberrypi_defconfig",
    ):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-32"


def test_unknown_platform_raises():
    with pytest.raises(ValueError, match="Unsupported Buildroot platform"):
        normalize_buildroot_platform("commodore-64")


def test_disabled_platforms_raise_until_bring_up():
    for key in ("luckfox-pico", "allwinner-t113"):
        assert key in BUILDROOT_PLATFORMS
        assert not BUILDROOT_PLATFORMS[key].enabled
        with pytest.raises(ValueError, match="not supported yet"):
            get_buildroot_platform(key)


def test_enabled_platforms_have_complete_definitions():
    platforms = enabled_buildroot_platforms()
    assert [platform.key for platform in platforms] == [
        "raspberry-pi-32",
        "raspberry-pi-64",
        "raspberry-pi-5",
    ]
    for platform in platforms:
        assert platform.defconfig
        assert platform.label
        assert platform.release_target
        assert can_cross_compile_target(platform.build_target.arch)
        # The release slug must match what resolve_prebuilt_target derives
        # from the build target, or release images would download binaries
        # built for a different CPU.
        assert (
            resolve_prebuilt_target(
                platform.build_target.distro,
                platform.build_target.version,
                platform.build_target.arch,
            )
            == platform.release_target
        )
        assert PLATFORM_MAP[platform.build_target.arch] == platform.docker_platform


def test_pi_32_is_32_bit_armv6():
    assert RASPBERRY_PI_32.defconfig == "raspberrypi0w_defconfig"
    assert RASPBERRY_PI_32.build_target.arch == "armv6l"
    assert RASPBERRY_PI_32.docker_platform == "linux/arm/v6"
    assert RASPBERRY_PI_32.release_target == "debian-bookworm-armv6"
    assert not RASPBERRY_PI_32.needs_zero_2_w_wifi_firmware


def test_pi_32_is_a_unified_multi_model_image():
    # Mirrors the raspberry-pi-64 approach: every BCM2835 board shares the
    # bcmrpi kernel and start.elf firmware, so one image covers them all via
    # the DTB list alone.
    dts_line = next(
        line for line in RASPBERRY_PI_32.extra_config_lines
        if line.startswith("BR2_LINUX_KERNEL_INTREE_DTS_NAME=")
    )
    for dtb in (
        "bcm2708-rpi-zero",
        "bcm2708-rpi-zero-w",
        "bcm2708-rpi-b-rev1",
        "bcm2708-rpi-b",
        "bcm2708-rpi-b-plus",
        "bcm2708-rpi-cm",
    ):
        assert f"broadcom/{dtb}" in dts_line
    # One kernel + one firmware set + a handful of small DTBs still fit the
    # single-model boot layout, and every ARMv6 board loads the same
    # start.elf, so no config.txt keys need stripping.
    assert RASPBERRY_PI_32.boot_partition_size == "32M"
    assert RASPBERRY_PI_32.remove_boot_config_keys == ()


def test_armv6_never_resolves_to_armv7_prebuilts():
    # Pi Zero W binaries must not fall back to armhf artifacts: those are
    # built for ARMv7 and SIGILL on the Zero W's ARM1176 core.
    assert resolve_prebuilt_target("debian", "bookworm", "armv6l") == "debian-bookworm-armv6"
    assert resolve_prebuilt_target("debian", "bookworm", "armv7l") == "debian-bookworm-armhf"


def test_raspberry_pi_64_is_a_unified_multi_model_image():
    platform = BUILDROOT_PLATFORMS["raspberry-pi-64"]
    assert platform.defconfig == "raspberrypizero2w_64_defconfig"
    assert platform.build_target.arch == "aarch64"
    # The bcm2711 kernel covers BCM2710 (Zero 2 W / Pi 3) and BCM2711 (Pi 4).
    assert 'BR2_LINUX_KERNEL_DEFCONFIG="bcm2711"' in platform.extra_config_lines
    # Both firmware sets side by side so the bootloader picks per model.
    assert "BR2_PACKAGE_RPI_FIRMWARE_VARIANT_PI4=y" in platform.extra_config_lines
    # A pinned start_file would force Pi-3-generation firmware onto a Pi 4.
    assert set(platform.remove_boot_config_keys) == {"start_file", "fixup_file"}
    # All DTBs + both firmware sets outgrow the 32M single-model boot layout.
    assert platform.boot_partition_size != "32M"
    assert platform.needs_zero_2_w_wifi_firmware
    for alias in ("pi-3", "pi-4", "raspberry-pi-4", "raspberrypi4_64_defconfig"):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-64"


def test_raspberry_pi_5_has_its_own_kernel_and_no_gpu_mem():
    platform = BUILDROOT_PLATFORMS["raspberry-pi-5"]
    assert platform.defconfig == "raspberrypi5_defconfig"
    assert platform.build_target.arch == "aarch64"
    # One BCM2712 kernel, DTB picked by model: both Pi 5 steppings plus the
    # CM5 on either carrier board. (Pi 500 / CM5 Lite DTS files postdate the
    # kernel commit Buildroot 2025.02 pins.)
    dts_line = next(
        line for line in platform.extra_config_lines
        if line.startswith("BR2_LINUX_KERNEL_INTREE_DTS_NAME=")
    )
    for dtb in (
        "bcm2712-rpi-5-b",
        "bcm2712d0-rpi-5-b",
        "bcm2712-rpi-cm5-cm5io",
        "bcm2712-rpi-cm5-cm4io",
    ):
        assert f"broadcom/{dtb}" in dts_line
    # The shared kernel fragment replaces the defconfig's 4K-page fragment,
    # so the platform must re-add it or the kernel defaults to 16K pages.
    assert "CONFIG_ARM64_4K_PAGES=y" in platform.kernel_fragment_lines
    # raspberrypi5_defconfig disables overlays; e-ink displays need them.
    assert "BR2_PACKAGE_RPI_FIRMWARE_INSTALL_DTB_OVERLAYS=y" in platform.extra_config_lines
    # No start*.elf firmware on the Pi 5 and no gpu_mem key either — but the
    # KMS overlay is mandatory: BCM2712 has no firmware framebuffer, so
    # without vc4 there is no /dev/fb0 and the `framebuffer` device is dead.
    assert platform.default_boot_config_lines == ("dtoverlay=vc4-kms-v3d",)
    assert not any("gpu_mem" in line for line in platform.default_boot_config_lines)
    for alias in ("pi-5", "pi5", "raspberrypi5"):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-5"


def test_build_target_copy_is_isolated():
    copy = RASPBERRY_PI_64.build_target_copy()
    copy.arch = "mutated"
    assert RASPBERRY_PI_64.build_target.arch == "aarch64"
