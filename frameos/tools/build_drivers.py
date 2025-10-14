#!/usr/bin/env python3
"""Compile FrameOS driver entry modules into shared libraries."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable

DEFAULT_OUT_DIR = Path("build/drivers")

def detect_extension(target_os: str | None) -> str:
    mapping = {
        "windows": ".dll",
        "win64": ".dll",
        "win32": ".dll",
        "macosx": ".dylib",
        "darwin": ".dylib",
    }
    if target_os:
        target = target_os.lower()
        if target in mapping:
            return mapping[target]
    return ".so"


def iter_entry_modules(drivers_root: Path) -> Iterable[tuple[str, Path]]:
    for entry in sorted(drivers_root.glob("*/entry.nim")):
        yield entry.parent.name, entry


def build_driver(
    nim: str,
    repo_root: Path,
    driver_name: str,
    entry_path: Path,
    out_dir: Path,
    extension: str,
    extra_flags: list[str],
) -> None:
    out_file = out_dir / f"lib{driver_name}{extension}"
    nimcache_dir = repo_root / "tmp" / "nimcache" / "drivers" / driver_name
    nimcache_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        nim,
        "c",
        "--app:lib",
        "--noMain",
        f"--out:{out_file}",
        f"--nimcache:{nimcache_dir}",
        *extra_flags,
        str(entry_path.relative_to(repo_root)),
    ]
    print(f"\n==> Building {driver_name} ({entry_path})")
    subprocess.run(cmd, cwd=repo_root, check=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--nim",
        default=os.environ.get("NIM", "nim"),
        help="Path to the nim compiler (default: %(default)s)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="Output directory for compiled libraries (relative to frameos/)",
    )
    parser.add_argument(
        "--os",
        dest="target_os",
        help="Target operating system passed to Nim (e.g. linux, windows, macosx)",
    )
    parser.add_argument(
        "--cpu",
        dest="target_cpu",
        help="Target CPU passed to Nim (e.g. arm64, amd64)",
    )
    parser.add_argument(
        "--flag",
        dest="extra_flags",
        action="append",
        default=[],
        help="Additional flags to pass directly to nim (can be specified multiple times)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Only list the drivers that would be built",
    )
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    drivers_root = repo_root / "src" / "drivers"

    entries = list(iter_entry_modules(drivers_root))
    if not entries:
        print("No driver entry modules found", file=sys.stderr)
        return 1

    if args.list:
        for name, entry in entries:
            print(f"{name}\t{entry.relative_to(repo_root)}")
        return 0

    extension = detect_extension(args.target_os)
    out_dir = repo_root / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    extra_flags = list(args.extra_flags)
    if args.target_os:
        extra_flags.append(f"--os:{args.target_os}")
    if args.target_cpu:
        extra_flags.append(f"--cpu:{args.target_cpu}")

    for driver_name, entry_path in entries:
        try:
            build_driver(
                nim=args.nim,
                repo_root=repo_root,
                driver_name=driver_name,
                entry_path=entry_path,
                out_dir=out_dir,
                extension=extension,
                extra_flags=extra_flags,
            )
        except Exception as e:
            print(f"\nError building {driver_name}: {e}")

    print(f"\nBuilt {len(entries)} driver libraries into {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
