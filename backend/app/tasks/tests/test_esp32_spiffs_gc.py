from __future__ import annotations

import os
import re
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


def test_a_split_removes_the_old_slots_before_writing_new_ones():
    """test_fos_spiffs_gc.c's test_a_big_set_pushed_over_itself_splits replays
    the store; this is the store doing it. Old slots kept until each was
    replaced held the old set, the new one and the combined payload at once,
    and a 20-scene push of 389,616 bytes over itself never split on the
    reTerminal E1002's 1 MB /state (2026-11-10)."""
    text = (MAIN_DIR / "fos_scenes.c").read_text()
    start = text.index("static esp_err_t split_scenes(")
    body = text[start : text.index("\n}\n", start)]
    scan = body.index("scan_array_elements(")
    first_write = body.index("write_slot(")
    removal = body.find("remove_slots_from(0);", scan)
    assert scan < removal < first_write, (
        "split_scenes must remove the old slots after the payload scanned as an array of scenes "
        "and before it writes the first new slot"
    )


def test_a_split_that_found_no_room_is_not_tried_again_until_the_next_payload():
    """A split that cannot fit writes slots until the partition is full, then
    loads the payload whole; the combined file stays, so every boot tried
    again: 40 s of SPIFFS garbage collection per boot on the reTerminal
    E1002 (2026-11-10), every wake on a battery. The store remembers the
    payload (split_noroom), and anything that stores a new one forgets it."""
    text = (MAIN_DIR / "fos_scenes.c").read_text()
    apply = text[text.index("bool fos_scenes_apply_pending(void)") :]
    apply = apply[: apply.index("\n}\n")]
    assert "split_no_room_len() != (uint32_t)len && split_scenes(json, len) == ESP_OK" in apply
    whole = apply.index("load_into_nim(json, len, \"stored\")")
    mark = apply.index("set_split_no_room_len((uint32_t)len)")
    assert mark < whole and "if (s_split_out_of_room)" in apply[:mark]
    # Running out of room, not any failure: a cJSON allocation that failed is
    # worth another try at the next boot.
    split = text[text.index("static esp_err_t split_scenes(") :]
    split = split[: split.index("\n}\n")]
    assert split.count("s_split_out_of_room = err == ESP_ERR_NO_MEM") == 2
    # Every write of the combined file is a new payload and clears the mark.
    writes = [m.start() for m in re.finditer(r"write_file_replace\(SCENES_PATH,", text)]
    assert len(writes) == 2
    for start in writes:
        window = text[start : start + 900]
        assert "set_split_no_room_len(0)" in window, "a new scene payload must clear split_noroom"


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
