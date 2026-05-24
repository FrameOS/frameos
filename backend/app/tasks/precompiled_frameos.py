from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

import httpx

from app.codegen.drivers_nim import COMPILATION_MODE_SHARED
from app.drivers.devices import drivers_for_frame
from app.models.frame import Frame
from app.tasks._frame_deployer import FrameDeployer
from app.utils.versions import get_versions

RELEASE_BASE_URL = os.environ.get(
    "FRAMEOS_PRECOMPILED_RELEASE_BASE_URL",
    "https://github.com/FrameOS/frameos/releases/download/",
)
RELEASE_TIMEOUT = float(os.environ.get("FRAMEOS_PRECOMPILED_TIMEOUT", "60"))
SAFE_RELEASE_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]+$")
SAFE_CACHE_FILENAME = re.compile(r"[^A-Za-z0-9_.-]+")


@dataclass(slots=True)
class PrecompiledFrameOSResult:
    release_url: str
    binary_path: str
    driver_library_paths: list[str]
    driver_library_names: list[str]
    scene_library_paths: list[str]
    scene_library_names: list[str]
    vendor_folders: list[str]
    archive_path: str
    cache_hit: bool = False


def frame_compiled_scene_count(frame: Frame) -> int:
    count = 0
    for scene in getattr(frame, "scenes", None) or []:
        if not isinstance(scene, dict):
            continue
        execution = scene.get("settings", {}).get("execution", "compiled")
        if execution != "interpreted":
            count += 1
    return count


def release_version() -> str | None:
    versions = get_versions()
    for key in ("docker", "frameos"):
        version = versions.get(key)
        if isinstance(version, str) and version:
            return version.split("+", 1)[0]
    return None


def precompiled_frameos_release_url(target: str, version: str | None = None) -> str | None:
    resolved_version = version or release_version()
    if not resolved_version or not target:
        return None
    if not SAFE_RELEASE_SEGMENT.fullmatch(resolved_version) or not SAFE_RELEASE_SEGMENT.fullmatch(target):
        return None
    base = RELEASE_BASE_URL if RELEASE_BASE_URL.endswith("/") else f"{RELEASE_BASE_URL}/"
    return urljoin(base, f"v{resolved_version}/frameos-{resolved_version}-{target}.tar.gz")


async def download_precompiled_frameos_release(
    *,
    frame: Frame,
    target: str,
    build_dir: str,
    temp_dir: str,
    build_id: str,
    logger,
    timeout: float = RELEASE_TIMEOUT,
) -> PrecompiledFrameOSResult:
    url = precompiled_frameos_release_url(target)
    if not url:
        raise RuntimeError("Unable to construct precompiled FrameOS release URL")

    release_archive_path, cache_hit = await _cached_release_archive(url, target, timeout, logger)
    build_path = Path(build_dir)
    build_path.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="frameos-precompiled-") as extract_tmp:
        extract_dir = Path(extract_tmp) / "extract"
        extract_dir.mkdir()
        with tarfile.open(release_archive_path, "r:gz") as tar:
            _safe_extract(tar, extract_dir)

        artifact_root = _find_artifact_root(extract_dir, target)
        if not artifact_root:
            raise RuntimeError(f"Precompiled FrameOS archive did not contain target {target}")

        required_driver_names = FrameDeployer.driver_library_names(
            drivers_for_frame(frame),
            COMPILATION_MODE_SHARED,
        )
        copied_driver_paths = _copy_required_drivers(
            artifact_root=artifact_root,
            build_dir=build_path,
            required_driver_names=required_driver_names,
        )
        vendor_folders = _copy_required_vendor_folders(
            artifact_root=artifact_root,
            build_dir=build_path,
            frame=frame,
        )

        binary_src = artifact_root / "frameos"
        if not binary_src.is_file():
            raise RuntimeError("Precompiled FrameOS archive is missing frameos binary")
        binary_dest = build_path / "frameos"
        shutil.copy2(binary_src, binary_dest)
        os.chmod(binary_dest, 0o755)

    result_archive_base = Path(temp_dir) / f"precompiled_{build_id}"
    result_archive = shutil.make_archive(str(result_archive_base), "gztar", str(build_path))
    return PrecompiledFrameOSResult(
        release_url=url,
        binary_path=str(binary_dest),
        driver_library_paths=[str(path) for path in copied_driver_paths],
        driver_library_names=required_driver_names,
        scene_library_paths=[],
        scene_library_names=[],
        vendor_folders=vendor_folders,
        archive_path=result_archive,
        cache_hit=cache_hit,
    )


