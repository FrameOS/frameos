from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_voice_binding.c: which of the
# frame's keys the event map makes voice keys (docs/voice-chat.md: a `button`
# rule emitting `voiceChat` on a key's long press). Same arrangement as
# test_esp32_cloud_contract.py next door: the module is pure cJSON, cJSON is
# ESP-IDF's copy, and without an IDF checkout the host build is skipped,
# never faked (the e2e-docker workflow builds it with the IDF image).

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
BINDING_SOURCE = MAIN_DIR / "fos_voice_binding.c"
BINDING_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_voice_binding.c"


def cjson_dir() -> Path | None:
    idf_path = os.environ.get("IDF_PATH")
    candidates = [Path(idf_path) if idf_path else None, Path.home() / "esp" / "esp-idf"]
    for candidate in candidates:
        if candidate and (candidate / "components" / "json" / "cJSON" / "cJSON.c").is_file():
            return candidate / "components" / "json" / "cJSON"
    return None


def test_sources_exist():
    assert BINDING_SOURCE.is_file(), f"missing {BINDING_SOURCE}"
    assert BINDING_TEST_SOURCE.is_file(), f"missing {BINDING_TEST_SOURCE}"


def test_binding_reader_is_pure():
    source = BINDING_SOURCE.read_text()
    assert "esp_" not in source, "fos_voice_binding.c must not pull in IDF headers or calls"
    assert "freertos" not in source


def test_the_workflow_builds_it():
    """The CI image has cJSON; the host test is in its list, so it runs there even when this skips."""
    workflow = (REPO_ROOT / ".github" / "workflows" / "e2e-docker.yml").read_text()
    assert "tests/test_fos_voice_binding.c" in workflow


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(cjson_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for cJSON")
def test_voice_binding_host_tests_pass(tmp_path: Path):
    cjson = cjson_dir()
    assert cjson is not None
    binary = tmp_path / "test_fos_voice_binding"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            "-I", str(MAIN_DIR), "-I", str(cjson),
            str(cjson / "cJSON.c"), str(BINDING_SOURCE), str(BINDING_TEST_SOURCE),
            "-lm", "-o", str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert "0 failures" in run_result.stdout
