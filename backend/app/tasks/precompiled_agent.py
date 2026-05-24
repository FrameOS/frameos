from __future__ import annotations

import json
import os
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.tasks.precompiled_frameos import (
    RELEASE_TIMEOUT,
    _cached_release_archive,
    _safe_extract,
    precompiled_frameos_release_url,
)


@dataclass(slots=True)
class PrecompiledAgentResult:
    release_url: str
    binary_path: str
    archive_path: str
    cache_hit: bool = False


def precompiled_agent_release_url(target: str, version: str | None = None) -> str | None:
    return precompiled_frameos_release_url(target, version)


async def download_precompiled_agent_release(
    *,
    target: str,
    build_dir: str,
    temp_dir: str,
    build_id: str,
    logger,
    timeout: float = RELEASE_TIMEOUT,
) -> PrecompiledAgentResult:
    url = precompiled_agent_release_url(target)
    if not url:
        raise RuntimeError("Unable to construct precompiled FrameOS release URL for agent")

    release_archive_path, cache_hit = await _cached_release_archive(
        url,
        target,
        timeout,
        logger,
        label="FrameOS",
    )
    build_path = Path(build_dir)
    build_path.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="frameos-agent-precompiled-") as extract_tmp:
        extract_dir = Path(extract_tmp) / "extract"
        extract_dir.mkdir()
        with tarfile.open(release_archive_path, "r:gz") as tar:
            _safe_extract(tar, extract_dir)

        artifact_root = _find_agent_artifact_root(extract_dir, target)
        if not artifact_root:
            raise RuntimeError(f"Precompiled FrameOS archive did not contain agent for target {target}")

        binary_src = artifact_root / "frameos_agent"
        if not binary_src.is_file():
            raise RuntimeError("Precompiled FrameOS archive is missing frameos_agent binary")
        binary_dest = build_path / "frameos_agent"
        shutil.copy2(binary_src, binary_dest)
        os.chmod(binary_dest, 0o755)

    result_archive_base = Path(temp_dir) / f"precompiled_agent_{build_id}"
    result_archive = shutil.make_archive(str(result_archive_base), "gztar", str(build_path))
    return PrecompiledAgentResult(
        release_url=url,
        binary_path=str(binary_dest),
        archive_path=result_archive,
        cache_hit=cache_hit,
    )


def _find_agent_artifact_root(extract_dir: Path, target: str) -> Path | None:
    expected = extract_dir / "prebuilt-cross" / target
    if (expected / "frameos_agent").is_file():
        return expected

    candidates = []
    for metadata_path in extract_dir.rglob("metadata.json"):
        root = metadata_path.parent
        if not (root / "frameos_agent").is_file():
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            metadata = {}
        if metadata.get("slug") == target:
            return root
        candidates.append(root)
    if len(candidates) == 1:
        return candidates[0]
    return None
