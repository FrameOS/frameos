from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_portal_screen.c: the provisioning
# portal's screen on an ESP32 without Wi-Fi (fos_portal_screen.c), two QR
# codes a phone joins the setup hotspot and opens the setup page by, and the
# C QR encoder behind them (fos_qr.c, a port of frameos/utils/qr.nim that
# replays its byte-mode vectors). The screen is drawn at every panel size,
# pixel format and rotation, and each code is read back off the buffer.
#
# Plain C with no IDF (frameos_display.h only needs the esp_err.h host shim),
# so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN = ESP32_DIR / "main"

SOURCES = [
    MAIN / "fos_qr.c",
    MAIN / "fos_panel_draw.c",
    MAIN / "fos_portal_screen.c",
    MAIN / "tests" / "test_fos_portal_screen.c",
]
INCLUDES = [MAIN, MAIN / "tests" / "host_shim", ESP32_DIR / "components" / "frameos_display" / "include"]


def test_sources_exist():
    for source in SOURCES:
        assert source.is_file(), f"missing {source}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_portal_screen"
    command = ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2"]
    for include in INCLUDES:
        command += ["-I", str(include)]
    command += [str(source) for source in SOURCES]
    command += ["-o", str(binary)]
    compile_result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    assert compile_result.returncode == 0, "portal screen host tests do not compile:\n" + compile_result.stderr

    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, "portal screen host tests failed:\n" + run_result.stdout[-4000:]

    # A binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 900, f"expected the full portal screen suite to run, saw {checks} checks"
