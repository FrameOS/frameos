from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_it8951.c: the pure half of the
# IT8951 panel driver (components/frameos_display/it8951.c) — one row of the
# packed sixteen-grey buffer in big-endian 4-bit wire order, as it is on the
# Waveshare 10.3" HAT and mirrored on the Seeed reTerminal E1003, and the row
# digest that decides which rows go to the controller again. Same
# arrangement as test_esp32_touch.py next door: the file keeps that half
# above the ESP_PLATFORM guard, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
DISPLAY_DIR = ESP32_DIR / "components" / "frameos_display"
SOURCE = DISPLAY_DIR / "it8951.c"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_it8951.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_pure_half_stays_above_the_platform_guard():
    text = SOURCE.read_text()
    guard = text.index("#ifdef ESP_PLATFORM")
    pure = text[:guard]
    assert "esp_" not in pure, "it8951.c: IDF reference above the guard"
    assert "DEV_Config.h" not in pure, "it8951.c: the bus include belongs below the guard"


def test_panel_table_entry_matches_the_driver():
    """generate_panel_table.py's EXTRA_PANELS row names this driver's functions
    and its 1872x1404 sixteen-grey buffer; the backend mirror lists the panel."""
    generator = (DISPLAY_DIR / "generate_panel_table.py").read_text()
    header = (DISPLAY_DIR / "include" / "it8951.h").read_text()
    for name in ("init", "clear", "display", "sleep"):
        assert f'"fos_it8951_10in3_{name}"' in generator
        assert f"fos_it8951_10in3_{name}(" in header
    assert "#define FOS_IT8951_10IN3_WIDTH 1872" in header
    assert "#define FOS_IT8951_10IN3_HEIGHT 1404" in header

    from app.tasks.embedded_firmware import (
        EMBEDDED_PANEL_FORMATS,
        EMBEDDED_UNSUPPORTED_PANELS,
        FOS_PIXEL_4BPP_GRAY,
    )

    assert EMBEDDED_PANEL_FORMATS["EPD_10in3"] == FOS_PIXEL_4BPP_GRAY
    assert "EPD_10in3" not in EMBEDDED_UNSUPPORTED_PANELS


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_it8951_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_it8951"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(DISPLAY_DIR / "include"), str(SOURCE),
         str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "IT8951 host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 15, f"expected the full suite to run, saw {summary.group(1)} checks"
