from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# embedded/esp32/tools/firmware_size.py, which writes the per-subsystem split in
# the PR comment's "ESP32 firmware size". Its Nim object names carry the path
# of whichever toolchain built them; a stdlib path the rules miss lands in
# "FrameOS core (Nim)" (#748's choosenim runner image did that to ~190 KB).

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "embedded" / "esp32" / "tools" / "firmware_size.py"


@pytest.fixture(scope="module")
def firmware_size():
    spec = importlib.util.spec_from_file_location("firmware_size", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["firmware_size"] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("mangled", "name", "group"),
    [
        # choosenim (CI's runner image)
        ("@m..@s..@s..@s.choosenim@stoolchains@snim-2.2.4@slib@ssystem", "nim/lib/system.nim", "Nim stdlib"),
        (
            "@m..@s.choosenim@stoolchains@snim-2.2.4@slib@spure@scollections@stables",
            "nim/lib/pure/collections/tables.nim",
            "Nim stdlib",
        ),
        # the Docker image's /opt/nim
        ("@m..@s..@sopt@snim@slib@spure@sjson", "nim/lib/pure/json.nim", "Nim stdlib"),
        # nixpkgs (the flox shell), whose names are ROT13'd on top
        ("@z..@f..@favk@ffgber@fnop-avz-hajenccrq-2.2.4@favz@fyvo@ffgq@fflapvb", "nim/lib/std/syncio.nim", "Nim stdlib"),
        # nimble packages, the hash dropped
        (
            "@m..@s.nimble@spkgs2@schrono-0.3.1-0123456789abcdef0123456789abcdef01234567@schrono",
            "pkgs/chrono-0.3.1/chrono.nim",
            "Nim packages (chrono, zippy, chroma, qrgen, ...)",
        ),
        # the runtime itself
        ("@mframeos@sinterpreter", "frameos/interpreter.nim", "FrameOS core (Nim)"),
    ],
)
def test_nim_objects_land_in_their_subsystem(firmware_size, mangled: str, name: str, group: str) -> None:
    archive, decoded = firmware_size._decode_name(f"libframeos_nim.a:{mangled}.nim.c.obj")
    assert archive == "libframeos_nim.a"
    assert decoded == name
    assert firmware_size._group_for(archive, decoded) == group
