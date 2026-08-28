from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_power.c.
#
# Same arrangement as test_esp32_wake.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_power.c is the pass-start power decision of a deep-sleeping frame —
# whether a cell is present, whether it is critical, whether the pass ends in
# esp_deep_sleep — with the hysteresis that keeps one bad ADC burst from
# switching deep sleep off for nine hours. Pure arithmetic; the ADC read and
# the RTC-memory state live in fos_client.c.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
POWER_SOURCE = MAIN_DIR / "fos_power.c"
POWER_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_power.c"


def test_sources_exist():
    assert POWER_SOURCE.is_file(), f"missing {POWER_SOURCE}"
    assert POWER_TEST_SOURCE.is_file(), f"missing {POWER_TEST_SOURCE}"


def test_power_helper_is_pure():
    """The point of the split: fos_power.c must stay buildable without the IDF."""
    source = POWER_SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_power.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_power_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_power"
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
            str(POWER_SOURCE),
            str(POWER_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "power host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "power host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 25
    assert int(summary.group(2)) == 0
