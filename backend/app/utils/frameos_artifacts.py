from __future__ import annotations

import re
from pathlib import Path


_BASE_VERSION_PATTERN = re.compile(r"^\d+(?:\.\d+)*$")


def normalize_release_version(value: str) -> str:
    cleaned = str(value or "").strip().split("+", 1)[0]
    if not cleaned:
        raise ValueError("release version must not be empty")
    if not _BASE_VERSION_PATTERN.fullmatch(cleaned):
        raise ValueError(f"unsupported release version format: {value!r}")
    return cleaned


def release_version_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in normalize_release_version(value).split("."))


def versioned_artifact_name(stem: str, version: str, suffix: str) -> str:
    normalized_suffix = suffix if suffix.startswith(".") or not suffix else f".{suffix}"
    return f"{stem}.{normalize_release_version(version)}{normalized_suffix}"


def parse_versioned_artifact_name(filename: str, *, stem: str, suffix: str) -> str | None:
    normalized_suffix = suffix if suffix.startswith(".") or not suffix else f".{suffix}"
    prefix = f"{stem}."
    if not filename.startswith(prefix) or not filename.endswith(normalized_suffix):
        return None
    version = filename[len(prefix) : len(filename) - len(normalized_suffix)]
    try:
        return normalize_release_version(version)
    except ValueError:
        return None


def iter_versioned_artifacts(directory: Path, *, stem: str, suffix: str) -> list[tuple[str, Path]]:
    if not directory.is_dir():
        return []

    entries: list[tuple[str, Path]] = []
    for path in sorted(directory.iterdir()):
        if not path.is_file():
            continue
        version = parse_versioned_artifact_name(path.name, stem=stem, suffix=suffix)
        if version is None:
            continue
        entries.append((version, path))
    entries.sort(key=lambda item: release_version_key(item[0]))
    return entries


def resolve_versioned_artifact(
    directory: Path,
    *,
    stem: str,
    suffix: str,
    requested_version: str,
    exact: bool = False,
) -> Path | None:
    requested_key = release_version_key(requested_version)
    matches = iter_versioned_artifacts(directory, stem=stem, suffix=suffix)
    best: Path | None = None
    for version, path in matches:
        key = release_version_key(version)
        if exact:
            if key == requested_key:
                return path
            continue
        if key <= requested_key:
            best = path
        elif key > requested_key:
            break
    return best
