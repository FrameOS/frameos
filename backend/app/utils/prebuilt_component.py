from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Sequence

import httpx

from app.tasks.prebuilt_deps import PrebuiltEntry, fetch_prebuilt_manifest

PREBUILT_TIMEOUT = float(os.environ.get("FRAMEOS_PREBUILT_TIMEOUT", "20"))


def _first_file_match(root: Path, pattern: str) -> Path | None:
    matches = sorted(path for path in root.rglob(pattern) if path.is_file())
    return matches[0] if matches else None


def _quickjs_tree_is_usable(root: Path) -> bool:
    return (
        _first_file_match(root, "quickjs.h") is not None
        and _first_file_match(root, "quickjs-libc.h") is not None
        and _first_file_match(root, "libquickjs.a") is not None
    )


def _lgpio_tree_is_usable(root: Path) -> bool:
    return (
        _first_file_match(root, "lgpio.h") is not None
        and (
            _first_file_match(root, "liblgpio.a") is not None
            or _first_file_match(root, "liblgpio.so*") is not None
        )
    )


def _component_is_usable(component: str, root: Path) -> bool:
    if component == "quickjs":
        return _quickjs_tree_is_usable(root)
    if component == "lgpio":
        return _lgpio_tree_is_usable(root)
    return root.exists()


def _copy_component_tree(source_dir: Path, dest_dir: Path) -> None:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Missing prebuilt component directory: {source_dir}")
    for child in source_dir.iterdir():
        target = dest_dir / child.name
        if child.is_dir():
            shutil.copytree(child, target, dirs_exist_ok=True)
        else:
            shutil.copy2(child, target)


def _normalize_component_dir(dest_dir: Path) -> None:
    entries = [path for path in dest_dir.iterdir() if path.name != ".build-info"]
    subdirs = [path for path in entries if path.is_dir()]
    files = [path for path in entries if path.is_file()]
    if files or not subdirs or len(subdirs) != 1:
        return

    inner = subdirs[0]
    for child in inner.iterdir():
        shutil.move(str(child), dest_dir / child.name)
    shutil.rmtree(inner)


def _file_md5sum(path: Path) -> str:
    hasher = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


async def _download_and_extract(
    url: str,
    dest_dir: Path,
    expected_md5: str | None,
    *,
    timeout: float = PREBUILT_TIMEOUT,
) -> None:
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
    os.close(tmp_fd)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                with open(tmp_path, "wb") as fh:
                    async for chunk in response.aiter_bytes():
                        fh.write(chunk)
        if expected_md5:
            actual_md5 = _file_md5sum(Path(tmp_path))
            if actual_md5 != expected_md5:
                raise RuntimeError(f"MD5 mismatch for {url}: expected {expected_md5}, got {actual_md5}")
        with tarfile.open(tmp_path, "r:gz") as tar:
            _safe_extract(tar, dest_dir)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def _safe_extract(tar: tarfile.TarFile, path: Path) -> None:
    root = path.resolve()
    for member in tar.getmembers():
        if member.issym() or member.islnk() or member.ischr() or member.isblk() or member.isfifo():
            raise RuntimeError("Tar file contained unsupported special entry")
        member_path = (root / member.name).resolve()
        try:
            member_path.relative_to(root)
        except ValueError as exc:
            raise RuntimeError("Tar file attempted to escape target directory") from exc
    tar.extractall(path=root)


async def stage_prebuilt_component(
    entry: PrebuiltEntry,
    *,
    component: str,
    version: str,
    dest_dir: Path,
    expected_marker: str,
    timeout: float = PREBUILT_TIMEOUT,
) -> bool:
    if entry.version_for(component) != version:
        return False

    local_path = entry.path_for(component)
    url = entry.url_for(component)
    if not local_path and not url:
        return False

    shutil.rmtree(dest_dir, ignore_errors=True)
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        if local_path:
            _copy_component_tree(Path(local_path), dest_dir)
        else:
            await _download_and_extract(url, dest_dir, entry.md5_for(component), timeout=timeout)
            _normalize_component_dir(dest_dir)

        if not _component_is_usable(component, dest_dir):
            raise RuntimeError(f"prebuilt {component} archive did not contain the expected files")
        (dest_dir / ".build-info").write_text(expected_marker, encoding="utf-8")
        return True
    except Exception:
        shutil.rmtree(dest_dir, ignore_errors=True)
        return False


async def stage_prebuilt_component_from_manifest(
    *,
    target: str,
    component: str,
    version: str,
    dest_dir: Path,
    expected_marker: str,
    base_url: str | None = None,
    timeout: float = PREBUILT_TIMEOUT,
) -> bool:
    try:
        manifest = await fetch_prebuilt_manifest(base_url=base_url)
    except Exception:
        return False

    entry = manifest.get(target)
    if not entry:
        return False

    return await stage_prebuilt_component(
        entry,
        component=component,
        version=version,
        dest_dir=dest_dir,
        expected_marker=expected_marker,
        timeout=timeout,
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage a published prebuilt component into a local directory")
    parser.add_argument("--target", required=True, help="Prebuilt target slug, for example debian-bookworm-arm64")
    parser.add_argument("--component", required=True, help="Component name, for example lgpio")
    parser.add_argument("--version", required=True, help="Component version to require")
    parser.add_argument("--dest", required=True, help="Destination directory to populate")
    parser.add_argument("--expected-marker", required=True, help="Exact .build-info marker to write on success")
    parser.add_argument("--base-url", default=None, help="Optional archive base URL override")
    parser.add_argument("--timeout", type=float, default=PREBUILT_TIMEOUT, help="HTTP timeout in seconds")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    staged = asyncio.run(
        stage_prebuilt_component_from_manifest(
            target=args.target,
            component=args.component,
            version=args.version,
            dest_dir=Path(args.dest).resolve(),
            expected_marker=args.expected_marker,
            base_url=args.base_url,
            timeout=args.timeout,
        )
    )
    return 0 if staged else 1


if __name__ == "__main__":
    raise SystemExit(main())
