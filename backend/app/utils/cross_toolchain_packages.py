from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TargetCrossToolchain:
    dpkg_arch: str
    triplet: str
    cc: str
    packages: tuple[str, ...]
    # Optional standalone toolchain tarball. When set, the compiler comes from
    # this tarball instead of a Debian cross-gcc package, while the apt
    # packages above still provide target headers and link-time library stubs.
    # Needed when no Debian toolchain emits compatible code (e.g. ARMv6
    # hard-float: Debian armhf gcc and its static libgcc are ARMv7-only).
    tarball_url: str | None = None
    tarball_sha256: str | None = None
    tarball_cc: str | None = None
    tarball_cxx: str | None = None


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
    # ARMv6 hard-float (Raspberry Pi Zero W / 1). Compiles with the Bootlin
    # armv6-eabihf toolchain so generated code, crt files, and static libgcc
    # stay ARM1176-safe. The Debian armhf packages are only used for headers
    # and as link-time stubs; at runtime the binary resolves against the
    # Buildroot rootfs libraries, which are built for ARMv6.
    "linux/arm/v6": TargetCrossToolchain(
        dpkg_arch="armhf",
        triplet="arm-linux-gnueabihf",
        cc="arm-linux-gnueabihf-gcc",
        packages=(
            "curl",
            "xz-utils",
            "pkg-config",
            "zlib1g-dev:armhf",
            "libssl-dev:armhf",
            "libffi-dev:armhf",
            "libjpeg-dev:armhf",
            "libfreetype6-dev:armhf",
            "libevdev-dev:armhf",
        ),
        tarball_url=(
            "https://toolchains.bootlin.com/downloads/releases/toolchains/"
            "armv6-eabihf/tarballs/armv6-eabihf--glibc--stable-2024.05-1.tar.xz"
        ),
        tarball_sha256="2924afaa0d47e046339fe70bf526db5a19edaa58d87c6758a861ef41e2781368",
        tarball_cc="arm-buildroot-linux-gnueabihf-gcc",
        tarball_cxx="arm-buildroot-linux-gnueabihf-g++",
    ),
}
# Docker platforms no mainstream distro publishes container images for;
# builds targeting them always run in a container of the mapped platform with
# the matching target cross toolchain above.
CONTAINERLESS_TARGET_PLATFORMS = {
    "linux/arm/v6": "linux/amd64",
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
