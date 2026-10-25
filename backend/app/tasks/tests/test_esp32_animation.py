from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_animation.c.
#
# Same arrangement as test_esp32_power.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_animation.c is the render task's animation mode — a scene below a
# one-second interval on an LCD: when it starts, the per-second housekeeping,
# which frames log in full, when the next frame is due. Pure arithmetic; the
# clock, the render and the logs live in fos_client.c.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
ANIMATION_SOURCE = MAIN_DIR / "fos_animation.c"
ANIMATION_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_animation.c"


def test_sources_exist():
    assert ANIMATION_SOURCE.is_file(), f"missing {ANIMATION_SOURCE}"
    assert ANIMATION_TEST_SOURCE.is_file(), f"missing {ANIMATION_TEST_SOURCE}"


def test_animation_helper_is_pure():
    """The point of the split: fos_animation.c must stay buildable without the IDF."""
    source = ANIMATION_SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_animation.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_animation_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_animation"
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
            str(ANIMATION_SOURCE),
            str(ANIMATION_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "animation host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "animation host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 40
    assert int(summary.group(2)) == 0
