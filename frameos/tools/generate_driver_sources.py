#!/usr/bin/env python3
"""Generate FrameOS driver registry sources from frame.json."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


FRAMEOS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRAMEOS_ROOT.parent
BACKEND_ROOT = REPO_ROOT / "backend"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.codegen.drivers_nim import (  # noqa: E402
    DRIVER_BUILD_MODE_SHARED,
    compiled_drivers,
    frame_driver_build_mode,
    normalize_driver_build_mode,
    write_driver_library_nim,
    write_drivers_nim,
)
from app.drivers.devices import drivers_for_frame  # noqa: E402
from app.drivers.waveshare import write_waveshare_driver_nim  # noqa: E402


@dataclass
class FrameStub:
    id: int = 0
    mode: str = "rpios"
    device: str = "framebuffer"
    device_config: dict[str, Any] = field(default_factory=dict)
    scenes: list[Any] = field(default_factory=list)
    gpio_buttons: list[Any] = field(default_factory=list)
    debug: bool = False
    rpios: dict[str, Any] | None = None
    reboot: dict[str, Any] | None = None
    ssh_pass: str | None = None
    ssh_port: int = 22


def load_frame_stub(config_path: Path) -> FrameStub:
    data: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as fh:
            data = json.loads(fh.read() or "{}")
    return FrameStub(
        device=str(data.get("device", "framebuffer")),
        device_config=dict(data.get("deviceConfig") or {}),
        scenes=list(data.get("scenes") or []),
        gpio_buttons=list(data.get("gpioButtons") or []),
        debug=bool(data.get("debug", False)),
        rpios=dict(data.get("rpios") or {}),
        reboot=dict(data.get("reboot") or {}),
    )


def generate_driver_sources(
    *,
    frameos_root: Path,
    config_path: Path,
    driver_build_mode: str | None,
) -> str:
    frame = load_frame_stub(config_path)
    mode = normalize_driver_build_mode(driver_build_mode or frame_driver_build_mode(frame))
    drivers = drivers_for_frame(frame)

    drivers_dir = frameos_root / "src" / "drivers"
    (drivers_dir / "drivers.nim").write_text(
        write_drivers_nim(drivers, driver_build_mode=mode),
        encoding="utf-8",
    )

    if drivers.get("waveshare"):
        (drivers_dir / "waveshare" / "driver.nim").write_text(
            write_waveshare_driver_nim(drivers),
            encoding="utf-8",
        )

    shared_dir = drivers_dir / "shared"
    shutil.rmtree(shared_dir, ignore_errors=True)
    if mode == DRIVER_BUILD_MODE_SHARED:
        shared_dir.mkdir(parents=True, exist_ok=True)
        for driver in compiled_drivers(drivers):
            (shared_dir / f"{driver.name}.nim").write_text(
                write_driver_library_nim(driver),
                encoding="utf-8",
            )

    return mode


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frameos-root", default=str(FRAMEOS_ROOT), help="Path to the frameos source tree")
    parser.add_argument("--config", default=str(FRAMEOS_ROOT / "frame.json"), help="Frame config JSON")
    parser.add_argument(
        "--driver-build-mode",
        choices=("static", "shared"),
        default=None,
        help="Override frame.json rpios.driverBuildMode",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    mode = generate_driver_sources(
        frameos_root=Path(args.frameos_root).resolve(),
        config_path=Path(args.config).resolve(),
        driver_build_mode=args.driver_build_mode,
    )
    print(f"Generated driver sources in {mode} mode")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