def precompiled_frameos_cache_dir() -> Path:
    configured = os.environ.get("FRAMEOS_PRECOMPILED_CACHE_DIR")
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "frameos-precompiled-cache"


def precompiled_frameos_cache_path(url: str) -> Path:
    filename = url.rsplit("/", 1)[-1] or "frameos-precompiled.tar.gz"
    safe_filename = SAFE_CACHE_FILENAME.sub("_", filename)
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return precompiled_frameos_cache_dir() / f"{digest}-{safe_filename}"


async def _cached_release_archive(
    url: str,
    target: str,
    timeout: float,
    logger,
    label: str = "FrameOS",
) -> tuple[Path, bool]:
    cache_path = precompiled_frameos_cache_path(url)
    if _has_cached_archive(cache_path):
        await logger("stdout", f"Using cached precompiled {label} release for {target}")
        return cache_path, True

    await logger("stdout", f"Downloading precompiled {label} release for {target}")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if _has_cached_archive(cache_path):
        await logger("stdout", f"Using cached precompiled {label} release for {target}")
        return cache_path, True

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{cache_path.name}.",
            suffix=".part",
            dir=cache_path.parent,
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        await _download(url, temp_path, timeout)
        if not _has_cached_archive(temp_path):
            raise RuntimeError("Downloaded precompiled FrameOS release was empty")
        os.replace(temp_path, cache_path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return cache_path, False


def _has_cached_archive(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


async def _download(url: str, destination: Path, timeout: float) -> None:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with destination.open("wb") as fh:
                async for chunk in response.aiter_bytes():
                    fh.write(chunk)


def _safe_extract(tar: tarfile.TarFile, path: Path) -> None:
    root = path.resolve()
    for member in tar.getmembers():
        member_path = (path / member.name).resolve()
        if os.path.commonpath([str(root), str(member_path)]) != str(root):
            raise RuntimeError("Tar file attempted to escape target directory")
    tar.extractall(path=path, filter="data")


def _find_release_artifact_root(extract_dir: Path, target: str, binary_name: str) -> Path | None:
    candidates = []
    for metadata_path in extract_dir.rglob("metadata.json"):
        root = metadata_path.parent
        if not (root / binary_name).is_file():
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            metadata = {}
        if metadata.get("slug") == target:
            return root
        candidates.append(root)

    legacy = extract_dir / "prebuilt-cross" / target
    if (legacy / binary_name).is_file():
        return legacy

    if len(candidates) == 1:
        return candidates[0]
    return None


def _find_artifact_root(extract_dir: Path, target: str) -> Path | None:
    return _find_release_artifact_root(extract_dir, target, "frameos")


def _copy_required_drivers(
    *,
    artifact_root: Path,
    build_dir: Path,
    required_driver_names: list[str],
) -> list[Path]:
    if not required_driver_names:
        return []
    source_dir = artifact_root / "drivers"
    destination_dir = build_dir / "drivers"
    destination_dir.mkdir(parents=True, exist_ok=True)
    copied_paths: list[Path] = []
    missing = []
    for driver_name in required_driver_names:
        source = source_dir / driver_name
        if not source.is_file():
            missing.append(driver_name)
            continue
        destination = destination_dir / driver_name
        shutil.copy2(source, destination)
        copied_paths.append(destination)
    if missing:
        raise RuntimeError(
            "Precompiled FrameOS archive is missing required driver libraries: "
            + ", ".join(sorted(missing))
        )
    return copied_paths


def _copy_required_vendor_folders(
    *,
    artifact_root: Path,
    build_dir: Path,
    frame: Frame,
) -> list[str]:
    required = sorted(
        {
            driver.vendor_folder
            for driver in drivers_for_frame(frame).values()
            if getattr(driver, "vendor_folder", None)
        }
    )
    if not required:
        return []
    source_root = artifact_root / "vendor"
    destination_root = build_dir / "vendor"
    destination_root.mkdir(parents=True, exist_ok=True)
    missing = []
    copied: list[str] = []
    for folder in required:
        source = source_root / folder
        if not source.is_dir():
            missing.append(folder)
            continue
        shutil.copytree(source, destination_root / folder, dirs_exist_ok=True)
        copied.append(folder)
    if missing:
        raise RuntimeError(
            "Precompiled FrameOS archive is missing required vendor folders: "
            + ", ".join(sorted(missing))
        )
    return copied
