from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_version.c — the release-version
# ordering behind the ESP32 OTA downgrade refusal (fos_ota.c). Same
# arrangement as test_esp32_netguard.py: a host test nothing invokes is a
# host test that does not exist.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
SOURCE = ESP32_DIR / "components" / "frameos_nim" / "fos_version.c"
INCLUDE = ESP32_DIR / "components" / "frameos_nim" / "include"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_version.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_version_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_version"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(INCLUDE), str(SOURCE), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "version host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "version host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 30
