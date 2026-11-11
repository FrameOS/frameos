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
    # A per-scene store takes the set as changes first (the next test); the
    # whole-file write and the split are for a frame without one.
    whole = push[push.index("write_file_replace(SCENES_PATH"):]
    order = [push.index("s_store_changing = true"), push.index("store_lock()"),
             push.index("store_set_as_changes_locked(json, len, source)"), push.index("write_file_replace(SCENES_PATH")]
    assert order == sorted(order), "fos_scenes_set_json_from: flag, lock, as changes, else whole"
    order = [whole.index(s) for s in (
        "s_payload_stored_since_boot = true", "if (!store_split_behind()) store_split_stored();")]
    assert order == sorted(order), "fos_scenes_set_json_from: write whole, then hand the split over"
    assert "s_pending = true" not in whole, "a payload stored whole is pending only once it is split"
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


def _source(name: str) -> str:
    return re.sub(r"/\*.*?\*/", "", (MAIN_DIR / name).read_text(), flags=re.S)


def test_a_whole_set_goes_into_a_per_scene_store_as_changes():
    """A whole set (a cloud push, an upload, a backend pull) written whole
    beside the set it replaced needed room for both: the reTerminal E1002's
    415 KB, 20-scene set did not fit its 1 MB /state (ENOSPC, 2026-11-10), and
    a push that changed one scene wrote all twenty. With a per-scene store the
    set goes in as changes, one scene at a time (fos_scene_store_apply_set,
    host-tested in test_fos_scene_store.c): the cloud's is pending for the
    apply at once, with nothing to split; the backend's keeps the index it
    wrote. Without one, the set is stored whole as before."""
    fns = _functions(_source("fos_scenes.c"))
    helper = fns["store_set_as_changes_locked"]
    assert helper.index("if (combined_stored()) return ESP_ERR_NOT_FOUND;") < helper.index(
        "fos_scene_store_apply_set(")
    assert "forget_dropped_scene" in helper
    push = fns["fos_scenes_set_json_from"]
    changes = push[push.index("store_set_as_changes_locked(json, len, source)"):push.index("write_file_replace(SCENES_PATH")]
    order = [changes.index(s) for s in (
        "if (err == ESP_OK)", "save_etag(\"local\")", "s_payload_stored_since_boot = true", "s_pending = true",
        "s_store_changing = false", "store_unlock()", "fos_client_render_now()")]
    assert order == sorted(order), "stored as changes: pending and done inside the lock, then a render"
    assert "store_split" not in changes, "a set stored as changes has nothing to split"
    backend = fns["store_backend_payload"]
    order = [backend.index(s) for s in (
        "store_set_as_changes_locked(job->body, job->len, FOS_SCENES_SOURCE_BACKEND)",
        "if (err == ESP_ERR_NOT_FOUND)", "write_file_replace_locked(SCENES_PATH")]
    assert order == sorted(order), "store_backend_payload: as changes, else whole"
    assert "if (!as_changes) fos_scene_store_remove_index();" in backend, "the index it wrote is the new set's"
    # The render task's read of a scene file meets no file the store task is
    # emptying: under the store lock.
    read = fns["read_slot_file"]
    assert read.index("store_lock()") < read.index("read_file(path, &len)") < read.index("store_unlock()")
    # And it is not kept waiting for a whole set: the lock goes between two
    # committed scenes (23 rewritten on the E1003 held the render task 3.5 min).
    between = fns["store_between_hook"]
    assert between.index("store_unlock()") < between.index("store_lock()")
    assert ".between = store_between_hook" in _source("fos_scenes.c")


def test_a_backend_set_renders_at_once():
    """A backend set is taken from the idle wait (the link task's download,
    or a deploy's poke pulling it on the render task), where nothing renders:
    the new set showed at the next timed pass, an hour later on a scene that
    renders hourly (the E1003's deploy sat at "first render", 2026-11-10).
    Both ways go through fos_scenes_take_backend_payload, which asks."""
    take = _functions(_source("fos_scenes.c"))["fos_scenes_take_backend_payload"]
    assert take.index("load_into_nim(body, len, \"backend\");") < take.index("fos_client_render_now();") < take.index(
        "store_behind(body, len, etag)")


def test_a_paced_write_gives_way_to_a_render_task_waiting_for_the_store():
    """Pacing waits out taps and renders while holding the store lock, and the
    input hold it waits for is released by the render task alone. A tap, then
    a scene pull: the store task waited for the hold, the render task waited
    for the lock, and the reTerminal E1003 rendered nothing more (2026-11-10).
    The render task says when it waits for the lock, and pacing stops then."""
    fns = _functions(_source("fos_scenes.c"))
    lock = fns["store_lock"]
    order = [lock.index(s) for s in (
        "fos_client_on_render_task()", "xSemaphoreTakeRecursive(s_scene_file_lock, 0)",
        "s_render_waits_for_store = true", "xSemaphoreTakeRecursive(s_scene_file_lock, portMAX_DELAY)",
        "s_render_waits_for_store = false")]
    assert order == sorted(order), "store_lock: try first, say it waits, wait, then stop saying so"
    pace = fns["store_pace"]
    assert pace.index("if (s_render_waits_for_store)") < pace.index("fos_client_input_held()"), (
        "the render task waiting comes before every wait in the pace, the input hold's first"
    )
    # Every pacing wait goes through store_pace: nothing else in the store
    # waits for the input hold while it may hold the lock.
    assert sum(body.count("fos_client_input_held()") for body in fns.values()) == 1


