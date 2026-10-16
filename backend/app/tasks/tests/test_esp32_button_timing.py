from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_button_timing.c.
#
# Same arrangement as test_esp32_board.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_button_timing.c is one GPIO button's debounce (first change is the edge,
# bounce locked out after it) and the press kinds the buzzer sounds — the Nim
# dispatcher's rules for doublePress / longPress / repeat, on the contract's
# numbers from fos_events_gen.h. Pure arithmetic: the GPIO, the queue and the
# buzzer calls live in fos_buttons.c, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
TIMING_SOURCE = MAIN_DIR / "fos_button_timing.c"
TIMING_TEST_SOURCE = MAIN_DIR / "tests" / "test_button_timing.c"


def test_sources_exist():
    assert TIMING_SOURCE.is_file(), f"missing {TIMING_SOURCE}"
    assert TIMING_TEST_SOURCE.is_file(), f"missing {TIMING_TEST_SOURCE}"


def test_timing_helper_is_pure():
    """The point of the split: fos_button_timing.c must stay buildable without the IDF."""
    source = TIMING_SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_button_timing.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_button_timing_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_button_timing"
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
            str(TIMING_SOURCE),
            str(TIMING_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "button timing host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "button timing host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 35
    assert int(summary.group(2)) == 0
