from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_hid_report.c: the pure half of the
# Bluetooth keyboard and mouse (fos_bt.c) — report descriptors as real
# devices send them, the decode of their reports, key edges, and the HID
# usage -> Linux key table the dispatcher's keyboard tables are keyed by.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCE = MAIN_DIR / "fos_hid_report.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_hid_report.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_no_idf_in_the_pure_half():
    text = SOURCE.read_text()
    assert "esp_" not in text and "freertos" not in text, "fos_hid_report.c must stay host-buildable"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_hid_report_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_hid_report"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(SOURCE),
         str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "HID report host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert "0 failures" in run_result.stdout, run_result.stdout
