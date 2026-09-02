"""The precompiled FrameOS release matrix.

One entry per `frameos-<version>-<slug>.tar.gz` on a GitHub release. This is
the single source of truth for what gets built (`backend/bin/cross matrix`
feeds it to the release workflow) and for what a deploy may download: a
frame whose distro/arch resolves to a slug outside this set (Raspberry Pi
OS bullseye, say) gets no release tarball and has to build from source,
so the deploy planner checks here before promising a precompiled install.

A release binary only runs on the distro it was built for or newer — the
bookworm build needs glibc 2.34+ symbols and refuses to load on bullseye
(glibc 2.31) — so there is deliberately no "nearest newer release"
fallback here.
"""
from __future__ import annotations

from dataclasses import dataclass

# Runner assignment (post-Depot, 2026-08): amd64 and the armv6
# cross-toolchain targets build on the self-hosted EPYC pool ("epyc-8" =
# ephemeral 8-core Incus VMs on the monster host; see the host's
# /srv/gha-runners/README.md). Both ARM targets build on GitHub's free
# ubuntu-24.04-arm runners (Ampere Altra): arm64 natively, and armhf too —
# Ampere runs AArch32 at EL0, unlike AWS Graviton (Depot), where armhf fell
# back to QEMU (measured 773-825s emulated vs 501-516s native across two
# releases, on par with arm64's 507s).
# The permanent fix is to give linux/arm/v7 the same treatment as arm/v6 (an
# amd64 container plus the arm-linux-gnueabihf cross toolchain that
# cross_toolchain_packages.py already defines and the Modal executor already
# uses); until that is validated, keep armhf on GitHub's ARM runners.
ARMHF_RUNNER = "ubuntu-24.04-arm"
ARM64_RUNNER = "ubuntu-24.04-arm"


@dataclass(frozen=True)
class TargetDefinition:
    distro: str
    version: str
    arch: str
    platform: str
    image: str
    runner: str = "epyc-8"

    @property
    def slug(self) -> str:
        return f"{self.distro}-{self.version}-{self.arch}"

    def to_matrix_entry(self) -> dict[str, str]:
        return {
            "slug": self.slug,
            "distro": self.distro,
            "version": self.version,
            "arch": self.arch,
            "platform": self.platform,
            "image": self.image,
            "runner": self.runner,
        }


TARGETS: tuple[TargetDefinition, ...] = (
    TargetDefinition("debian", "bookworm", "armhf", "linux/arm/v7", "debian:bookworm", runner=ARMHF_RUNNER),
    TargetDefinition("debian", "bookworm", "arm64", "linux/arm64", "debian:bookworm", runner=ARM64_RUNNER),
    TargetDefinition("debian", "bookworm", "amd64", "linux/amd64", "debian:bookworm"),
    # ARMv6 hard-float for the Raspberry Pi Zero W Buildroot image. Debian has
    # no ARMv6 port, so this builds in an amd64 container with the Bootlin
    # armv6-eabihf toolchain (see cross_toolchain_packages.py); armhf packages
    # only provide headers and link stubs.
    TargetDefinition("debian", "bookworm", "armv6", "linux/arm/v6", "debian:bookworm"),
    TargetDefinition("debian", "trixie", "armhf", "linux/arm/v7", "debian:trixie", runner=ARMHF_RUNNER),
    TargetDefinition("debian", "trixie", "arm64", "linux/arm64", "debian:trixie", runner=ARM64_RUNNER),
    TargetDefinition("debian", "trixie", "amd64", "linux/amd64", "debian:trixie"),
    # Same Bootlin-toolchain build as bookworm armv6 (Raspberry Pi OS trixie
    # still supports the Pi Zero W / Pi 1). Trixie's OpenSSL stubs pull
    # libz/libzstd transitively at link time — needs the -rpath-link mirror
    # flag in cross_compile.py.
    TargetDefinition("debian", "trixie", "armv6", "linux/arm/v6", "debian:trixie"),
    TargetDefinition("ubuntu", "24.04", "arm64", "linux/arm64", "ubuntu:24.04", runner=ARM64_RUNNER),
    TargetDefinition("ubuntu", "24.04", "amd64", "linux/amd64", "ubuntu:24.04"),
    TargetDefinition("ubuntu", "26.04", "arm64", "linux/arm64", "ubuntu:26.04", runner=ARM64_RUNNER),
    TargetDefinition("ubuntu", "26.04", "amd64", "linux/amd64", "ubuntu:26.04"),
    # TODO(rockchip/allwinner): 32-bit ARMv7 targets for Luckfox Pico
    # (RV1103/RV1106) and T113-S3/S4 boards can reuse the armhf toolchain:
    # TargetDefinition("buildroot", "luckfox-pico-plus", "armv7l", "linux/amd64", "ubuntu:26.04"),
)

TARGET_MAP: dict[str, TargetDefinition] = {target.slug: target for target in TARGETS}
RELEASE_TARGET_SLUGS: frozenset[str] = frozenset(TARGET_MAP)


def precompiled_release_published(slug: str | None) -> bool:
    """True when a release tarball is built for `slug` (a prebuilt-deps slug
    such as `debian-bullseye-arm64`)."""
    return bool(slug) and slug in RELEASE_TARGET_SLUGS


def release_versions() -> tuple[str, ...]:
    """Distro releases with a tarball, in matrix order and without repeats:
    `("bookworm", "trixie", "24.04", "26.04")`."""
    return tuple(dict.fromkeys(target.version for target in TARGETS))


def release_distro_summary() -> str:
    """Human-readable list of released distros, e.g.
    `debian bookworm/trixie, ubuntu 24.04/26.04` — for deploy notes."""
    versions: dict[str, list[str]] = {}
    for target in TARGETS:
        bucket = versions.setdefault(target.distro, [])
        if target.version not in bucket:
            bucket.append(target.version)
    return ", ".join(f"{distro} {'/'.join(names)}" for distro, names in versions.items())


__all__ = [
    "ARM64_RUNNER",
    "ARMHF_RUNNER",
    "RELEASE_TARGET_SLUGS",
    "TARGETS",
    "TARGET_MAP",
    "TargetDefinition",
    "precompiled_release_published",
    "release_distro_summary",
    "release_versions",
]
