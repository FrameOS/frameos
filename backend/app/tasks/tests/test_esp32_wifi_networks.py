from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_wifi_networks.c: the order of the
# networks in the frame settings' select box on an ESP32 touch frame (by
# name, not by signal as a scan hands them over). Same arrangement as
# test_esp32_version.py: a host test nothing invokes is a host test that
# does not exist.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCE = MAIN_DIR / "fos_wifi_networks.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_wifi_networks.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_the_scan_sorts_what_it_keeps():
    """The sort is only worth its test if the scan task runs it, after the
    cut to the strongest names and before the list is published."""
    source = (MAIN_DIR / "fos_wifi.c").read_text()
    kept = source.index("n < FOS_WIFI_SCAN_MAX")
    sorted_at = source.index("fos_wifi_networks_sort(found, n)")
    published = source.index("s_networks = found")
    assert kept < sorted_at < published


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_wifi_networks_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_wifi_networks"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(SOURCE), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "Wi-Fi network order host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "Wi-Fi network order host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 100
