"""Registry of hardware platforms FrameOS can build Buildroot SD images for.

Every platform-specific knob of the Buildroot pipeline lives here: the
Buildroot defconfig, the cross-compile target for the FrameOS/Remote binaries,
extra Buildroot config lines, boot config, and Wi-Fi firmware quirks.
`backend/app/tasks/buildroot_image.py` and `tools/buildroot-images/` consume
this registry; adding a board should mostly mean adding an entry below.

Boards whose bring-up has not happened yet are registered with
``enabled=False`` so the rest of the stack can already reason about them
(CI matrices skip them, the API rejects them with a clear message).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.utils.cross_compile import TargetMetadata


@dataclass(frozen=True)
class BuildrootPlatform:
    # Canonical platform key, used in frame config, manifests, artifact names,
    # and release asset filenames (frameos-<version>-<key>-buildroot.img.gz).
    key: str
    label: str
    # Board family gates family-specific image assembly (boot partition
    # layout, firmware files, config.txt handling). Only "raspberrypi" is
    # implemented; other families raise until their genimage/boot flow lands.
    family: str
    # Buildroot defconfig the base image starts from.
    defconfig: str
    # Cross-compile target for the FrameOS and Remote binaries.
    build_target: TargetMetadata
    # Docker platform matching build_target (used for release composition).
    docker_platform: str
    # Precompiled release slug (see backend/bin/cross TARGETS).
    release_target: str
    enabled: bool = True
    aliases: frozenset[str] = frozenset()
    # Extra BR2_* lines appended after the shared FrameOS Buildroot config.
    # Lines whose dependencies are unmet on the build host are dropped by
    # `make olddefconfig` (e.g. Bootlin toolchains only exist for x86_64
    # hosts; other hosts fall back to a from-source Buildroot toolchain).
    # Note: BR2_PACKAGE_* lines are guarded — see BUILDROOT_CONFIG_CHECK_SCRIPT
    # in buildroot_image.py — so a silently dropped package fails the build.
    extra_config_lines: tuple[str, ...] = ()
    # Whether the shared config asks Buildroot for NetworkManager + nmcli.
    # NetworkManager's Kconfig entry `depends on BR2_TOOLCHAIN_HEADERS_AT_LEAST_4_20`,
    # and every Bootlin "stable" external toolchain ships 4.19 kernel headers, so
    # NetworkManager is silently dropped from any build that uses one. Boards that
    # stay on a stable toolchain therefore get the wpa_supplicant + hostapd network
    # stack instead; see frameos/src/frameos/portal.nim.
    uses_network_manager: bool = True
    # Extra lines appended to the shared kernel config fragment.
    kernel_fragment_lines: tuple[str, ...] = ()
    # Lines merged into the Raspberry Pi boot config.txt.
    default_boot_config_lines: tuple[str, ...] = ()
    # Device-tree model suffixes that need brcmfmac firmware symlinks so the
    # kernel finds board-specific firmware names in /usr/lib/firmware/brcm.
    wifi_firmware_models: tuple[str, ...] = ()
    # The Zero 2 W ships a BCM43436 whose firmware only exists in the
    # RPi-Distro firmware-nonfree repo; enables the download/symlink fixups.
    needs_zero_2_w_wifi_firmware: bool = False
    # Default GitHub Actions runner label for base-image builds: 32-core
    # Depot runners (Buildroot is compile-bound and scales with cores, and
    # Depot serves actions/cache from its own storage). x86_64 runners can
    # use prebuilt Bootlin toolchains for 32-bit ARM targets.
    default_runner_label: str = "depot-ubuntu-24.04-arm-32"

    def build_target_copy(self) -> TargetMetadata:
        # TargetMetadata is a mutable dataclass; hand out copies so callers
        # cannot mutate the registry entry.
        return TargetMetadata(
            arch=self.build_target.arch,
            distro=self.build_target.distro,
            version=self.build_target.version,
            platform=self.build_target.platform,
            image=self.build_target.image,
        )


RASPBERRY_PI_ZERO_2_W = BuildrootPlatform(
    key="raspberry-pi-zero-2-w",
    label="Raspberry Pi Zero 2 W",
    family="raspberrypi",
    defconfig="raspberrypizero2w_64_defconfig",
    build_target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
    docker_platform="linux/arm64",
    release_target="debian-bookworm-arm64",
    aliases=frozenset(
        {
            "",
            "pi-zero2",
            "pi-zero-2",
            "pi-zero-w2",
            "pi-zero-2-w",
            "raspberry-pi-zero2",
            "raspberry-pi-zero-2",
            "raspberry-pi-zero-w-2",
            "raspberrypi-zero-2-w",
            "raspberrypizero2w",
            "raspberrypizero2w_defconfig",
            "raspberrypizero2w_64_defconfig",
        }
    ),
    # Keep a small firmware framebuffer reserve for standard HDMI output while
    # returning the rest of the 512MB RAM to Linux/userland.
    default_boot_config_lines=("gpu_mem=32",),
    wifi_firmware_models=(
        "raspberrypi,model-zero-2-w",
        "raspberrypi,model-zero-2-2",
    ),
    needs_zero_2_w_wifi_firmware=True,
    default_runner_label="depot-ubuntu-24.04-arm-32",
    # raspberrypizero2w_64_defconfig pins the Bootlin aarch64 *stable* toolchain,
    # which ships 4.19 kernel headers — below NetworkManager's
    # `depends on BR2_TOOLCHAIN_HEADERS_AT_LEAST_4_20`, so `make olddefconfig`
    # silently dropped NetworkManager. (Shipped images still had nmcli only
    # because Buildroot never deletes an already-installed package from a reused
    # output/ directory; the first cache-cold rebuild would have lost it.)
    # The bleeding-edge Bootlin toolchain is the same 2024.05-1 release with
    # gcc 14 and 5.15 headers, which NetworkManager accepts.
    extra_config_lines=("BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_AARCH64_GLIBC_BLEEDING_EDGE=y",),
)

RASPBERRY_PI_ZERO_W = BuildrootPlatform(
    key="raspberry-pi-zero-w",
    label="Raspberry Pi Zero W",
    family="raspberrypi",
    defconfig="raspberrypi0w_defconfig",
    # ARMv6 hard-float; Debian has no ARMv6 port, so binaries come from the
    # Bootlin armv6-eabihf toolchain (see cross_toolchain_packages.py).
    build_target=TargetMetadata(arch="armv6l", distro="debian", version="bookworm"),
    docker_platform="linux/arm/v6",
    release_target="debian-bookworm-armv6",
    aliases=frozenset(
        {
            "pi-zero",
            "pi-zero-w",
            "raspberry-pi-zero",
            "raspberrypi-zero-w",
            "raspberrypizerow",
            "raspberrypi0w",
            "raspberrypi0w_defconfig",
        }
    ),
    # Prefer the prebuilt Bootlin ARMv6 toolchain over building gcc from
    # source; only available on x86_64 build hosts, elsewhere olddefconfig
    # falls back to BR2_TOOLCHAIN_BUILDROOT automatically.
    extra_config_lines=(
        "BR2_TOOLCHAIN_EXTERNAL=y",
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN=y",
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_ARMV6_EABIHF_GLIBC_STABLE=y",
    ),
    # The *stable* Bootlin toolchain above ships 4.19 kernel headers, below
    # NetworkManager's `depends on BR2_TOOLCHAIN_HEADERS_AT_LEAST_4_20`, so
    # NetworkManager/nmcli was silently dropped and the board shipped with no
    # way to join Wi-Fi or start its setup hotspot. Wi-Fi and the hotspot run on
    # wpa_supplicant + hostapd here instead (see frameos/src/frameos/portal.nim).
    #
    # This is a product decision, not a hard limit: swapping the toolchain line
    # above to BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_ARMV6_EABIHF_GLIBC_BLEEDING_EDGE
    # (gcc 14, 5.15 headers) makes NetworkManager + nmcli resolve on ARMv6 too.
    uses_network_manager=False,
    # Same 512MB split as the Zero 2 W.
    default_boot_config_lines=("gpu_mem=32",),
    wifi_firmware_models=("raspberrypi,model-zero-w",),
    needs_zero_2_w_wifi_firmware=False,
    # x86_64 so the Bootlin ARMv6 rootfs toolchain applies.
    default_runner_label="depot-ubuntu-24.04-32",
)

# TODO(luckfox-pico): Rockchip RV1103/RV1106 boards (Luckfox Pico family).
# Mainline Buildroot has no defconfig for them; bring-up needs the Luckfox
# BR2_EXTERNAL tree (or a custom defconfig + rkbin boot blobs) plus a
# non-Raspberry-Pi post-image/genimage flow for the Rockchip boot layout
# (idblock/uboot partitions before the FAT boot partition).
LUCKFOX_PICO = BuildrootPlatform(
    key="luckfox-pico",
    label="Luckfox Pico (RV1103/RV1106)",
    family="rockchip",
    defconfig="",  # TODO: BR2_EXTERNAL defconfig
    # Cortex-A7 (ARMv7 hard-float) — the standard armhf target applies.
    build_target=TargetMetadata(arch="armv7l", distro="debian", version="bookworm"),
    docker_platform="linux/arm/v7",
    release_target="debian-bookworm-armhf",
    enabled=False,
    default_runner_label="depot-ubuntu-24.04-32",
)

# TODO(t113): Allwinner T113-S3/S4 boards (MangoPi, Lctech, etc.). Needs a
# custom defconfig (mainline U-Boot + sunxi kernel work, but Buildroot ships
# no T113 defconfig) and a sunxi-specific post-image flow (u-boot-sunxi with
# spl written at the 8KiB offset before the first partition).
ALLWINNER_T113 = BuildrootPlatform(
    key="allwinner-t113",
    label="Allwinner T113-S3/S4",
    family="allwinner",
    defconfig="",  # TODO: custom defconfig
    # Cortex-A7 (ARMv7 hard-float) — the standard armhf target applies.
    build_target=TargetMetadata(arch="armv7l", distro="debian", version="bookworm"),
    docker_platform="linux/arm/v7",
    release_target="debian-bookworm-armhf",
    enabled=False,
    default_runner_label="depot-ubuntu-24.04-32",
)

BUILDROOT_PLATFORMS: dict[str, BuildrootPlatform] = {
    platform.key: platform
    for platform in (
        RASPBERRY_PI_ZERO_2_W,
        RASPBERRY_PI_ZERO_W,
        LUCKFOX_PICO,
        ALLWINNER_T113,
    )
}

DEFAULT_BUILDROOT_PLATFORM = RASPBERRY_PI_ZERO_2_W.key

_ALIAS_MAP: dict[str, str] = {}
for _platform in BUILDROOT_PLATFORMS.values():
    for _alias in _platform.aliases:
        if _alias in _ALIAS_MAP:
            raise RuntimeError(f"Duplicate Buildroot platform alias: {_alias!r}")
        _ALIAS_MAP[_alias] = _platform.key


def enabled_buildroot_platforms() -> list[BuildrootPlatform]:
    return [platform for platform in BUILDROOT_PLATFORMS.values() if platform.enabled]


def normalize_buildroot_platform(platform: str | None) -> str:
    return get_buildroot_platform(platform).key


def get_buildroot_platform(platform: str | None) -> BuildrootPlatform:
    value = (platform or "").strip()
    key = value if value in BUILDROOT_PLATFORMS else _ALIAS_MAP.get(value)
    if key is None:
        raise ValueError(f"Unsupported Buildroot platform: {value or '(empty)'}")
    resolved = BUILDROOT_PLATFORMS[key]
    if not resolved.enabled:
        raise ValueError(f"Buildroot platform {resolved.key} is not supported yet")
    return resolved
