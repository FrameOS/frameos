#!/usr/bin/env python3
"""Build configured FrameOS drivers as shared libraries."""
from __future__ import annotations

import argparse
import asyncio
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable


FRAMEOS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRAMEOS_ROOT.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.codegen.drivers_nim import (  # noqa: E402
    COMPILATION_MODE_SHARED,
    compiled_drivers,
    compilation_mode_uses_shared_drivers,
    driver_library_filename,
    frame_compilation_mode,
    normalize_compilation_mode,
)
from app.drivers.devices import drivers_for_frame  # noqa: E402
from generate_driver_sources import generate_driver_sources, load_frame_stub  # noqa: E402

LINUX_SIZE_FLAGS = [
    "--opt:size",
    "--stackTrace:off",
    "--lineTrace:off",
    "--passC:-ffunction-sections",
    "--passC:-fdata-sections",
    "--passC:-fno-asynchronous-unwind-tables",
    "--passC:-fno-unwind-tables",
    "--passL:-Wl,--gc-sections",
]
FRAMEOS_NIM_FLAGS = ["-d:malloc"]


def run(command: list[str], *, cwd: Path) -> None:
    print("> " + " ".join(command))
    subprocess.run(command, cwd=cwd, check=True)


def strip_library(path: Path, strip_command: str | None) -> None:
    if not strip_command:
        return
    command = [strip_command, "--strip-unneeded", str(path)]
    print("> " + " ".join(command))
    try:
        subprocess.run(command, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as err:
        print(f"Skipping strip for {path}: {err}", file=sys.stderr)


async def build_driver_libraries(
    *,
    frameos_root: Path,
    config_path: Path,
    out_dir: Path,
    nim_path: str,
    nim_args: Iterable[str],
    strip_command: str | None,
    only_if_shared: bool,
    compilation_mode: str | None,
) -> list[Path]:
    frame = load_frame_stub(config_path)
    mode = normalize_compilation_mode(compilation_mode or frame_compilation_mode(frame))
    if only_if_shared and not compilation_mode_uses_shared_drivers(mode):
        print(f"Compilation mode is {mode}; skipping shared driver libraries")
        return []

    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="frameos-driver-libs-") as tmp:
        source_dir = Path(tmp) / "frameos"
        shutil.copytree(
            frameos_root,
            source_dir,
            ignore=shutil.ignore_patterns("build", "node_modules"),
        )
        repo_scenes = frameos_root.parent / "repo" / "scenes"
        if repo_scenes.is_dir():
            repo_scenes_dir = Path(tmp) / "repo" / "scenes"
            repo_scenes_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(repo_scenes, repo_scenes_dir, dirs_exist_ok=True)
        generate_driver_sources(
            frameos_root=source_dir,
            config_path=config_path,
            compilation_mode=COMPILATION_MODE_SHARED,
        )

        if not (source_dir / "quickjs" / "libquickjs.a").exists():
            run(["nimble", "build_quickjs", "--silent"], cwd=source_dir)
        run(["nimble", "assets", "-y"], cwd=source_dir)
        run(["nimble", "setup"], cwd=source_dir)

        built: list[Path] = []
        for driver in compiled_drivers(drivers_for_frame(frame)):
            output = out_dir / driver_library_filename(driver)
            nimcache = out_dir / ".nimcache" / driver.name
            if nimcache.exists():
                shutil.rmtree(nimcache)
            command = [
                nim_path,
                "compile",
                "--app:lib",
                *FRAMEOS_NIM_FLAGS,
                "--define:frameosDriverLibrary",
                *(LINUX_SIZE_FLAGS if sys.platform.startswith("linux") else ["--opt:size"]),
                f"--nimcache:{nimcache}",
                f"--out:{output}",
                *list(nim_args),
                f"src/drivers/shared/{driver.name}.nim",
            ]
            run(command, cwd=source_dir)
            strip_library(output, strip_command)
            built.append(output)

        return built


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frameos-root", default=str(FRAMEOS_ROOT), help="Path to the frameos source tree")
    parser.add_argument("--config", default=str(FRAMEOS_ROOT / "frame.json"), help="Frame config JSON to select drivers")
    parser.add_argument("--out", default=str(FRAMEOS_ROOT / "build" / "drivers"), help="Output directory for .so files")
    parser.add_argument("--nim", default="nim", help="Nim compiler executable")
    parser.add_argument("--strip", default="strip", help="Strip executable to run on built libraries")
    parser.add_argument("--no-strip", action="store_true", help="Do not strip built libraries")
    parser.add_argument(
        "--only-if-shared",
        action="store_true",
        help="Skip unless the effective compilation mode uses shared libraries",
    )
    parser.add_argument(
        "--compilation-mode",
        choices=("static", "shared", "shared-scenes", "precompiled"),
        default=None,
        help="Override frame.json rpios.compilationMode when deciding whether to skip",
    )
    parser.add_argument(
        "--nim-arg",
        action="append",
        default=[],
        help="Extra argument to pass to nim compile; repeat for multiple arguments",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    built = asyncio.run(
        build_driver_libraries(
            frameos_root=Path(args.frameos_root).resolve(),
            config_path=Path(args.config).resolve(),
            out_dir=Path(args.out).resolve(),
            nim_path=args.nim,
            nim_args=args.nim_arg,
            strip_command=None if args.no_strip else args.strip,
            only_if_shared=args.only_if_shared,
            compilation_mode=args.compilation_mode,
        )
    )
    for path in built:
        print(f"Built {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
