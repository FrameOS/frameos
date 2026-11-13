from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_boot_scene.c.
#
# fos_boot_scene.c decides which scene a frame starts on: a remembered
# selection, then the scene index's default, then the first scene, and never
# a layout, which shows nothing on its own.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCE = MAIN_DIR / "fos_boot_scene.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_boot_scene.c"


def test_boot_scene_helper_is_pure():
    source = SOURCE.read_text()
    assert "esp_" not in source, "fos_boot_scene.c must not pull in IDF headers or calls"
    assert "freertos" not in source


def test_firmware_starts_through_the_helper():
    """The first frame this bit booted `s_slots[0]`, whatever the index said."""
    source = (MAIN_DIR / "fos_scenes.c").read_text()
    assert "fos_boot_scene_pick(" in source
    assert "s_slots[0].slot" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_boot_scene_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_boot_scene"
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
        "boot scene host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "boot scene host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, "no summary line:\n" + run_result.stdout[-4000:]
    assert int(summary.group(1)) >= 14
    assert int(summary.group(2)) == 0
