from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_scene_store.c: the per-scene store on
# /state (embedded/esp32/README.md "Scene storage"). The module is pure C and
# cJSON; cJSON is ESP-IDF's copy, and without an IDF checkout the host build is
# skipped, never faked (the e2e-docker workflow builds it with the IDF image).

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCE = MAIN_DIR / "fos_scene_store.c"
GUARD_SOURCE = MAIN_DIR / "fos_json_guard.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_scene_store.c"


def cjson_dir() -> Path | None:
    idf_path = os.environ.get("IDF_PATH")
    candidates = [Path(idf_path) if idf_path else None, Path.home() / "esp" / "esp-idf"]
    for candidate in candidates:
        if candidate and (candidate / "components" / "json" / "cJSON" / "cJSON.c").is_file():
            return candidate / "components" / "json" / "cJSON"
    return None


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_store_module_is_pure():
    source = SOURCE.read_text()
    assert "esp_" not in source, "fos_scene_store.c must not pull in IDF headers or calls"
    assert "freertos" not in source


def test_the_workflow_builds_it():
    workflow = (REPO_ROOT / ".github" / "workflows" / "e2e-docker.yml").read_text()
    assert "tests/test_fos_scene_store.c" in workflow


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(cjson_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for cJSON")
def test_scene_store_host_tests_pass(tmp_path: Path):
    cjson = cjson_dir()
    assert cjson is not None
    binary = tmp_path / "test_fos_scene_store"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            "-I", str(MAIN_DIR), "-I", str(cjson),
            str(cjson / "cJSON.c"), str(GUARD_SOURCE), str(SOURCE), str(TEST_SOURCE),
            "-lm", "-o", str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
