from __future__ import annotations

import json

import os
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_cloud_contract.c: the firmware's
# walker of the generated cloud-contract tables against the conformance
# corpus (docs/cloud-frames-fixtures.json) that the Linux runtime and the
# cloud run too. Same arrangement as test_esp32_power.py next door.
#
# cJSON is ESP-IDF's copy (components/json/cJSON); without an IDF checkout
# on the machine the host build is skipped, never faked.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
CONTRACT_SOURCE = MAIN_DIR / "fos_cloud_contract.c"
CONTRACT_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_cloud_contract.c"
FIXTURES = REPO_ROOT / "docs" / "cloud-frames-fixtures.json"
GENERATOR = REPO_ROOT / "frameos" / "tools" / "generate_cloud_contract.py"


def cjson_dir() -> Path | None:
    idf_path = os.environ.get("IDF_PATH")
    candidates = [Path(idf_path) if idf_path else None, Path.home() / "esp" / "esp-idf"]
    for candidate in candidates:
        if candidate and (candidate / "components" / "json" / "cJSON" / "cJSON.c").is_file():
            return candidate / "components" / "json" / "cJSON"
    return None


def test_sources_exist():
    assert CONTRACT_SOURCE.is_file(), f"missing {CONTRACT_SOURCE}"
    assert CONTRACT_TEST_SOURCE.is_file(), f"missing {CONTRACT_TEST_SOURCE}"
    assert FIXTURES.is_file(), f"missing {FIXTURES}"


def test_contract_walker_is_pure():
    """The point of the split: fos_cloud_contract.c must stay buildable without the IDF."""
    source = CONTRACT_SOURCE.read_text()
    assert "esp_" not in source, "fos_cloud_contract.c must not pull in IDF headers or calls"
    assert "freertos" not in source


def test_generated_tables_are_current():
    """docs/cloud-frames-contract.json is the source; the committed tables must match it."""
    result = subprocess.run(["python3", str(GENERATOR), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(cjson_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for cJSON")
def test_fos_cloud_contract_fixtures_pass(tmp_path: Path):
    cjson = cjson_dir()
    assert cjson is not None
    binary = tmp_path / "test_fos_cloud_contract"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            "-I", str(MAIN_DIR), "-I", str(cjson),
            str(cjson / "cJSON.c"), str(CONTRACT_SOURCE), str(CONTRACT_TEST_SOURCE),
            "-lm", "-o", str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    run_result = subprocess.run([str(binary), str(FIXTURES)], capture_output=True, text=True)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert "0 failures" in run_result.stdout


def test_single_plane_settings_carry_a_parity_reason():
    """docs/convergence-todo.md item 6: the linux-only / esp32-only split is the
    measured parity gap, and no key may be single-plane without saying why."""
    doc = json.loads((REPO_ROOT / "docs" / "cloud-frames-contract.json").read_text(encoding="utf-8"))
    every = set(doc["profiles"])
    single = {name: spec for name, spec in doc["settings"].items() if set(spec["profiles"]) != every}
    both = {name for name, spec in doc["settings"].items() if set(spec["profiles"]) == every}
    for name, spec in single.items():
        parity = spec.get("parity")
        assert isinstance(parity, dict), f"{name} is single-plane and carries no parity entry"
        assert set(spec["profiles"]) == {parity["only"]}, name
        assert len(parity["why"].strip()) >= 20, name
    for name in both:
        assert "parity" not in doc["settings"][name], f"{name} is accepted on both planes; drop its parity entry"
    # The gap as measured today. Shrinking is progress and needs no ceremony;
    # growing it is a decision that belongs in the contract, not here.
    by_plane = {}
    for spec in single.values():
        by_plane[spec["parity"]["only"]] = by_plane.get(spec["parity"]["only"], 0) + 1
    assert by_plane.get("linux", 0) <= 8, by_plane
    assert by_plane.get("esp32", 0) <= 7, by_plane
