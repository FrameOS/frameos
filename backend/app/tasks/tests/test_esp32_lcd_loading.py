from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_lcd_loading.c: the RGB LCD's
# loading mark (components/frameos_display/lcd_loading.c): when it shows
# during a scene switch, which buffer it is drawn in and that the pixels
# under it go back exactly. The module is pure, so a laptop compiler is all
# this needs. The look of the mark is the runtime's (frameos/loading_mark.nim,
# test_loading_mark.nim); the timing is written down on both sides and has to
# agree.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
DISPLAY_DIR = ESP32_DIR / "components" / "frameos_display"
SOURCE = DISPLAY_DIR / "lcd_loading.c"
HEADER = DISPLAY_DIR / "include" / "lcd_loading.h"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_lcd_loading.c"
NIM_MARK = REPO_ROOT / "frameos" / "src" / "frameos" / "loading_mark.nim"
NIM_PANEL = REPO_ROOT / "frameos" / "src" / "frameos" / "loading_mark_panel.nim"


def test_sources_exist():
    for path in (SOURCE, HEADER, TEST_SOURCE, NIM_MARK, NIM_PANEL):
        assert path.is_file(), f"missing {path}"


def test_the_state_stays_free_of_the_idf():
    assert "esp_" not in SOURCE.read_text(), "lcd_loading.c is pure; lcd_st7701s_rgb.c owns the task"


def _nim_const(path: Path, name: str) -> int:
    match = re.search(rf"^\s*{name}\*\s*=\s*([0-9_]+)", path.read_text(), re.MULTILINE)
    assert match, f"{name} not found in {path}"
    return int(match.group(1).replace("_", ""))


def _c_define(name: str) -> int:
    match = re.search(rf"^#define {name} ([0-9]+)", HEADER.read_text(), re.MULTILINE)
    assert match, f"{name} not found in {HEADER}"
    return int(match.group(1))


def test_the_esp32_and_the_pi_wait_and_animate_alike():
    assert _c_define("FOS_LCD_LOADING_DELAY_MS") == _nim_const(NIM_MARK, "LoadingMarkDelayMs")
    assert _c_define("FOS_LCD_LOADING_FRAME_MS") == _nim_const(NIM_MARK, "LoadingMarkFrameMs")
    assert _c_define("FOS_LCD_LOADING_MAX_MS") == _nim_const(NIM_PANEL, "LoadingMarkMaxMs")


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_lcd_loading_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_lcd_loading"
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            f"-I{DISPLAY_DIR / 'include'}",
            str(SOURCE), str(TEST_SOURCE),
            "-o", str(binary),
        ],
        check=True,
    )
    result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok:" in result.stdout
