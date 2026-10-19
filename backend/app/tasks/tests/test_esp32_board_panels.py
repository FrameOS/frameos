from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app.tasks.embedded_firmware import (
    EMBEDDED_DEVICE_PANELS,
    EMBEDDED_HARDWARE_PRESETS,
    EMBEDDED_PANEL_FORMATS,
    embedded_panel_for_device,
)
from app.tasks.tests.test_esp32_cloud_contract import cjson_dir

# Which panels an ESP32 board can be pushed (the `device` setting): the board
# table in docs/esp32-board-panels.json, the panels the firmware compiles in
# (generate_panel_table.panel_catalog), and the rule in fos_board_panels.c,
# which runs here against the `panels` cases of docs/cloud-frames-fixtures.json
# — the cases the cloud and the SPA run too.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
PANELS_SOURCE = MAIN_DIR / "fos_board_panels.c"
PANELS_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_board_panels.c"
FIXTURES = REPO_ROOT / "docs" / "cloud-frames-fixtures.json"
BOARDS = REPO_ROOT / "docs" / "esp32-board-panels.json"
GENERATOR = REPO_ROOT / "frameos" / "tools" / "generate_esp32_board_panels.py"
PANEL_TABLE_DIR = REPO_ROOT / "embedded" / "esp32" / "components" / "frameos_display"


def panel_catalog() -> list[dict]:
    sys.path.insert(0, str(PANEL_TABLE_DIR))
    import generate_panel_table

    return generate_panel_table.panel_catalog(REPO_ROOT)


def test_rule_is_pure():
    """The split that makes the host test possible: no IDF in the rule."""
    source = PANELS_SOURCE.read_text()
    assert "esp_" not in source
    assert "freertos" not in source


def test_generated_tables_are_current():
    result = subprocess.run(["python3", str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_fixture_panels_are_the_firmware_s():
    """The host test reads panel facts from the fixture; they must be the real table's."""
    catalog = {panel["name"]: panel for panel in panel_catalog()}
    compiled = json.loads(FIXTURES.read_text())["panels"]["compiled"]
    for name, facts in compiled.items():
        assert name in catalog, f"{name} is not compiled into the firmware"
        assert facts.get("bus") == ("i2c" if catalog[name]["bus"] == 1 else "spi"), name
        assert bool(facts.get("requiresCs2")) == catalog[name]["requiresCs2"], name


def test_backend_tables_agree_with_the_board_table():
    """EMBEDDED_HARDWARE_PRESETS, the backend's panel list and its device-key
    aliases are hand-kept copies; the board table and the panel catalog are
    what a push is judged by."""
    boards = json.loads(BOARDS.read_text())["boards"]
    esp32_presets = {
        name: preset
        for name, preset in EMBEDDED_HARDWARE_PRESETS.items()
        if str(preset.get("platform", "esp32-s3")).startswith("esp32")
    }
    assert set(esp32_presets) == set(boards)
    for name, preset in esp32_presets.items():
        assert embedded_panel_for_device(preset["device"]) == boards[name]["panel"], name
    catalog = panel_catalog()
    assert set(EMBEDDED_PANEL_FORMATS) == {panel["name"] for panel in catalog}
    aliases = {p["device"]: p["name"] for p in catalog if p["device"] != f"waveshare.{p['name']}"}
    assert EMBEDDED_DEVICE_PANELS == aliases


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(cjson_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for cJSON")
def test_fos_board_panels_fixtures_pass(tmp_path: Path):
    cjson = cjson_dir()
    assert cjson is not None
    binary = tmp_path / "test_fos_board_panels"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            "-I", str(MAIN_DIR), "-I", str(cjson),
            str(cjson / "cJSON.c"), str(PANELS_SOURCE), str(PANELS_TEST_SOURCE),
            "-lm", "-o", str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    run_result = subprocess.run([str(binary), str(FIXTURES)], capture_output=True, text=True)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert " 0 failures" in run_result.stdout
