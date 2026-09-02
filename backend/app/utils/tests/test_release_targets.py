from __future__ import annotations

import importlib.util
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

from app.tasks.buildroot_platforms import BUILDROOT_PLATFORMS
from app.utils.release_targets import (
    RELEASE_TARGET_SLUGS,
    TARGETS,
    precompiled_release_published,
    release_distro_summary,
)

CROSS_PATH = Path(__file__).resolve().parents[3] / "bin" / "cross"
SETUP_SH = Path(__file__).resolve().parents[4] / "scripts" / "frameos-setup.sh"


def test_release_matrix_covers_bookworm_trixie_and_ubuntu_only():
    assert RELEASE_TARGET_SLUGS == {
        "debian-bookworm-armhf",
        "debian-bookworm-arm64",
        "debian-bookworm-amd64",
        "debian-bookworm-armv6",
        "debian-trixie-armhf",
        "debian-trixie-arm64",
        "debian-trixie-amd64",
        "debian-trixie-armv6",
        "ubuntu-24.04-arm64",
        "ubuntu-24.04-amd64",
        "ubuntu-26.04-arm64",
        "ubuntu-26.04-amd64",
    }
    assert precompiled_release_published("debian-bookworm-arm64")
    # bullseye is a valid prebuilt-deps slug but no release ships for it.
    assert not precompiled_release_published("debian-bullseye-arm64")
    assert not precompiled_release_published(None)
    assert not precompiled_release_published("")


def test_release_distro_summary_reads_naturally():
    assert release_distro_summary() == "debian bookworm/trixie, ubuntu 24.04/26.04"


def test_bin_cross_uses_the_shared_release_matrix():
    loader = SourceFileLoader("frameos_backend_bin_cross_release_targets_test", str(CROSS_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    assert module.TARGETS is TARGETS
    assert set(module.TARGET_MAP) == RELEASE_TARGET_SLUGS


def test_every_buildroot_platform_installs_a_published_release():
    for platform in BUILDROOT_PLATFORMS.values():
        assert precompiled_release_published(platform.release_target), platform.release_target


def test_setup_script_supported_releases_match_the_matrix():
    line = next(
        line for line in SETUP_SH.read_text(encoding="utf-8").splitlines() if line.startswith("SUPPORTED_RELEASES=")
    )
    supported = set(line.split("=", 1)[1].strip('"').split())
    assert supported == {f"{target.distro}:{target.version}" for target in TARGETS}