def test_a_change_that_shows_its_scene_is_written_unpaced():
    """"Push & activate", "Install & activate", a put with activate: somebody
    waits to see the scene, so its write is not paced around renders (up to
    half a second for each 2 KB behind an e-paper render). The flag lives
    under the store lock, set by the one writer holding it, the split it may
    owe included; every other write stays paced."""
    scenes = _source("fos_scenes.c")
    fns = _functions(scenes)
    change = fns["apply_store_change"]
    order = [change.index(s) for s in (
        "store_lock()", "s_store_urgent = urgent", "ensure_split_locked()", "fos_scene_store_apply(",
        "s_store_urgent = false", "store_unlock()")]
    assert order == sorted(order), "apply_store_change: urgent from before the split to before the unlock"
    assert fns["store_pace_hook"].index("!s_store_urgent") < fns["store_pace_hook"].index("store_pace()")
    # Who says urgent: the cloud's patch that names a scene, a put that activates.
    assert "FOS_SCENES_SOURCE_CLOUD, NULL, select)" in _functions(_source("fos_cloud.c"))["ws_handle_set_scenes"]
    http = _source("fos_http.c")
    assert "fos_scenes_put(body, total, FOS_SCENES_SOURCE_LOCAL, activate," in http
    assert http.index("bool activate =") < http.index("fos_scenes_put(body, total")
    console = _source("fos_console.c")
    assert console.index("bool activate = scene_put") < console.index("fos_scenes_put((const char *)body")
    # The backend's patch is applied on the render task, which never paces.
    assert "FOS_SCENES_SOURCE_BACKEND, etag, false)" in scenes


def test_a_forced_backend_sync_still_asks_for_a_patch():
    """A deploy, "Push & activate" or a preview forces the pull; it used to
    leave its ETag off, so the backend answered the whole list every time
    (download, whole-set parse, combined-file write). Now it says what it
    holds, and the backend answers 304 or the scenes that changed, unless
    the frame holds no set at all."""
    fetch = _functions(_source("fos_scenes.c"))["fos_scenes_backend_fetch"]
    assert "bool holds_set = s_slot_count > 0 || s_loaded > 0;" in fetch
    assert '.if_none_match = (etag[0] && strcmp(etag, "local") != 0 && (!force || holds_set)) ? etag : NULL' in fetch
    assert "/embedded/scenes?patch=1" in fetch


def test_a_pushed_scene_opens_with_its_values_and_a_held_set_still_switches():
    """The cloud's set_scenes / scenes_patch `scene_id` + `state` go through
    the switch set_current_scene makes, so the scene opens with the values
    (the ESP32 dropped `state` from a push before). A patch of the set the
    frame already holds that names a scene (the install landed, then "Push &
    activate") switches and says scene_ack at once, instead of being acked
    and dropped."""
    cloud = _source("fos_cloud.c")
    fns = _functions(cloud)
    select = fns["select_pushed_scene"]
    assert "FOS_EVENT_SET_CURRENT_SCENE" in select and "fos_scenes_select(scene_id)" in select
    handler = fns["ws_handle_set_scenes"]
    assert handler.count('select_pushed_scene(scene_id->valuestring, cJSON_GetObjectItem(root, "state"), origin)') == 2
    held = handler[handler.index("strcmp(checksum->valuestring, s_applied_scenes_checksum) == 0"):]
    held = held[: held.index("return;")]
    assert held.index("ws_ack(id, true, NULL)") < held.index("select_pushed_scene") < held.index(
        "ws_send_scene_ack(checksum->valuestring)"
    )
    # The poll says it the same way once a payload is applied (its stub for
    # builds without the cloud has the same name, so the source is read).
    assert "ws_send_scene_ack(s_scene_ack_checksum);" in cloud


def test_the_scenes_module_asks_flash_as_little_as_the_store_does():
    """A SPIFFS lookup by name (stat, open, remove, rename) walks every block
    of the partition: ~0.5 s on the 32 MB boards' 24 MB /state (2026-11-10,
    the reTerminal Sticky: a one-scene put took 10 s, all of it lookups). The
    store knows its slot files and keeps an index copy (host-tested above);
    fos_scenes.c keeps up: the index goes only through the store (a bare
    unlink would leave the copy to come back), a wipe makes the store forget,
    and whether the combined payload is there is tracked, not stat'ed."""
    scenes = _source("fos_scenes.c")
    fns = _functions(scenes)
    assert "unlink(SCENES_INDEX_PATH)" not in scenes
    assert "fos_scene_store_forget()" in fns["fos_scenes_wipe_state"]
    assert "remove_slots_from" not in scenes and "fos_scene_store_remove_slots()" in fns["remove_slots"]
    assert "fos_scene_store_read_index()" in fns["load_scene_index"]
    for match in re.finditer(r"write_file_replace(?:_locked)?\(SCENES_PATH[^;]*;", scenes):
        assert scenes[match.end(): match.end() + 60].strip().startswith("if (err == ESP_OK) combined_set(true);")
    for match in re.finditer(r"unlink\(SCENES_PATH\);", scenes):
        assert scenes[match.end(): match.end() + 40].strip().startswith("combined_set(false);")
    # The apply on the render task and every change ask the tracker first.
    assert "if (s_patch_pending && !combined_stored()) return apply_index_change();" in fns["fos_scenes_apply_pending"]
    assert "combined_stored() ? read_file(SCENES_PATH, &len) : NULL" in fns["fos_scenes_apply_pending"]
    assert fns["ensure_split_locked"].index("!combined_stored()") < fns["ensure_split_locked"].index("stat(SCENES_PATH")
    store = _source("fos_scene_store.c")
    assert "remove(tmp);\n    if (s_hooks.make_room)" not in store, "a write removed its tmp first: one more lookup"
