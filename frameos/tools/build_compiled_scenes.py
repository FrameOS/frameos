#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build FrameOS compiled scene plugins")
    parser.add_argument("--frameos-root", default=".", help="Path to the frameos source tree")
    parser.add_argument("--nim", default="nim", help="Path to the Nim compiler")
    parser.add_argument("--output-dir", default="scenes", help="Output directory for compiled scene libraries")
    return parser.parse_args()


def build_compiled_scenes(frameos_root: Path, nim_bin: str, output_dir: Path) -> None:
    scenes_src = frameos_root / "src" / "scenes"
    plugin_sources = sorted(scenes_src.glob("plugin_*.nim"))
    output_dir.mkdir(parents=True, exist_ok=True)

    keep_files: set[str] = set()
    for plugin_source in plugin_sources:
        library_name = plugin_source.stem.removeprefix("plugin_") + ".so"
        keep_files.add(library_name)
        nimcache_dir = frameos_root / "build" / "scene_nimcache" / plugin_source.stem
        shutil.rmtree(nimcache_dir, ignore_errors=True)
        nimcache_dir.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                nim_bin,
                "c",
                "--app:lib",
                "-d:release",
                f"--nimcache:{nimcache_dir}",
                f"--out:{output_dir / library_name}",
                str(plugin_source.relative_to(frameos_root)),
            ],
            cwd=frameos_root,
            check=True,
        )

    for candidate in output_dir.glob("*.so"):
        if candidate.name not in keep_files:
            candidate.unlink()


def main() -> int:
    args = parse_args()
    frameos_root = Path(args.frameos_root).resolve()
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = frameos_root / output_dir
    build_compiled_scenes(frameos_root, args.nim, output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
