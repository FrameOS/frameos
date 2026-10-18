"""Delete build artifacts that nothing points at any more.

Every personalized Buildroot SD image is a new file under the artifact
directory (``frameos-<frame>-<platform>-<build>.img.gz``, plus the ``.gz`` the
download route writes beside a raw image), and the frame row keeps only the
latest one. Rebuilds and deleted frames left the rest on disk for ever, a
gigabyte or two each. The signed release SD images cached for personalization
are re-downloadable, so the ones for other releases go too.

ESP32 frames have no counterpart: the backend builds no firmware, it streams
the signed release image (app/api/firmware_release.py).

Runs daily from the worker (``WorkerSettings.cron_jobs``). A file younger than
the grace period is never touched, so an SD image still being written (the
frame row learns its path only when the build finishes) survives.
"""

from __future__ import annotations

import re
import time
from contextlib import suppress
from pathlib import Path
from typing import Any, Dict, Iterable

from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.tasks.buildroot_image import buildroot_artifact_dir, buildroot_precompiled_sd_image_cache_dir
from app.tasks.precompiled_frameos import release_version

ARTIFACT_GRACE_SECONDS = 24 * 60 * 60

# What the SD image builder writes at the top of the artifact directory. The
# directory also holds the build's own caches (``.buildroot-cache``) and
# timing files, which are left alone.
_SD_IMAGE_NAME = re.compile(r"^frameos-.+\.img(\.gz)?$")
# precompiled_buildroot_sd_image_cache_path: ``<digest>-frameos-<version>-<platform>-buildroot.img.gz``
# and its ``.minisig``. A release version (``2026.10.16``) has no dash.
_CACHED_RELEASE_IMAGE_NAME = re.compile(
    r"^[0-9a-f]{16}-frameos-(?P<version>[^-]+)-[A-Za-z0-9_.-]+-buildroot\.img\.gz(\.minisig)?$"
)


def _referenced_sd_image_paths(db: Session) -> set[Path]:
    keep: set[Path] = set()
    for (buildroot,) in db.query(Frame.buildroot).all():
        sd_image = buildroot.get("sdImage") if isinstance(buildroot, dict) else None
        path = sd_image.get("path") if isinstance(sd_image, dict) else None
        if not isinstance(path, str) or not path:
            continue
        for candidate in (path, f"{path}.gz"):
            with suppress(OSError, RuntimeError, ValueError):
                keep.add(Path(candidate).resolve())
    return keep


def _old_regular_files(directory: Path, now: float, grace_seconds: float) -> Iterable[Path]:
    if not directory.is_dir():
        return
    for entry in directory.iterdir():
        try:
            if entry.is_symlink() or not entry.is_file():
                continue
            if now - entry.stat().st_mtime < grace_seconds:
                continue
        except OSError:
            continue
        yield entry


def prune_sd_image_artifacts(
    db: Session, *, now: float | None = None, grace_seconds: float = ARTIFACT_GRACE_SECONDS
) -> list[Path]:
    """Remove personalized SD images no frame row names as its current image."""
    keep = _referenced_sd_image_paths(db)
    removed: list[Path] = []
    for entry in _old_regular_files(buildroot_artifact_dir(), now or time.time(), grace_seconds):
        if not _SD_IMAGE_NAME.match(entry.name):
            continue
        with suppress(OSError, RuntimeError):
            if entry.resolve() in keep:
                continue
            entry.unlink()
            removed.append(entry)
    return removed


def prune_cached_release_sd_images(
    *, now: float | None = None, grace_seconds: float = ARTIFACT_GRACE_SECONDS
) -> list[Path]:
    """Remove cached release SD images (and their signatures) for any release
    but the one this backend targets."""
    current = release_version()
    if not current:
        return []
    removed: list[Path] = []
    for entry in _old_regular_files(buildroot_precompiled_sd_image_cache_dir(), now or time.time(), grace_seconds):
        match = _CACHED_RELEASE_IMAGE_NAME.match(entry.name)
        if not match or match.group("version") == current:
            continue
        with suppress(OSError):
            entry.unlink()
            removed.append(entry)
    return removed


async def prune_build_artifacts_task(ctx: Dict[str, Any]) -> dict[str, int]:
    db: Session = ctx["db"]
    sd_images = prune_sd_image_artifacts(db)
    cached = prune_cached_release_sd_images()
    if sd_images or cached:
        print(f"Pruned build artifacts: {len(sd_images)} SD image file(s), {len(cached)} cached release file(s)")
    return {"sdImages": len(sd_images), "cachedReleaseImages": len(cached)}
