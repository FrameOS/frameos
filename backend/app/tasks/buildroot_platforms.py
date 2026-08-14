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
    # genimage size of the FAT boot partition. 32M fits a single-model image
    # (one kernel + one firmware set + overlays); multi-model images carrying
    # every DTB and both start.elf/start4.elf sets, and the larger bcm2711/
    # bcm2712 kernels, need more.
    boot_partition_size: str = "32M"
    # config.txt keys stripped from the rpi-firmware sample config during
    # post-image. Buildroot's sample configs pin start_file=/fixup_file=,
    # which breaks multi-model images: a Pi 4 must load start4.elf, and the
    # GPU bootloader only auto-selects per model when the keys are absent.
    remove_boot_config_keys: tuple[str, ...] = ()
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


RASPBERRY_PI_32 = BuildrootPlatform(
    key="raspberry-pi-32",
    label="Raspberry Pi Zero / Zero W / 1 (32-bit)",
    family="raspberrypi",
    # One unified ARMv6 image, mirroring the raspberry-pi-64 approach below:
    # every BCM2835 board (Zero, Zero W, Pi 1 A/A+/B/B+, CM1) boots the same
    # bcmrpi kernel and the same start.elf firmware set — they differ only in
    # which bcm2708-*.dtb the GPU bootloader picks, so widening the DTS list
    # is the whole trick. Pi 2 (BCM2836, ARMv7) needs a different kernel
    # binary and stays uncovered; Pi 3 and later take the raspberry-pi-64
    # image.
    defconfig="raspberrypi0w_defconfig",
    # ARMv6 hard-float; Debian has no ARMv6 port, so binaries come from the
    # Bootlin armv6-eabihf toolchain (see cross_toolchain_packages.py).
    build_target=TargetMetadata(arch="armv6l", distro="debian", version="bookworm"),
    docker_platform="linux/arm/v6",
    release_target="debian-bookworm-armv6",
    aliases=frozenset(
        {
            "pi-32",
            "pi-zero",
            "pi-zero-w",
            "pi-1",
            "raspberry-pi-zero",
            # The pre-rename canonical key; frames created before the rename
            # store this in their config.
            "raspberry-pi-zero-w",
            "raspberry-pi-1",
            "raspberry-pi-1-b",
            "raspberry-pi-1-b-plus",
            "raspberrypi-zero-w",
            "raspberrypizerow",
            "raspberrypi0",
            "raspberrypi0w",
            "raspberrypi0_defconfig",
            "raspberrypi0w_defconfig",
            "raspberrypi_defconfig",
        }
    ),
    # Prefer the prebuilt Bootlin ARMv6 toolchain over building gcc from
    # source; only available on x86_64 build hosts, elsewhere olddefconfig
    # falls back to BR2_TOOLCHAIN_BUILDROOT automatically.
    extra_config_lines=(
        "BR2_TOOLCHAIN_EXTERNAL=y",
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN=y",
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_ARMV6_EABIHF_GLIBC_STABLE=y",
        # All ARMv6 DTBs on the boot partition (the defconfig ships only the
        # Zero W's); the firmware auto-selects by model, and maps the boards
        # without their own DTB the same way Raspberry Pi OS does (Pi 1 A ->
        # bcm2708-rpi-b, A+ -> bcm2708-rpi-b-plus).
        'BR2_LINUX_KERNEL_INTREE_DTS_NAME="broadcom/bcm2708-rpi-zero broadcom/bcm2708-rpi-zero-w broadcom/bcm2708-rpi-b-rev1 broadcom/bcm2708-rpi-b broadcom/bcm2708-rpi-b-plus broadcom/bcm2708-rpi-cm"',
    ),
    # The *stable* Bootlin toolchain above ships 4.19 kernel headers, below
    # NetworkManager's `depends on BR2_TOOLCHAIN_HEADERS_AT_LEAST_4_20`, so
    # NetworkManager/nmcli was silently dropped and the board shipped with no
    # way to join Wi-Fi or start its setup hotspot. Wi-Fi and the hotspot run on
    # wpa_supplicant + hostapd here instead (see frameos/src/frameos/portal.nim).
    # Only the Zero W has onboard Wi-Fi in this family; the Pi 1 boards are
    # Ethernet (B/B+) or USB-only.
    #
    # This is a product decision, not a hard limit: swapping the toolchain line
    # above to BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_ARMV6_EABIHF_GLIBC_BLEEDING_EDGE
    # (gcc 14, 5.15 headers) makes NetworkManager + nmcli resolve on ARMv6 too.
    uses_network_manager=False,
    # Same firmware/Linux split as the Zero 2 W; the reserve matters even
    # more on the 256MB Pi 1 A/A+ boards.
    default_boot_config_lines=("gpu_mem=32",),
    wifi_firmware_models=("raspberrypi,model-zero-w",),
    needs_zero_2_w_wifi_firmware=False,
    # x86_64 so the Bootlin ARMv6 rootfs toolchain applies.
    default_runner_label="depot-ubuntu-24.04-32",
)

