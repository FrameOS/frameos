from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TargetCrossToolchain:
    dpkg_arch: str
    triplet: str
    cc: str
    packages: tuple[str, ...]


TARGET_CROSS_TOOLCHAINS = {
    "linux/arm64": TargetCrossToolchain(
        dpkg_arch="arm64",
        triplet="aarch64-linux-gnu",
        cc="aarch64-linux-gnu-gcc",
        packages=(
            "gcc-aarch64-linux-gnu",
            "g++-aarch64-linux-gnu",
            "pkg-config",
            "zlib1g-dev:arm64",
            "libssl-dev:arm64",
            "libffi-dev:arm64",
            "libjpeg-dev:arm64",
            "libfreetype6-dev:arm64",
            "libevdev-dev:arm64",
        ),
    ),
    "linux/arm/v7": TargetCrossToolchain(
        dpkg_arch="armhf",
        triplet="arm-linux-gnueabihf",
        cc="arm-linux-gnueabihf-gcc",
        packages=(
            "gcc-arm-linux-gnueabihf",
            "g++-arm-linux-gnueabihf",
            "pkg-config",
            "zlib1g-dev:armhf",
            "libssl-dev:armhf",
            "libffi-dev:armhf",
            "libjpeg-dev:armhf",
            "libfreetype6-dev:armhf",
            "libevdev-dev:armhf",
        ),
    ),
}
TARGET_CROSS_TOOLCHAIN_PACKAGES = tuple(
    dict.fromkeys(
        package
        for toolchain in TARGET_CROSS_TOOLCHAINS.values()
        for package in toolchain.packages
    )
)
TARGET_CROSS_TOOLCHAIN_DPKG_ARCHS = tuple(
    dict.fromkeys(toolchain.dpkg_arch for toolchain in TARGET_CROSS_TOOLCHAINS.values())
)
