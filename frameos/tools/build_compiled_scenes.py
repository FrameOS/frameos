#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

DEFAULT_JOBS_ENV = "FRAMEOS_COMPILED_SCENE_JOBS"


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be >= 1")
    return parsed


def resolve_jobs(explicit_jobs: int | None) -> int:
    if explicit_jobs is not None:
        return explicit_jobs

    env_value = os.environ.get(DEFAULT_JOBS_ENV)
    if env_value:
        return positive_int(env_value)

    return os.cpu_count() or 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build FrameOS compiled scene plugins")
    parser.add_argument("--frameos-root", default=".", help="Path to the frameos source tree")
    parser.add_argument("--nim", default="nim", help="Path to the Nim compiler")
    parser.add_argument("--output-dir", default="scenes", help="Output directory for compiled scene libraries")
    parser.add_argument(
        "--jobs",
        type=positive_int,
        default=None,
        help=f"Maximum number of scene plugins to build concurrently. Defaults to {DEFAULT_JOBS_ENV} or CPU count.",
    )
    return parser.parse_args()


def compile_scene_plugin(frameos_root: Path, nim_bin: str, output_dir: Path, plugin_source: Path) -> str:
    library_name = plugin_source.stem.removeprefix("plugin_") + ".so"
    nimcache_dir = frameos_root / "build" / "scene_nimcache" / plugin_source.stem
    shutil.rmtree(nimcache_dir, ignore_errors=True)
    nimcache_dir.parent.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    process = subprocess.run(
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
        capture_output=True,
        text=True,
    )
    duration = time.perf_counter() - started

    if process.returncode != 0:
        if process.stdout:
            print(process.stdout, end="" if process.stdout.endswith("\n") else "\n")
        if process.stderr:
            print(process.stderr, end="" if process.stderr.endswith("\n") else "\n")
        raise subprocess.CalledProcessError(process.returncode, process.args)

    print(f"[compiled-scenes] built {library_name} in {duration:.1f}s", flush=True)
    return library_name


def build_compiled_scenes(frameos_root: Path, nim_bin: str, output_dir: Path, jobs: int) -> None:
    scenes_src = frameos_root / "src" / "scenes"
    plugin_sources = sorted(scenes_src.glob("plugin_*.nim"))
    output_dir.mkdir(parents=True, exist_ok=True)

    keep_files = {plugin_source.stem.removeprefix("plugin_") + ".so" for plugin_source in plugin_sources}
    max_workers = max(1, min(jobs, len(plugin_sources) or 1))

    print(
        f"[compiled-scenes] building {len(plugin_sources)} plugin(s) with {max_workers} job(s)",
        flush=True,
    )

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(compile_scene_plugin, frameos_root, nim_bin, output_dir, plugin_source): plugin_source
            for plugin_source in plugin_sources
        }
        for future in as_completed(futures):
            future.result()

    for candidate in output_dir.glob("*.so"):
        if candidate.name not in keep_files:
            candidate.unlink()


def main() -> int:
    args = parse_args()
    frameos_root = Path(args.frameos_root).resolve()
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = frameos_root / output_dir
    build_compiled_scenes(frameos_root, args.nim, output_dir, resolve_jobs(args.jobs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
