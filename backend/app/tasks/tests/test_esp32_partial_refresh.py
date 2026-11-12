from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_partial_refresh.c.
#
# fos_partial_refresh.c decides when an e-paper panel with a partial waveform
# takes a partial update rather than a full refresh.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
COMPONENT = ESP32_DIR / "components" / "frameos_display"
SOURCE = COMPONENT / "fos_partial_refresh.c"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_partial_refresh.c"


def test_partial_refresh_helper_is_pure():
    source = SOURCE.read_text()
    assert "esp_" not in source, "fos_partial_refresh.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_partial_refresh_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_partial_refresh"
    compile_result = subprocess.run(
        [
            "cc",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-I",
            str(COMPONENT / "include"),
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
        "partial refresh host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "partial refresh host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, "no summary line:\n" + run_result.stdout[-4000:]
    assert int(summary.group(1)) >= 10
    assert int(summary.group(2)) == 0
