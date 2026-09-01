from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_battery_filter.c.
#
# Same arrangement as test_esp32_power.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_battery_filter.c reduces one ADC burst to a believable raw count — the
# median inside a round, the highest round across a read. It is the fix for
# the glitched battery readings the prod logs are full of (E1002 and E1004,
# 2026-08-29..31): the mean it replaces turned a few dropped samples, or a
# divider that had not finished charging, into a confident 1 % on a cell at
# 74 %. Pure arithmetic; the ADC and the GPIO live in fos_battery.c.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
FILTER_SOURCE = MAIN_DIR / "fos_battery_filter.c"
FILTER_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_battery_filter.c"


def test_sources_exist():
    assert FILTER_SOURCE.is_file(), f"missing {FILTER_SOURCE}"
    assert FILTER_TEST_SOURCE.is_file(), f"missing {FILTER_TEST_SOURCE}"


def test_filter_helper_is_pure():
    """The point of the split: it must stay buildable without the IDF."""
    source = FILTER_SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_battery_filter.c must not pull in IDF headers or calls"
    assert "freertos" not in source
    assert "adc_" not in source, "the ADC itself belongs in fos_battery.c"


def test_fos_battery_read_does_not_average_samples():
    """The regression this module exists for.

    A mean over the burst is what turned a minority of dropped samples into a
    reading a quarter of the truth. If someone reintroduces one in the read
    path, say so here rather than in a battery graph three days later.
    """
    battery = (MAIN_DIR / "fos_battery.c").read_text()
    assert "fos_battery_burst_add" in battery, "the read path must go through the filter"
    assert "raw_sum" not in battery, "the read path must not average raw samples again"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_battery_filter_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_battery_filter"
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
            str(FILTER_SOURCE),
            str(FILTER_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "battery filter host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "battery filter host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 25
    assert int(summary.group(2)) == 0
