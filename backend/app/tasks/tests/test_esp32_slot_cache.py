from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_slot_cache.c.
#
# fos_slot_cache.c keeps the scene files fos_scenes.c read last in PSRAM: a
# SPIFFS open walks the partition (0.7 s on the reTerminal E1003's 24 MB), and
# every scene switch read its scene that way. A cache of scene files is only
# right while every write of them clears it, so the second half of this file
# reads fos_scenes.c for exactly that.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCE = MAIN_DIR / "fos_slot_cache.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_slot_cache.c"
SCENES = MAIN_DIR / "fos_scenes.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"
    assert '"fos_slot_cache.c"' in (MAIN_DIR / "CMakeLists.txt").read_text()


def test_slot_cache_module_is_pure():
    source = SOURCE.read_text()
    assert "esp_" not in source, "fos_slot_cache.c must not pull in IDF headers or calls"
    assert "freertos" not in source
    assert "cJSON" not in source


def _definition_body(text: str, name: str) -> str:
    """The body of the C function `name` (its definition, not a declaration)."""
    match = re.search(rf"^[a-z][^;{{}}\n]*\b{name}\([^;{{}}]*\)\s*\{{", text, re.MULTILINE)
    assert match is not None, f"fos_scenes.c: no definition of {name}"
    depth = 0
    for index in range(match.end() - 1, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[match.end() - 1 : index + 1]
    raise AssertionError(f"fos_scenes.c: unterminated body for {name}")


def test_every_write_of_the_scene_files_clears_the_cache():
    """A scene push writes slot files through write_file_replace and removes
    them through remove_slots_from / fos_scenes_wipe_state. Each must clear
    the cache, or a switch after the push shows the scene from before it."""
    text = SCENES.read_text()
    for name in ("write_file_replace", "remove_slots_from", "fos_scenes_wipe_state"):
        body = _definition_body(text, name)
        assert "slot_cache_clear" in body, f"fos_scenes.c: {name} no longer clears the slot cache"
    # Slot files are read through the cache, and written nowhere else.
    assert text.count("read_slot_file(slot, path,") >= 2
    assert re.search(r"fopen\([^)]*slot", text) is None


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_slot_cache_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_slot_cache"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(SOURCE),
         str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "slot cache host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "slot cache host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout[-4000:]
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 60, f"expected the full suite to run, saw {summary.group(1)} checks"
