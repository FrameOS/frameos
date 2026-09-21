from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

# The scene event contract (docs/events-contract.json) as the repo's Python
# CI sees it: the generated tables are current, and the firmware's C table
# (embedded/esp32/main/fos_events_gen.h) answers the `origins` section of the
# conformance corpus (docs/event-fixtures.json) the way every other runner
# does. Same arrangement as test_esp32_cloud_contract.py next door; the header
# is IDF-free and the cases go in on stdin, so this one never skips for want
# of an ESP-IDF checkout.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
HEADER = MAIN_DIR / "fos_events_gen.h"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_events.c"
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
DISPATCH_SOURCE = MAIN_DIR / "fos_events.c"
DISPATCH_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_events_dispatch.c"
FIXTURES = REPO_ROOT / "docs" / "event-fixtures.json"
GENERATOR = REPO_ROOT / "frameos" / "tools" / "generate_events_contract.py"


def test_generated_tables_are_current():
    """docs/events-contract.json is the source; every committed table must match it."""
    result = subprocess.run(["python3", str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_header_is_pure():
    source = HEADER.read_text()
    assert "esp_" not in source, "fos_events_gen.h must not pull in IDF headers or calls"
    assert "freertos" not in source


def test_the_firmware_paths_read_the_contract():
    """The C paths that look at an event name include the generated header."""
    for name in ("fos_schedule.c", "fos_http.c"):
        assert '#include "fos_events_gen.h"' in (MAIN_DIR / name).read_text(), name


def test_every_producer_goes_through_the_one_dispatcher():
    """fos_events.c decides what an event means; nobody else hands one to the Nim runtime."""
    for name in ("fos_http.c", "fos_schedule.c", "fos_cloud.c", "fos_console.c", "fos_buttons.c"):
        source = (MAIN_DIR / name).read_text()
        assert "fos_events_dispatch" in source, name
        assert "frameos_nim_send_event" not in source, f"{name} must call fos_events_dispatch instead"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_events_answers_the_origin_fixtures(tmp_path: Path):
    binary = tmp_path / "test_fos_events"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    cases = json.loads(FIXTURES.read_text())["origins"]["cases"]
    lines = "".join(f"{case['origin']} {case['event']} {1 if case['allowed'] else 0}\n" for case in cases)
    run_result = subprocess.run([str(binary)], input=lines, capture_output=True, text=True)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert f"{len(cases)} cases, 0 failures" in run_result.stdout


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_events_dispatch_routes_events(tmp_path: Path):
    """The routing itself (allow-list, firmware-owned events, the hand-off to Nim), against stubs."""
    binary = tmp_path / "test_fos_events_dispatch"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            "-I", str(MAIN_DIR),
            "-I", str(MAIN_DIR / "tests" / "host_shim"),
            "-I", str(ESP32_DIR / "components" / "frameos_nim" / "include"),
            "-I", str(ESP32_DIR / "components" / "frameos_display" / "include"),
            str(DISPATCH_SOURCE), str(DISPATCH_TEST_SOURCE), "-o", str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert "0 failures" in run_result.stdout
