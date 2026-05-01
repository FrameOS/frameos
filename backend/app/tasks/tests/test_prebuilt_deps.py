from __future__ import annotations

import pytest

from app.tasks.prebuilt_deps import resolve_prebuilt_target


@pytest.mark.parametrize(
    ("distro", "version", "arch", "expected"),
    [
        ("buildroot", "t113-s3", "armhf", "buildroot-t113-s3-armhf"),
        ("buildroot", "frameos-t113-s3", "armv7l", "buildroot-t113-s3-armhf"),
        ("buildroot", "allwinner-t113-s3", "armv6l", "buildroot-t113-s3-armhf"),
        ("buildroot", "unknown-board", "armhf", None),
    ],
)
def test_resolve_buildroot_t113_s3_prebuilt_target(
    distro: str,
    version: str,
    arch: str,
    expected: str | None,
):
    assert resolve_prebuilt_target(distro, version, arch) == expected