RASPBERRY_PI_64 = BuildrootPlatform(
    key="raspberry-pi-64",
    label="Raspberry Pi Zero 2 W / 3 / 4 (64-bit)",
    family="raspberrypi",
    # One unified 64-bit image the way Raspberry Pi OS ships a single card:
    # start from the Zero 2 W defconfig (same kernel tarball as
    # raspberrypi4_64_defconfig in Buildroot 2025.02) and widen the kernel +
    # firmware selection below so the GPU bootloader picks per model.
    defconfig="raspberrypizero2w_64_defconfig",
    build_target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
    docker_platform="linux/arm64",
    release_target="debian-bookworm-arm64",
    aliases=frozenset(
        {
            "",
            "pi-64",
            "pi-3",
            "pi-4",
            "pi-zero2",
            "pi-zero-2",
            "pi-zero-w2",
            "pi-zero-2-w",
            # The pre-consolidation canonical key: the Zero 2 W was its own
            # single-model platform before it folded into this unified image,
            # and frames created back then store this in their config.
            "raspberry-pi-zero-2-w",
            "raspberry-pi-zero2",
            "raspberry-pi-zero-2",
            "raspberry-pi-zero-w-2",
            "raspberry-pi-3",
            "raspberry-pi-3-b",
            "raspberry-pi-3-b-plus",
            "raspberry-pi-4",
            "raspberry-pi-4-b",
            "raspberry-pi-400",
            "raspberrypi-zero-2-w",
            "raspberrypizero2w",
            "raspberrypi3",
            "raspberrypi4",
            "raspberrypizero2w_defconfig",
            "raspberrypizero2w_64_defconfig",
            "raspberrypi3_64_defconfig",
            "raspberrypi4_64_defconfig",
        }
    ),
    extra_config_lines=(
        # The defconfig's Bootlin *stable* aarch64 toolchain ships 4.19 kernel
        # headers — below NetworkManager's
        # `depends on BR2_TOOLCHAIN_HEADERS_AT_LEAST_4_20` floor — so `make
        # olddefconfig` silently dropped NetworkManager. (Images built before
        # this line still had nmcli only because Buildroot never deletes an
        # already-installed package from a reused output/ directory; the first
        # cache-cold rebuild would have lost it.) The bleeding-edge Bootlin
        # toolchain is the same 2024.05-1 release with gcc 14 and 5.15
        # headers, which NetworkManager accepts. Generic aarch64 code runs on
        # Cortex-A53 and Cortex-A72 alike.
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_AARCH64_GLIBC_BLEEDING_EDGE=y",
        # The bcm2711 kernel defconfig supports BCM2710 (Zero 2 W / Pi 3) and
        # BCM2711 (Pi 4 / 400 / CM4) in one Image — it is what Raspberry Pi OS
        # 64-bit builds its single kernel8.img from. The Zero 2 W defconfig's
        # bcmrpi3 defconfig lacks BCM2711.
        'BR2_LINUX_KERNEL_DEFCONFIG="bcm2711"',
        # All DTBs on the boot partition; the firmware auto-selects by model.
        'BR2_LINUX_KERNEL_INTREE_DTS_NAME="broadcom/bcm2710-rpi-zero-2-w broadcom/bcm2710-rpi-3-b broadcom/bcm2710-rpi-3-b-plus broadcom/bcm2711-rpi-4-b broadcom/bcm2711-rpi-400 broadcom/bcm2711-rpi-cm4"',
        # The rpi-firmware variants are additive booleans, not a choice: the
        # base defconfig already selects VARIANT_PI (start.elf/fixup.dat, for
        # Zero 2 W / Pi 3) + BOOTCODE_BIN; adding VARIANT_PI4 stages
        # start4.elf/fixup4.dat next to them for Pi 4 / 400 / CM4.
        "BR2_PACKAGE_RPI_FIRMWARE_VARIANT_PI4=y",
    ),
    # Both firmware sets + all DTBs + the bigger bcm2711 kernel + overlays
    # don't fit the 32M single-model boot partition.
    boot_partition_size="64M",
    # The Buildroot sample config.txt pins start_file=start.elf, which would
    # make a Pi 4 load Pi-3-generation firmware and fail to boot. With the
    # pins removed the bootloader auto-selects start.elf vs start4.elf.
    remove_boot_config_keys=("start_file", "fixup_file"),
    # Same 512MB-class default as the Zero 2 W; ignored where irrelevant.
    default_boot_config_lines=("gpu_mem=32",),
    # Zero 2 W BCM43436 quirk applies to the unified image too; Pi 3/3B+/4
    # blobs (43430/43455 incl. board-specific NVRAMs) already come from
    # BR2_PACKAGE_BRCMFMAC_SDIO_FIRMWARE_RPI.
    wifi_firmware_models=(
        "raspberrypi,model-zero-2-w",
        "raspberrypi,model-zero-2-2",
    ),
    needs_zero_2_w_wifi_firmware=True,
    default_runner_label="depot-ubuntu-24.04-arm-32",
)

