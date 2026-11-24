from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_lcd_press.c and test_fos_press.c:
# a press shown at once (docs/realtime-rendering.md "A press shows at
# once"). The LCD's shade (components/frameos_display/lcd_press.c: drawn in
# the buffer on the glass by the touch task, put back byte for byte) and the
# rules the touch and render tasks share (main/fos_press.c: when e-paper inks
# a press, what its ink is, when a finger is a drag). Both are pure, so a
# laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
DISPLAY_DIR = ESP32_DIR / "components" / "frameos_display"
LCD_PRESS = DISPLAY_DIR / "lcd_press.c"
LCD_PRESS_HEADER = DISPLAY_DIR / "include" / "lcd_press.h"
LCD_PRESS_TEST = MAIN_DIR / "tests" / "test_fos_lcd_press.c"
PRESS = MAIN_DIR / "fos_press.c"
PRESS_HEADER = MAIN_DIR / "fos_press.h"
PRESS_TEST = MAIN_DIR / "tests" / "test_fos_press.c"


def test_sources_exist():
    for path in (LCD_PRESS, LCD_PRESS_HEADER, LCD_PRESS_TEST, PRESS, PRESS_HEADER, PRESS_TEST):
        assert path.is_file(), f"missing {path}"


def test_both_stay_free_of_the_idf():
    for path in (LCD_PRESS, PRESS):
        assert "esp_" not in path.read_text(), f"{path.name} is pure; the drivers and tasks own the IDF"


def test_the_touch_task_lights_the_press_and_the_present_puts_it_away():
    touch = (MAIN_DIR / "fos_touch.c").read_text()
    lcd = (DISPLAY_DIR / "lcd_st7701s_rgb.c").read_text()
    # At first sight, before the settle, and again where it settled.
    assert "press_first_seen(p->id, wx, wy)" in touch
    assert "press_lifted((uint8_t)id)" in touch
    # Every touch board keeps the press map: the LCD lights by it.
    assert "frameos_nim_keep_press_map(true);" in touch
    assert "if (!fos_display_is_lcd()) frameos_nim_keep_press_map" not in touch
    # The next picture presented is the scene's answer: the press goes first.
    present = lcd[lcd.index("static void present_back(void)"):]
    present = present[: present.index("\n}\n")]
    assert present.index("press_end_presenting()") < present.index("esp_lcd_panel_draw_bitmap")


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_lcd_press_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_lcd_press"
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            f"-I{DISPLAY_DIR / 'include'}",
            str(LCD_PRESS), str(LCD_PRESS_TEST),
            "-o", str(binary),
        ],
        check=True,
    )
    result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok:" in result.stdout


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_press_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_press"
    subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            f"-I{MAIN_DIR}",
            str(PRESS), str(PRESS_TEST),
            "-o", str(binary),
        ],
        check=True,
    )
    result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok:" in result.stdout
