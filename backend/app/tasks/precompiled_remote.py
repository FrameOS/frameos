from __future__ import annotations

import os
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.tasks.precompiled_frameos import (
    RELEASE_TIMEOUT,
    _cached_release_archive,
    _find_release_artifact_root,
    _safe_extract,
    precompiled_frameos_release_url,
)


@dataclass(slots=True)
class PrecompiledRemoteResult:
    release_url: str
    binary_path: str
    archive_path: str
    cache_hit: bool = False


def precompiled_remote_release_url(target: str, version: str | None = None) -> str | None:
    return precompiled_frameos_release_url(target, version)


async def download_precompiled_remote_release(
    *,
    target: str,
    build_dir: str,
    temp_dir: str,
    build_id: str,
    logger,
    timeout: float = RELEASE_TIMEOUT,
) -> PrecompiledRemoteResult:
    url = precompiled_remote_release_url(target)
    if not url:
        raise RuntimeError("Unable to construct precompiled FrameOS release URL for remote")

    release_archive_path, cache_hit = await _cached_release_archive(
        url,
        target,
        timeout,
        logger,
        label="FrameOS",
    )
    build_path = Path(build_dir)
    build_path.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="frameos-remote-precompiled-") as extract_tmp:
        extract_dir = Path(extract_tmp) / "extract"
        extract_dir.mkdir()
        with tarfile.open(release_archive_path, "r:gz") as tar:
            _safe_extract(tar, extract_dir)

        artifact_root, binary_name = _find_remote_artifact_root(extract_dir, target)
        if not artifact_root:
            raise RuntimeError(f"Precompiled FrameOS archive did not contain remote for target {target}")

        binary_src = artifact_root / binary_name
        if not binary_src.is_file():
            raise RuntimeError(f"Precompiled FrameOS archive is missing {binary_name} binary")
        binary_dest = build_path / "frameos_remote"
        shutil.copy2(binary_src, binary_dest)
        os.chmod(binary_dest, 0o755)

    result_archive_base = Path(temp_dir) / f"precompiled_remote_{build_id}"
    result_archive = shutil.make_archive(str(result_archive_base), "gztar", str(build_path))
    return PrecompiledRemoteResult(
        release_url=url,
        binary_path=str(binary_dest),
        archive_path=result_archive,
        cache_hit=cache_hit,
    )


def _find_remote_artifact_root(extract_dir: Path, target: str) -> tuple[Path | None, str]:
    for binary_name in ("frameos_remote", "frameos_agent"):
        artifact_root = _find_release_artifact_root(extract_dir, target, binary_name)
        if artifact_root:
            return artifact_root, binary_name
    return None, "frameos_remote"


# Compatibility for older tests/imports during the rename window.
PrecompiledAgentResult = PrecompiledRemoteResult
precompiled_agent_release_url = precompiled_remote_release_url
download_precompiled_agent_release = download_precompiled_remote_release
