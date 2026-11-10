from __future__ import annotations

import os
import re
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


def _functions(text: str) -> dict[str, str]:
    """Every C function definition in `text`, by name, with its body (braces in
    string and character literals do not count)."""
    masked = re.sub(r"\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])'",
                    lambda m: m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[-1], text)
    bodies: dict[str, str] = {}
    for match in re.finditer(r"^[a-z][^;{}\n]*\b(\w+)\(([^;{}]*)\)\s*\{", masked, re.MULTILINE):
        depth = 0
        for index in range(match.end() - 1, len(masked)):
            if masked[index] == "{":
                depth += 1
            elif masked[index] == "}":
                depth -= 1
                if depth == 0:
                    bodies[match.group(1)] = text[match.end() - 1 : index + 1]
                    break
    return bodies


def test_a_pushed_payload_is_split_on_the_store_task():
    """A cloud push (or an HTTP / USB upload) is written by the task that
    received it and split by the scene store's own task, not in the render
    task's apply: 389 KB was seconds of slot writes there with no key answered
    (the reTerminal E1002, 2026-11-10), and not on the producer either (the
    cloud's is its WebSocket's). What must hold: the render task is told the
    slots are changing before the write and reads none until the split is
    done, the payload is pending only once it is split (inside the lock, so a
    one-scene change behind it refuses rather than patches), a switch waits
    for the payload's apply, and the split is paced like every write off the
    render task."""
    text = re.sub(r"/\*.*?\*/", "", (MAIN_DIR / "fos_scenes.c").read_text(), flags=re.S)
    fns = _functions(text)
    push = fns["fos_scenes_set_json_from"]
    order = [push.index(s) for s in (
        "s_store_changing = true", "store_lock()", "write_file_replace(SCENES_PATH",
        "s_payload_stored_since_boot = true", "if (!store_split_behind()) store_split_stored();")]
    assert order == sorted(order), "fos_scenes_set_json_from: flag, write, then hand the split over"
    assert "s_pending = true" not in push, "the payload is pending only once it is split"
    split = fns["store_split_stored"]
    order = [split.index(s) for s in (
        "store_lock()", "split_scenes_locked(json, len)", "s_pending = true", "s_store_changing = false",
        "store_unlock()")]
    assert order == sorted(order), "store_split_stored: split, then pending and changing, inside the lock"
    assert "set_split_no_room_len((uint32_t)len)" in split
    # The render the producer asked for ran during the split: the store task
    # asks again once the payload is pending, or it waits for the next pass.
    assert split.index("store_unlock()") < split.index("fos_client_render_now()")
    assert "store_split_stored()" in fns["store_task"]
    for reader in ("load_scene_slot", "fos_scenes_read_scene_json"):
        body = fns[reader]
        assert body.index("s_store_changing") < body.index("slot"), f"{reader} reads a slot while it changes"
    select = fns["fos_scenes_apply_pending_selection"]
    guard = select.index("if (s_store_changing || (s_pending && !s_patch_pending)) return false;")
    assert guard < select.index("s_scene_select_pending = false"), "a switch is consumed before the apply"
    assert "!fos_client_on_render_task()" in fns["store_pace_hook"]
    assert "s_payload_stored_since_boot" in fns["ensure_split_locked"]


def test_the_cloud_hears_the_new_sizes_after_a_push():
    """The storage report (each scene's footprint, what is free) rides the
    hardware report, which went out on hello alone for a push that kept the
    active scene: the workspace showed the old sizes until a reconnect. The
    cloud client notes the store as of each hardware report and sends a
    `state` with a fresh one when it moved, once no scene_ack is waiting."""
    text = re.sub(r"/\*.*?\*/", "", (MAIN_DIR / "fos_cloud.c").read_text(), flags=re.S)
    fns = _functions(text)
    hardware = fns["add_hardware_json"]
    assert hardware.index("s_store_generation_reported = fos_scenes_store_generation()") < hardware.index(
        "fos_scenes_add_storage_json(storage)"
    ), "note the store before the report reads it, so a change during it reports again"
    poll = fns["ws_poll_active_scene"]
    assert "!s_scene_ack_pending && fos_scenes_store_generation() != s_store_generation_reported" in poll
    assert "store_moved ||" in poll
    assert "add_state_fields(msg, &snap, true)" in poll, "the state carries the hardware report"
    scenes = (MAIN_DIR / "fos_scenes.c").read_text()
    assert "uint32_t fos_scenes_store_generation(void) { return fos_slot_cache_generation(&s_slot_cache); }" in scenes
