from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import TypedDict

import pytest

# Runs embedded/esp32/main/tests/test_fos_lan_access.c and
# test_fos_panel_draw.c: the ESP32 half of the local network access switch
# (docs/lan-access.md).
#
# test_fos_lan_access.c drives the code's state machine with an injected clock
# and RNG: six uniform digits, 300 s, five attempts, single use, the verb's
# error tokens. test_fos_panel_draw.c draws the code box over a packed render in
# every pixel format and rotation and checks that restoring it gives the render
# back byte for byte: that is what keeps the code out of /image, image_get and
# the BMP push to the backend, which all read the buffer after the blit.
#
# Both modules are plain C with no IDF (frameos_display.h only needs the
# esp_err.h host shim), so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN = ESP32_DIR / "main"

class Suite(TypedDict):
    sources: list[Path]
    includes: list[Path]
    min_checks: int


SUITES: dict[str, Suite] = {
    "lan_access": {
        "sources": [MAIN / "fos_lan_access.c", MAIN / "tests" / "test_fos_lan_access.c"],
        "includes": [MAIN],
        "min_checks": 100,
    },
    "panel_draw": {
        "sources": [MAIN / "fos_panel_draw.c", MAIN / "tests" / "test_fos_panel_draw.c"],
        "includes": [
            MAIN,
            MAIN / "tests" / "host_shim",
            ESP32_DIR / "components" / "frameos_display" / "include",
        ],
        "min_checks": 1000,
    },
}


@pytest.mark.parametrize("name", sorted(SUITES))
def test_sources_exist(name: str):
    for source in SUITES[name]["sources"]:
        assert source.is_file(), f"missing {source}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.parametrize("name", sorted(SUITES))
def test_host_tests_pass(name: str, tmp_path: Path):
    suite = SUITES[name]
    binary = tmp_path / f"test_fos_{name}"
    command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2"]
    for include in suite["includes"]:
        command += ["-I", str(include)]
    command += [str(source) for source in suite["sources"]]
    command += ["-o", str(binary)]
    compile_result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    assert compile_result.returncode == 0, (
        f"{name} host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, (
        f"{name} host tests failed:\n" + run_result.stdout[-4000:]
    )

    # A binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= suite["min_checks"], (
        f"expected the full {name} suite to run, saw {checks} checks"
    )


# The code is drawn into the buffer the panel shows, and on an LCD that
# renders in place that buffer is also what the preview borrows. fos_client.c
# needs IDF, so the order is pinned here: "is a code pending" is asked once a
# render, the answer decides both the clean copy and the overlay, and a panel
# buffer an overlay went into is never lent to the preview.


def _render_overlay_block() -> str:
    source = (MAIN / "fos_client.c").read_text()
    start = source.index("lan_overlay_t lan_overlay = {0};")
    return source[start:source.index("ESP_LOGI(TAG, \"render #%lu done", start)]


def test_the_pending_code_is_asked_once_a_render():
    block = _render_overlay_block()
    assert block.count("lan_overlay_due(") == 1
    assert "panel_overlay_pending()" not in block
    assert "fos_lan_access_panel_code(" not in block
    asked = block.index("bool lan_due = lan_overlay_due(lan_code);")
    copied = block.index("store_snapshot(buf", asked)
    drawn = block.index("lan_overlay_begin(&lan_overlay, lan_code", asked)
    assert asked < copied < drawn, "the clean copy is taken before the code goes on"
    assert "if (in_panel && (lan_due || notice_due))" in block[asked:copied]
    # The overlay itself reads nothing: it draws the code it is handed.
    source = (MAIN / "fos_client.c").read_text()
    begin = source[source.index("static void lan_overlay_begin("):]
    begin = begin[:begin.index("\n}\n")]
    assert "fos_lan_access_panel_code(" not in begin


def test_a_buffer_an_overlay_went_into_is_never_lent_to_the_preview():
    block = _render_overlay_block()
    assert "} else if (!snapshot_stored && !(in_panel && overlay_drawn)) {" in block
    # The only other snapshot of a fresh picture is the copy from before the overlay.
    assert block.count("store_snapshot(buf") == 3
