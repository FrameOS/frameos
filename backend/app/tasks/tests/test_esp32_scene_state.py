from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_scene_state.c.
#
# Same arrangement as test_esp32_wake.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_scene_state.c keeps a scene's state across a deep sleep: one JSON file
# per scene under /state, named by a hash of the scene id (SPIFFS cannot open
# a uuid-length name), written atomically. Plain stdio, so a laptop compiler
# is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCE = MAIN_DIR / "fos_scene_state.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_scene_state.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_scene_state_module_is_pure():
    """The point of the split: fos_scene_state.c must stay buildable without the IDF."""
    source = SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_scene_state.c must not pull in IDF headers or calls"
    assert "freertos" not in source
    assert "cJSON" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_scene_state_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_scene_state"
    compile_result = subprocess.run(
        [
            "cc",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-I",
            str(MAIN_DIR),
            str(SOURCE),
            str(TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "scene state host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "scene state host tests failed:\n" + run_result.stdout[-4000:]
    )

    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 25
    assert int(summary.group(2)) == 0
