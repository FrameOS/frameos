from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_motion.c: what an accelerometer's
# readings mean (fos_motion.c, docs/accelerometer.md) — tilt, flick, shake and
# orientation by the contract's `motion` numbers (fos_events_gen.h), the
# rotation auto-rotate follows, a board's axes. Pure C: a laptop compiler is
# all it needs, like test_esp32_i2c_devices.py next door.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCES = [MAIN_DIR / "fos_motion.c"]
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_motion.c"


def test_motion_is_pure():
    """No IDF and no bus: the module is readings in, events out."""
    text = (MAIN_DIR / "fos_motion.c").read_text()
    assert "ESP_PLATFORM" not in text
    assert "esp_" not in text
    assert "fos_i2c" not in text


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_motion_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_motion"
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
            "-lm",
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "motion host tests do not compile:\n" + compile_result.stderr

    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, "motion host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout[-4000:]
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 30, f"expected the full suite to run, saw {checks} checks"
