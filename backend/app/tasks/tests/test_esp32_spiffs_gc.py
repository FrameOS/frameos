from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_spiffs_gc.c: room on the /state
# SPIFFS partition before a write, from the blocks that hold only deleted
# pages (fos_spiffs_gc.c, linked over SPIFFS_gc). The test drives ESP-IDF's
# own SPIFFS sources on a partition in RAM, so without an IDF checkout it is
# skipped, never faked (the e2e-docker workflow builds the module with the
# IDF image).

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
SOURCE = MAIN_DIR / "fos_spiffs_gc.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_spiffs_gc.c"
SHIM_DIR = MAIN_DIR / "tests" / "spiffs_shim"


def spiffs_dir() -> Path | None:
    idf_path = os.environ.get("IDF_PATH")
    candidates = [Path(idf_path) if idf_path else None, Path.home() / "esp" / "esp-idf"]
    for candidate in candidates:
        if candidate and (candidate / "components" / "spiffs" / "spiffs" / "src" / "spiffs_gc.c").is_file():
            return candidate / "components" / "spiffs"
    return None


def test_sources_exist():
    assert SOURCE.is_file(), f"missing {SOURCE}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_spiffs_gc_is_wrapped_in_the_firmware_build():
    cmake = (MAIN_DIR / "CMakeLists.txt").read_text()
    assert '"fos_spiffs_gc.c"' in cmake
    assert "-Wl,--wrap=SPIFFS_gc" in cmake
    assert "-u __wrap_SPIFFS_gc" in cmake


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(spiffs_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for SPIFFS")
def test_spiffs_gc_host_tests_pass(tmp_path: Path):
    spiffs = spiffs_dir()
    assert spiffs is not None
    src = spiffs / "spiffs" / "src"
    includes = ["-I", str(MAIN_DIR), "-I", str(SHIM_DIR), "-I", str(spiffs / "include"), "-I", str(src)]
    objects = []
    # SPIFFS as ESP-IDF ships it: its own warnings are not ours to fix.
    for name in ["spiffs_cache.c", "spiffs_check.c", "spiffs_gc.c", "spiffs_hydrogen.c", "spiffs_nucleus.c"]:
        obj = tmp_path / name.replace(".c", ".o")
        result = subprocess.run(
            ["cc", "-std=c11", "-O2", "-w", *includes, "-c", str(src / name), "-o", str(obj)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        assert result.returncode == 0, result.stderr
        objects.append(str(obj))
    binary = tmp_path / "test_fos_spiffs_gc"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", *includes,
            # macOS's linker has no --wrap: the wrapper calls SPIFFS_gc itself.
            "-D__real_SPIFFS_gc=SPIFFS_gc",
            str(SOURCE), str(TEST_SOURCE), *objects, "-o", str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, run_result.stdout + run_result.stderr
    assert "0 failures" in run_result.stdout
