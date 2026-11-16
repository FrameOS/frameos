from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_oom_policy.c — whether an
# out-of-memory abort restarts the ESP32 frame (frameos_nim_glue.c).
# Same arrangement as test_esp32_version.py: a host test nothing invokes is a
# host test that does not exist.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
SOURCE = ESP32_DIR / "components" / "frameos_nim" / "fos_oom_policy.c"
INCLUDE = ESP32_DIR / "components" / "frameos_nim" / "include"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_oom_policy.c"


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_oom_policy_is_pure():
    source = SOURCE.read_text()
    assert "esp_" not in source, "fos_oom_policy.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_oom_policy_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_oom_policy"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(INCLUDE), str(SOURCE), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "OOM policy host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "OOM policy host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 20


def test_glue_guards_every_scene_load():
    # A scene switch off flash (frameos_nim_load_scene) that did not fit
    # rebooted the frame from Nim's raiseOutOfMem when it ran unguarded.
    glue = (ESP32_DIR / "components" / "frameos_nim" / "frameos_nim_glue.c").read_text()
    for impl in ("fos_nim_load_scene_impl(scene_json)", "fos_nim_load_scenes_impl(json)"):
        call = glue.index(impl)
        assert "s_nim_oom_jmp_armed = true;" in glue[call - 200 : call], impl
    assert "fos_oom_policy_abort(" in glue
    assert glue.count("nim_guard_note_free();") == glue.count("if (setjmp(s_nim_oom_jmp) == 0)")
