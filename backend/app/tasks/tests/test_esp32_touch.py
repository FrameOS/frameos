from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_touch.c: the pure half of the
# touch panel driver (fos_touch.c) — the GT911 report decode, the scaling of
# a coordinate onto the contract's pointer wire, and the axis-swap rule for
# a glass mounted across its controller. Same arrangement as
# test_esp32_board.py next door: the file keeps that half above the
# ESP_PLATFORM guard, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCE = MAIN_DIR / "fos_touch.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_touch.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_pure_half_stays_above_the_platform_guard():
    text = SOURCE.read_text()
    guard = text.index("#ifdef ESP_PLATFORM")
    pure = text[:guard]
    assert "esp_" not in pure, "fos_touch.c: IDF reference above the guard"
    assert "driver/" not in pure, "fos_touch.c: a driver include belongs below the guard"


def test_wire_max_matches_the_contract():
    """The driver scales onto the contract's wire; a change there is a change here."""
    import json

    contract = json.loads((REPO_ROOT / "docs" / "events-contract.json").read_text())
    header = (MAIN_DIR / "fos_touch.h").read_text()
    assert f"#define FOS_TOUCH_WIRE_MAX {contract['pointer']['wireMax']}" in header


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_touch_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_touch"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(SOURCE),
         str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "touch host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert "0 failures" in run_result.stdout, run_result.stdout
