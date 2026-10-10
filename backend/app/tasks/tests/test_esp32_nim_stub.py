from __future__ import annotations

import re
from pathlib import Path

# The ESP32-C3 thin-client image has no Nim runtime: frameos_nim's CMake
# links frameos_nim_stub.c instead of frameos_nim_glue.c. A function added to
# frameos_nim.h and the glue but not the stub links on the S3 and fails on
# the C3 — which only the release workflow builds (2026-10-10, release
# 2026.10.2: `undefined reference to frameos_nim_set_colors`). Pull-request
# CI never compiles the C3 image, so this is the check that catches it.

REPO_ROOT = Path(__file__).resolve().parents[4]
COMPONENT = REPO_ROOT / "embedded" / "esp32" / "components" / "frameos_nim"
HEADER = COMPONENT / "include" / "frameos_nim.h"
GLUE = COMPONENT / "frameos_nim_glue.c"
STUB = COMPONENT / "frameos_nim_stub.c"

DECLARATION = re.compile(r"\b(frameos_nim_[a-z0-9_]+)\s*\(")


def declared_functions(path: Path) -> set[str]:
    without_comments = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)
    return set(DECLARATION.findall(without_comments))


def test_every_header_function_has_a_stub():
    declared = declared_functions(HEADER)
    assert declared, f"no frameos_nim_* declarations found in {HEADER}"
    missing = sorted(declared - declared_functions(STUB))
    assert not missing, (
        "declared in frameos_nim.h but not defined in frameos_nim_stub.c "
        f"(the ESP32-C3 thin-client image fails to link): {missing}"
    )


def test_every_header_function_has_a_glue_definition():
    missing = sorted(declared_functions(HEADER) - declared_functions(GLUE))
    assert not missing, f"declared in frameos_nim.h but not defined in frameos_nim_glue.c: {missing}"
