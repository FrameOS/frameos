from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_usj_attach.c: when the console
# installs its USB-Serial/JTAG driver (only once a USB host is seen on the
# native port, never with the pads claimed). The driver's rings are 10 KB of
# internal RAM; docs/esp32-memory.md, "Console".

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCE = MAIN_DIR / "fos_usj_attach.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_usj_attach.c"


def test_console_installs_the_driver_through_the_attach_rule():
    console = (MAIN_DIR / "fos_console.c").read_text()
    assert "fos_usj_attach_poll(" in console
    assert "usb_serial_jtag_is_connected()" in console
    # One call site for the install: the poll. fos_console_start no longer
    # installs it at boot.
    assert console.count("console_init_usb_serial_jtag();") == 1


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_usj_attach_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_usj_attach"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR),
         str(SOURCE), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True, text=True, timeout=120,
    )
    assert compile_result.returncode == 0, "does not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
