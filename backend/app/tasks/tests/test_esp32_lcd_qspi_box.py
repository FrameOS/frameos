from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_lcd_qspi_box.c: what the QSPI AMOLED
# driver (components/frameos_display/lcd_qspi_amoled.c) sends when the picture
# changes — the changed rectangle, aligned as the CO5300 wants it, its pixels
# byte-swapped — and the driver's board choice, compiled as its stub for a
# chip without the panel against the RGB LCD test's host stand-ins.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
DISPLAY_DIR = ESP32_DIR / "components" / "frameos_display"
SOURCES = [DISPLAY_DIR / "lcd_qspi_box.c", DISPLAY_DIR / "lcd_qspi_amoled.c"]
SHIM_DIR = ESP32_DIR / "main" / "tests" / "lcd_board_shim"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_lcd_qspi_box.c"


def test_sources_exist():
    for path in (*SOURCES, TEST_SOURCE):
        assert path.exists(), f"missing {path}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_lcd_qspi_box_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_lcd_qspi_box"
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            f"-I{SHIM_DIR}",
            f"-I{DISPLAY_DIR / 'include'}",
            *map(str, SOURCES), str(TEST_SOURCE),
            "-o", str(binary),
        ],
        check=True,
    )
    result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok:" in result.stdout
