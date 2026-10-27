from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_lcd_splash.c: the RGB LCD's boot
# splash (components/frameos_display/lcd_splash.c) — the FrameOS mark's runs,
# drawn centered on black, and the frames of its squares' color walk. The
# module is pure, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
DISPLAY_DIR = ESP32_DIR / "components" / "frameos_display"
SOURCE = DISPLAY_DIR / "lcd_splash.c"
MARK = DISPLAY_DIR / "include" / "lcd_splash_mark.h"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_lcd_splash.c"


def test_sources_exist():
    for path in (SOURCE, MARK, TEST_SOURCE):
        assert path.is_file(), f"missing {path}"


def test_the_splash_stays_free_of_the_idf():
    assert "esp_" not in SOURCE.read_text(), "lcd_splash.c: the drawing is pure; the driver times it"


def test_the_mark_is_generated_from_the_svg():
    text = MARK.read_text()
    assert "gen_splash_mark.nim" in text and "frameos_mark.svg" in text
    assert (REPO_ROOT / "frameos" / "tools" / "gen_splash_mark.nim").is_file()


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_lcd_splash_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_lcd_splash"
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
