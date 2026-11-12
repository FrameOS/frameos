from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_it8951.c: the pure half of the
# IT8951 panel driver (components/frameos_display/it8951.c) — one row of the
# packed sixteen-grey buffer in big-endian 4-bit wire order, as it is on the
# Waveshare 10.3" HAT and mirrored on the Seeed reTerminal E1003, and the tile
# digests and rectangles that decide what goes to the controller again. Same
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


def _functions(text: str) -> dict[str, str]:
    """Every C function definition in `text`, by name, with its body."""
    bodies: dict[str, str] = {}
    for match in re.finditer(r"^[a-z][^;{}\n]*\b(\w+)\(([^;{}]*)\)\s*\{", text, re.MULTILINE):
        depth = 0
        for index in range(match.end() - 1, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    bodies[match.group(1)] = text[match.end() - 1 : index + 1]
                    break
    return bodies


def test_a_started_waveform_is_waited_for_before_the_next_use():
    """A refresh is started and left running (s_waveform_pending): the render
    task handles taps and draws the next frame meanwhile, 0.85 s of each of
    the E1003's scene switches. The waveform reads the controller's image
    buffer and standby cuts it short, so every entry point that loads a
    rectangle, starts a waveform or sends the controller to standby waits for
    it first (finish_waveforms). One that forgets tears the picture."""
    text = SOURCE.read_text()
    functions = _functions(text[text.index("#ifdef ESP_PLATFORM") :])
    assert "finish_waveforms" in functions
    touches = ("load_rect(", "start_waveform(", "CMD_STANDBY")
    checked = []
    for name, body in functions.items():
        if not name.startswith("fos_it8951_10in3_"):
            continue
        uses = [body.find(touch) for touch in touches if body.find(touch) >= 0]
        if not uses:
            continue
        checked.append(name)
        finish = body.find("finish_waveforms()")
        assert 0 <= finish < min(uses), f"it8951.c: {name} uses the controller before the last waveform finished"
    assert {"fos_it8951_10in3_display", "fos_it8951_10in3_partial_show", "fos_it8951_10in3_clean",
            "fos_it8951_10in3_rest", "fos_it8951_10in3_sleep", "fos_it8951_10in3_clear"} <= set(checked)
    # The two passes that start one leave it pending rather than waiting.
    for name in ("fos_it8951_10in3_display", "fos_it8951_10in3_partial_show", "fos_it8951_10in3_clean"):
        assert "s_waveform_pending = true" in functions[name], f"it8951.c: {name} no longer leaves its waveform running"
        assert "wait_waveforms()" not in functions[name], f"it8951.c: {name} waits for its own waveform again"


def test_quick_pictures_go_up_the_fast_way_and_a_white_tile_owes_nothing():
    """Outside a tap's hold, every frame of the Kitchen sink's Motion page put
    a GC16 over each changed rectangle with a grey in it (the balls' edges):
    sections of the panel flashing, frame after frame (2026-11-10). Quick
    pictures (fos_pictures_fast) now take the tapping session's DU, and the
    settle's own picture still the slow way. A rectangle DU drew in pure black
    and white owes no GC16 any more: the white tiles a ball left behind would
    otherwise flash a trail when the motion stops."""
    client = (ESP32_DIR / "main" / "fos_client.c").read_text()
    functions = _functions(client)
    render = next(body for body in functions.values() if "fos_display_update(buf, buf_len, strcmp(" in body)
    # The scene's own cadence when the board renders it; a frame rendered on
    # the server has none here (docs/server-rendering.md).
    assert "fos_pictures_fast(local_render ? fos_scene_interval_snap(frameos_nim_scene_interval()) : 0.0," in render
    assert "fos_input_hold_engaged(&s_input_hold) ||" in render
    update = render.index("fos_display_update(buf, buf_len, strcmp(")
    assert render.index("bool fast =") < update < render.index("s_last_picture_us = picture_us")
    assert "fos_display_update(buf, len, true, false, &partial)" in functions["settle_panel"]
    driver = _functions(SOURCE.read_text())
    assert "set_owed(&rects[i], !plain[i])" in driver["fos_it8951_10in3_partial_show"]
    assert "memchr(s_tiles->owed, 1, sizeof(s_tiles->owed))" in driver["set_owed"]


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
