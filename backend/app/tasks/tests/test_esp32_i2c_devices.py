from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_i2c_devices.c: the pure halves of
# the I2C chips — the reTerminal E-series' SY6974B charger's register decode
# (fos_charger.c: is USB in, is the cell charging), the PCF8563 clock's BCD
# conversions (fos_rtc.c) and the reTerminal Sticky's BQ27220 fuel gauge's
# word decode (fos_gauge.c). Same arrangement as
# test_esp32_power.py next door: both files keep their arithmetic above the
# ESP_PLATFORM guard, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCES = [MAIN_DIR / "fos_charger.c", MAIN_DIR / "fos_rtc.c", MAIN_DIR / "fos_gauge.c"]
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_i2c_devices.c"


def test_sources_exist():
    for source in SOURCES:
        assert source.is_file(), f"missing {source}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_pure_halves_stay_above_the_platform_guard():
    """The decode and the conversions must build without the IDF: every IDF
    include sits below `#ifdef ESP_PLATFORM`."""
    for source in SOURCES:
        text = source.read_text()
        guard = text.index("#ifdef ESP_PLATFORM")
        pure = text[:guard]
        assert "esp_" not in pure, f"{source.name}: IDF reference above the guard"
        assert "fos_i2c.h" not in pure, f"{source.name}: the bus include belongs below the guard"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_i2c_devices_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_i2c_devices"
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
            *[str(source) for source in SOURCES],
            str(TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "i2c device host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, (
        "i2c device host tests failed:\n" + run_result.stdout[-4000:]
    )
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout[-4000:]
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 20, f"expected the full suite to run, saw {checks} checks"
