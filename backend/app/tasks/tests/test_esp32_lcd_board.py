from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_lcd_board.c: the RGB LCD driver's
# board choice (components/frameos_display/lcd_st7701s_rgb.c,
# fos_lcd_st7701s_select_board) — the preset names the board, and without
# one the panel key does. It compiles the driver's ESP32-C3 stub against a
# few host stand-ins (main/tests/lcd_board_shim), so a laptop compiler is all
# this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
DISPLAY_DIR = ESP32_DIR / "components" / "frameos_display"
SOURCE = DISPLAY_DIR / "lcd_st7701s_rgb.c"
SHIM_DIR = ESP32_DIR / "main" / "tests" / "lcd_board_shim"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_lcd_board.c"


def test_sources_exist():
    for path in (SOURCE, SHIM_DIR / "esp_log.h", TEST_SOURCE):
        assert path.exists(), f"missing {path}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_lcd_board_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_lcd_board"
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            f"-I{SHIM_DIR}",
            f"-I{DISPLAY_DIR / 'include'}",
            str(SOURCE), str(TEST_SOURCE),
            "-o", str(binary),
        ],
        check=True,
    )
    result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok:" in result.stdout
