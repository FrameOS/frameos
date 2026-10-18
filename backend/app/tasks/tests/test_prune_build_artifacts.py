from __future__ import annotations

import os
import time

import pytest

from app.models.frame import new_frame
from app.tasks import prune_build_artifacts as prune_module
from app.tasks.prune_build_artifacts import (
    ARTIFACT_GRACE_SECONDS,
    prune_build_artifacts_task,
    prune_cached_release_sd_images,
    prune_sd_image_artifacts,
)


def _write(path, age_seconds: float, now: float):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"image")
    os.utime(path, (now - age_seconds, now - age_seconds))
    return path


@pytest.mark.asyncio
async def test_sd_images_no_frame_points_at_are_pruned_after_the_grace_period(db, redis, tmp_path, monkeypatch):
    monkeypatch.setenv("FRAMEOS_ARTIFACT_DIR", str(tmp_path))
    now = time.time()
    old = ARTIFACT_GRACE_SECONDS + 60
    frame = await new_frame(db, redis, "SdImageFrame", "frame.local", "backend.local")

    current = _write(tmp_path / f"frameos-{frame.id}-raspberry-pi-64-new.img", old, now)
    current_gz = _write(tmp_path / f"frameos-{frame.id}-raspberry-pi-64-new.img.gz", old, now)
    frame.buildroot = {"sdImage": {"status": "ready", "path": str(current)}}
    db.add(frame)
    db.commit()

    superseded = _write(tmp_path / f"frameos-{frame.id}-raspberry-pi-64-old.img.gz", old, now)
    deleted_frames = _write(tmp_path / "frameos-999999-raspberry-pi-5-gone.img.gz", old, now)
    being_written = _write(tmp_path / f"frameos-{frame.id}-raspberry-pi-64-building.img", 60, now)
    timings = _write(tmp_path / "buildroot-timings.tsv", old, now)
    cache_file = _write(tmp_path / ".buildroot-cache" / "frameos-1-x.img.gz", old, now)

    removed = prune_sd_image_artifacts(db, now=now)

    assert sorted(removed) == sorted([superseded, deleted_frames])
    for kept in (current, current_gz, being_written, timings, cache_file):
        assert kept.exists()
    assert not superseded.exists() and not deleted_frames.exists()


def test_cached_release_sd_images_keep_only_the_current_release(tmp_path, monkeypatch):
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_SD_IMAGE_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(prune_module, "release_version", lambda: "2026.10.16")
    now = time.time()
    old = ARTIFACT_GRACE_SECONDS + 60

    current = _write(tmp_path / "0123456789abcdef-frameos-2026.10.16-raspberry-pi-64-buildroot.img.gz", old, now)
    current_sig = _write(tmp_path / "0123456789abcdef-frameos-2026.10.16-raspberry-pi-64-buildroot.img.gz.minisig", old, now)
    stale = _write(tmp_path / "fedcba9876543210-frameos-2026.9.22-raspberry-pi-5-buildroot.img.gz", old, now)
    stale_sig = _write(tmp_path / "fedcba9876543210-frameos-2026.9.22-raspberry-pi-5-buildroot.img.gz.minisig", old, now)
    fresh_stale = _write(tmp_path / "aaaaaaaaaaaaaaaa-frameos-2026.9.21-raspberry-pi-5-buildroot.img.gz", 60, now)
    unrelated = _write(tmp_path / "tmpdownload.part", old, now)

    removed = prune_cached_release_sd_images(now=now)

    assert sorted(removed) == sorted([stale, stale_sig])
    for kept in (current, current_sig, fresh_stale, unrelated):
        assert kept.exists()


def test_cached_release_sd_images_are_kept_when_the_release_is_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_SD_IMAGE_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(prune_module, "release_version", lambda: None)
    now = time.time()
    stale = _write(tmp_path / "fedcba9876543210-frameos-2026.9.22-raspberry-pi-5-buildroot.img.gz",
                   ARTIFACT_GRACE_SECONDS + 60, now)
    assert prune_cached_release_sd_images(now=now) == []
    assert stale.exists()


@pytest.mark.asyncio
async def test_prune_task_runs_on_empty_directories(db, tmp_path, monkeypatch):
    monkeypatch.setenv("FRAMEOS_ARTIFACT_DIR", str(tmp_path / "missing"))
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_SD_IMAGE_CACHE_DIR", str(tmp_path / "missing-cache"))
    assert await prune_build_artifacts_task({"db": db}) == {"sdImages": 0, "cachedReleaseImages": 0}


def test_worker_schedules_the_prune():
    from app.tasks.worker import WorkerSettings

    assert [job.name for job in WorkerSettings.cron_jobs] == ["prune_build_artifacts"]