RASPBERRY_PI_5 = BuildrootPlatform(
    key="raspberry-pi-5",
    label="Raspberry Pi 5 / CM5 (64-bit)",
    family="raspberrypi",
    # BCM2712 needs its own kernel (bcm2712 defconfig) and boots without any
    # start*.elf/bootcode.bin — the EEPROM bootloader loads the kernel Image
    # straight off the FAT partition — so it cannot join the unified
    # raspberry-pi-64 image above.
    defconfig="raspberrypi5_defconfig",
    build_target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
    docker_platform="linux/arm64",
    release_target="debian-bookworm-arm64",
    aliases=frozenset(
        {
            "pi-5",
            "pi5",
            "cm5",
            "raspberry-pi-5-b",
            "raspberry-pi-cm5",
            "raspberrypi5",
            "raspberrypi5_defconfig",
        }
    ),
    extra_config_lines=(
        # raspberrypi5_defconfig builds its toolchain from source; switch to
        # the prebuilt Bootlin bleeding-edge aarch64 toolchain (same one the
        # other 64-bit entries use — generic aarch64 runs fine on Cortex-A76,
        # and its 5.15 headers keep NetworkManager). Only available on x86_64
        # build hosts; elsewhere olddefconfig falls back to from-source.
        "BR2_TOOLCHAIN_EXTERNAL=y",
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN=y",
        "BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_AARCH64_GLIBC_BLEEDING_EDGE=y",
        # raspberrypi5_defconfig turns DTB overlays off; FrameOS needs them
        # for the SPI/I2C e-ink display dtoverlay= lines.
        "BR2_PACKAGE_RPI_FIRMWARE_INSTALL_DTB_OVERLAYS=y",
        # Every BCM2712 board runs this same kernel; the EEPROM bootloader
        # picks the DTB by exact model name (the sample config_5.txt carries
        # no device_tree= pin), so shipping the CM5 DTBs alongside the two
        # Pi 5 steppings (C0 + D0) makes one image cover Pi 5 and CM5 on
        # both carrier boards. Pi 500 and CM5 Lite need
        # bcm2712-rpi-500/bcm2712-rpi-cm5l-* DTS files that entered
        # rpi-6.6.y only after the 2024-04 kernel commit Buildroot 2025.02
        # pins — they join automatically on the next Buildroot/kernel bump.
        'BR2_LINUX_KERNEL_INTREE_DTS_NAME="broadcom/bcm2712-rpi-5-b broadcom/bcm2712d0-rpi-5-b broadcom/bcm2712-rpi-cm5-cm5io broadcom/bcm2712-rpi-cm5-cm4io"',
    ),
    # The shared FrameOS config points BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES
    # at /work/linux-fragment.config, which *replaces* the defconfig's
    # board/raspberrypi/linux-4k-page-size.fragment — without re-adding it
    # here the bcm2712 kernel defaults to 16K pages, which breaks page-size
    # assumptions in prebuilt userspace.
    kernel_fragment_lines=("CONFIG_ARM64_4K_PAGES=y",),
    # bcm2712 kernel Image + DTBs + overlays outgrow the 32M boot partition.
    boot_partition_size="64M",
    # No gpu_mem on the Pi 5 (firmware ignores it; memory split is fixed).
    default_boot_config_lines=(),
    # Pi 5 Wi-Fi is a BCM43455; generic + board-specific NVRAM files ship in
    # BR2_PACKAGE_BRCMFMAC_SDIO_FIRMWARE_RPI already.
    wifi_firmware_models=(),
    needs_zero_2_w_wifi_firmware=False,
    default_runner_label="depot-ubuntu-24.04-arm-32",
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
        RASPBERRY_PI_32,
        RASPBERRY_PI_64,
        RASPBERRY_PI_5,
        LUCKFOX_PICO,
        ALLWINNER_T113,
    )
}

DEFAULT_BUILDROOT_PLATFORM = RASPBERRY_PI_64.key

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
