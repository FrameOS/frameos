from __future__ import annotations

import pytest

from app.tasks.buildroot_platforms import (
    BUILDROOT_PLATFORMS,
    DEFAULT_BUILDROOT_PLATFORM,
    RASPBERRY_PI_ZERO_2_W,
    RASPBERRY_PI_ZERO_W,
    enabled_buildroot_platforms,
    get_buildroot_platform,
    normalize_buildroot_platform,
)
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.utils.cross_compile import PLATFORM_MAP, can_cross_compile_target


def test_default_platform_is_zero_2_w():
    assert DEFAULT_BUILDROOT_PLATFORM == "raspberry-pi-zero-2-w"
    assert normalize_buildroot_platform(None) == "raspberry-pi-zero-2-w"
    assert normalize_buildroot_platform("") == "raspberry-pi-zero-2-w"


def test_legacy_zero_2_w_aliases_still_normalize():
    for alias in ("pi-zero2", "raspberrypizero2w", "raspberrypizero2w_64_defconfig", "pi-zero-2-w"):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-zero-2-w"


def test_zero_w_platform_normalizes_from_aliases():
    for alias in ("raspberry-pi-zero-w", "pi-zero-w", "raspberrypi0w", "raspberrypizerow"):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-zero-w"


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
        "raspberry-pi-zero-2-w",
        "raspberry-pi-zero-w",
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


def test_zero_w_is_32_bit_armv6():
    assert RASPBERRY_PI_ZERO_W.defconfig == "raspberrypi0w_defconfig"
    assert RASPBERRY_PI_ZERO_W.build_target.arch == "armv6l"
    assert RASPBERRY_PI_ZERO_W.docker_platform == "linux/arm/v6"
    assert RASPBERRY_PI_ZERO_W.release_target == "debian-bookworm-armv6"
    assert not RASPBERRY_PI_ZERO_W.needs_zero_2_w_wifi_firmware


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
    # The shared kernel fragment replaces the defconfig's 4K-page fragment,
    # so the platform must re-add it or the kernel defaults to 16K pages.
    assert "CONFIG_ARM64_4K_PAGES=y" in platform.kernel_fragment_lines
    # raspberrypi5_defconfig disables overlays; e-ink displays need them.
    assert "BR2_PACKAGE_RPI_FIRMWARE_INSTALL_DTB_OVERLAYS=y" in platform.extra_config_lines
    # No start*.elf firmware on the Pi 5 and no gpu_mem key either.
    assert platform.default_boot_config_lines == ()
    for alias in ("pi-5", "pi5", "raspberrypi5"):
        assert normalize_buildroot_platform(alias) == "raspberry-pi-5"


def test_build_target_copy_is_isolated():
    copy = RASPBERRY_PI_ZERO_2_W.build_target_copy()
    copy.arch = "mutated"
    assert RASPBERRY_PI_ZERO_2_W.build_target.arch == "aarch64"
