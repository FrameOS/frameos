from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[3]


def split_version_base(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return cleaned.split("+", 1)[0]


def read_frameos_version(repo_root: Path | None = None, *, field: str = "raw") -> str | None:
    resolved_root = (repo_root or DEFAULT_REPO_ROOT).resolve()
    versions_file = resolved_root / "versions.json"
    if not versions_file.is_file():
        return None

    try:
        payload = json.loads(versions_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    value = payload.get("frameos")
    if not isinstance(value, str):
        return None
    if field == "raw":
        return value
    if field == "base":
        return split_version_base(value)
    raise ValueError(f"Unsupported field: {field}")


def file_md5sum(path: Path) -> str:
    hasher = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def build_artifact_manifest(
    root: Path,
    *,
    frameos_version: str | None = None,
    source_version: str | None = None,
    target: str | None = None,
    exclude_names: Iterable[str] = (),
) -> dict[str, Any]:
    resolved_root = root.resolve()
    excluded = {name for name in exclude_names if name}
    artifacts: list[dict[str, str]] = []

    if resolved_root.is_dir():
        for path in sorted(item for item in resolved_root.rglob("*") if item.is_file()):
            if path.name in excluded:
                continue
            artifacts.append(
                {
                    "path": path.relative_to(resolved_root).as_posix(),
                    "md5": file_md5sum(path),
                }
            )

    payload: dict[str, Any] = {"artifacts": artifacts}
    if frameos_version:
        payload["frameos_version"] = frameos_version
    if source_version:
        payload["source_version"] = source_version
    if target:
        payload["target"] = target
    return payload


def write_artifact_manifest(
    root: Path,
    *,
    output: Path | None = None,
    frameos_version: str | None = None,
    source_version: str | None = None,
    target: str | None = None,
    exclude_names: Iterable[str] = (),
) -> Path:
    resolved_root = root.resolve()
    manifest_path = (output or resolved_root / "manifest.json").resolve()
    payload = build_artifact_manifest(
        resolved_root,
        frameos_version=frameos_version,
        source_version=source_version,
        target=target,
        exclude_names=tuple(exclude_names) + (manifest_path.name,),
    )
    resolved_root.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Helpers for prebuilt cross-build outputs")
    subparsers = parser.add_subparsers(dest="command", required=True)

    version = subparsers.add_parser("frameos-version", help="Read the current FrameOS version")
    version.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT), help="Repository root")
    version.add_argument("--field", choices=("raw", "base"), default="raw")

    manifest = subparsers.add_parser("write-manifest", help="Write an MD5 manifest for a folder")
    manifest.add_argument("--root", required=True, help="Folder to scan")
    manifest.add_argument("--output", default=None, help="Manifest output path")
    manifest.add_argument("--frameos-version", default=None, help="FrameOS release version")
    manifest.add_argument("--source-version", default=None, help="Underlying source/build version")
    manifest.add_argument("--target", default=None, help="Optional target slug")
    manifest.add_argument(
        "--exclude-name",
        action="append",
        default=[],
        help="Filename to exclude anywhere in the tree",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.command == "frameos-version":
        value = read_frameos_version(Path(args.repo_root), field=args.field)
        if value:
            print(value)
        return 0

    if args.command == "write-manifest":
        output = Path(args.output) if args.output else None
        path = write_artifact_manifest(
            Path(args.root),
            output=output,
            frameos_version=args.frameos_version,
            source_version=args.source_version,
            target=args.target,
            exclude_names=args.exclude_name,
        )
        print(path)
        return 0

    raise SystemExit(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
