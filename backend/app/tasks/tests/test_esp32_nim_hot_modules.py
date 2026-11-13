from __future__ import annotations

import codecs
import re
from pathlib import Path

# The ESP32 image compiles a few Nim modules at -O2 instead of -Os: pixie's
# raster (paths, images, blends, internal, rgb565, common) and
# frameos/utils/resample. components/frameos_nim/CMakeLists.txt picks them by
# the name of the C file Nim generates for each, and that name depends on the
# Nim build: the official one (the Docker image, CI, every release) writes
# `@m..@s..@spixie@ssrc@spixie@spaths.nim.c`, nixpkgs' (the flox dev shell)
# ROT13s it. The list held only the ROT13 names, so every CI and release image
# drew DVD Logo Bounce on the SenseCAP Indicator ~5 ms a frame slower than the
# bench builds it was measured on (2026-11-10). ci_build_image.sh checks the
# built image; this checks the list itself.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
CMAKE = ESP32_DIR / "components" / "frameos_nim" / "CMakeLists.txt"
CI_BUILD = ESP32_DIR / "ci_build_image.sh"

# Module paths as Nim names them, relative to the source roots it mangles.
MODULE_ROOTS = {
    "pixie": REPO_ROOT / "frameos" / "pixie" / "src",
    "frameos": REPO_ROOT / "frameos" / "src",
}


def _hot_names(text: str) -> list[str]:
    block = re.search(r"set\(FRAMEOS_NIM_HOT_MODULES(.*?)\)\s*\n", text, re.DOTALL)
    assert block is not None, "CMakeLists.txt: FRAMEOS_NIM_HOT_MODULES not found"
    return re.findall(r'"([^"]+\.nim\.c)"', block.group(1))


def _plain_module(name: str) -> str:
    """`@spixie@spaths.nim.c` -> `pixie/paths`."""
    assert name.startswith("@s") and name.endswith(".nim.c"), name
    return name[len("@s") : -len(".nim.c")].replace("@s", "/")


def _rot13(name: str) -> str:
    """nixpkgs' Nim scrambles the module path, not the `.nim.c` it ends in."""
    return codecs.encode(name[: -len(".nim.c")], "rot13") + ".nim.c"


def test_every_hot_module_is_listed_as_both_nim_builds_name_it():
    names = _hot_names(CMAKE.read_text())
    plain = [n for n in names if n.startswith("@s")]
    scrambled = [n for n in names if n.startswith("@f")]
    assert len(plain) + len(scrambled) == len(names), f"a name that is neither form: {names}"
    assert plain, "no plain (official Nim) names: a Docker/CI build would compile every hot module at -Os"
    for name in plain:
        assert _rot13(name) in scrambled, f"{name} has no ROT13 twin for the flox Nim"
    for name in scrambled:
        assert _rot13(name) in plain, f"{name} has no plain twin for the official Nim"


def test_every_hot_module_exists():
    for name in _hot_names(CMAKE.read_text()):
        if not name.startswith("@s"):
            continue
        module = _plain_module(name)
        root, _, rest = module.partition("/")
        source = MODULE_ROOTS[root] / root / f"{rest}.nim"
        assert source.is_file(), f"{name} names {source.relative_to(REPO_ROOT)}, which does not exist"


def test_the_image_build_checks_the_same_modules():
    """ci_build_image.sh fails a build whose hot modules came out without -O2."""
    names = set(_hot_names(CMAKE.read_text()))
    check = CI_BUILD.read_text()
    assert "compile_commands.json" in check and "built without -O2" in check
    checked = set(re.findall(r'"(@[sf][^"]+\.nim\.c)"', check))
    assert checked == names, (
        "ci_build_image.sh checks a different set than CMakeLists.txt compiles at -O2: "
        f"only in CMake {sorted(names - checked)}, only in the check {sorted(checked - names)}"
    )
