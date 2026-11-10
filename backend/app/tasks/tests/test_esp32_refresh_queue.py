from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_refresh_queue.c.
#
# An SPI e-paper panel's full refresh runs on the display's own task
# (components/frameos_display/frameos_display.c refresh_task): the reTerminal
# E1002's color refresh is 28.7 s, and the render task used to sit out all of
# it, answering no key and no command. fos_refresh_queue.c is the hand-over:
# the picture on its way and the newest after it. The second half of this
# file reads frameos_display.c for the rule that makes the hand-over safe:
# nothing else talks to the panel while a picture is owed.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
COMPONENT = ESP32_DIR / "components" / "frameos_display"
SOURCE = COMPONENT / "fos_refresh_queue.c"
DISPLAY = COMPONENT / "frameos_display.c"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_refresh_queue.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"
    assert '"fos_refresh_queue.c"' in (COMPONENT / "CMakeLists.txt").read_text()


def test_refresh_queue_is_pure():
    source = SOURCE.read_text()
    assert "esp_" not in source, "fos_refresh_queue.c must not pull in IDF headers or calls"
    assert "freertos" not in source


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


# A panel entry point waits for the refresh task with one of these first.
_WAITS = ("refresh_wait()", "fos_display_park()", "fos_refresh_queue_busy(")


def test_nothing_talks_to_the_panel_while_a_picture_is_owed():
    """Every function that takes the panel's bus, other than the refresh
    itself, first waits for the refresh task or leaves when it is busy: a
    partial update, a clear or a sleep in the middle of a waveform corrupts
    it, and a refresh still owed would paint over what it drew."""
    functions = _functions(DISPLAY.read_text())
    assert "refresh_in_place" in functions and "refresh_task" in functions
    takers = {name: body for name, body in functions.items() if "DEV_SPI_Acquire()" in body}
    assert {"fos_display_update", "fos_display_park", "fos_display_clear"} <= set(takers)
    for name, body in takers.items():
        if name == "refresh_in_place":
            continue
        first_take = body.index("DEV_SPI_Acquire()")
        waits = [body.find(wait) for wait in _WAITS if 0 <= body.find(wait) < first_take]
        assert waits, f"frameos_display.c: {name} takes the panel without waiting for the refresh task"
    blit = functions["fos_display_blit"]
    assert blit.index("refresh_wait()") < blit.index("refresh_in_place(buf)"), (
        "fos_display_blit refreshes in place without waiting for the refresh task"
    )
    # A deep sleep and a restart wait for the refresh too.
    assert "esp_register_shutdown_handler(refresh_shutdown)" in DISPLAY.read_text()


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_refresh_queue_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_refresh_queue"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(COMPONENT / "include"), str(SOURCE),
         str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "refresh queue host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "refresh queue host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout[-4000:]
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 40, f"expected the full suite to run, saw {summary.group(1)} checks"
