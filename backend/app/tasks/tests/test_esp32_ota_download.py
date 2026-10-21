from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_ota_download.c.
#
# Same arrangement as test_esp32_wake.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_ota_download.c is the bookkeeping of an OTA image download: the Range a
# resumed connection asks for, which responses it accepts, when a run stops
# redialing, and the verdict line the control planes show. The sockets and
# the flash stay in fos_ota.c, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCE = MAIN_DIR / "fos_ota_download.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_ota_download.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_download_helper_is_pure():
    """The point of the split: fos_ota_download.c must stay buildable without the IDF."""
    source = SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_ota_download.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_ota_download_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_ota_download"
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
        "OTA download host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "OTA download host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 30
    assert int(summary.group(2)) == 0
