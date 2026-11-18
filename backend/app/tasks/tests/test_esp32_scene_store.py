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
# What the index keeps of a scene written as it arrives (fos_scene_meta.c).
META_SOURCE = MAIN_DIR / "fos_scene_meta.c"
META_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_scene_meta.c"
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_scene_store.c"
SAMPLES_DIR = REPO_ROOT / "repo" / "scenes" / "samples"


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
    for path in (SOURCE, META_SOURCE):
        source = path.read_text()
        assert "esp_" not in source, f"{path.name} must not pull in IDF headers or calls"
        assert "freertos" not in source


def test_the_workflow_builds_it():
    workflow = (REPO_ROOT / ".github" / "workflows" / "e2e-docker.yml").read_text()
    assert "tests/test_fos_scene_store.c" in workflow
    assert "tests/test_fos_scene_meta.c" in workflow


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
            str(cjson / "cJSON.c"), str(GUARD_SOURCE), str(META_SOURCE), str(SOURCE), str(TEST_SOURCE),
            "-lm", "-o", str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(cjson_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for cJSON")
def test_what_the_index_keeps_is_read_off_every_sample_scene(tmp_path: Path):
    """A scene written to flash as it arrives is never parsed whole: what the
    index keeps of it (its id, its name, whether it is a layout, its icon) is
    read off its bytes as they go by. Every repo sample, compact and spread
    out, reads the same that way as from its whole tree."""
    cjson = cjson_dir()
    assert cjson is not None
    binary = tmp_path / "test_fos_scene_meta"
    compile_result = subprocess.run(
        [
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
            "-I", str(MAIN_DIR), "-I", str(cjson),
            str(cjson / "cJSON.c"), str(META_SOURCE), str(META_TEST_SOURCE),
            "-lm", "-o", str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    samples = sorted(str(path) for path in SAMPLES_DIR.glob("*/scenes.json"))
    assert len(samples) > 50
    result = subprocess.run([str(binary), *samples], capture_output=True, text=True, timeout=120)
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


LOAD_BACKEND_SET = 'whole = load_into_nim((const char *const *)set->scenes, set->lens, set->count, len, "backend");'


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
    helper = fns["store_puts_as_changes_locked"]
    assert helper.index("if (combined_stored() || count <= 0) return ESP_ERR_NOT_FOUND;") < helper.index(
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
        "store_puts_as_changes_locked(puts, set->count, set->bytes, FOS_SCENES_SOURCE_BACKEND)",
        "if (err == ESP_ERR_NOT_FOUND)", "fos_scene_store_write_set(SCENES_PATH")]
    assert order == sorted(order), "store_backend_payload: as changes, else whole"
    # The index it wrote is the new set's; and a set written store-first was
    # split from its scenes, so the index is the new set's then too.
    assert "if (!as_changes && !split && !job->reload) fos_scene_store_remove_index();" in backend, (
        "the index it wrote is the new set's"
    )
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
    fns = _functions(_source("fos_scenes.c"))
    take = fns["fos_scenes_take_backend_payload"]
    assert take.index(LOAD_BACKEND_SET) < take.index(
        "fos_client_render_now();") < take.index("store_behind(set, etag, !whole)")
    # A set the runtime has no room for whole (or refuses) goes store-first:
    # the store task marks it pending inside the lock, then asks for the
    # render, which applies it one scene at a time.
    assert take.index("runtime_room_for_whole(len)") < take.index("load_into_nim(")
    backend = fns["store_backend_payload"]
    order = [backend.index(s) for s in (
        "s_pending = true", "s_payload_stored_since_boot = true", "store_unlock()", "fos_client_render_now()")]
    assert order == sorted(order), "store-first: pending inside the lock, then a render"



def test_a_set_the_runtime_refuses_is_loaded_from_flash_after_its_write():
    """A whole set taken from the backend that the runtime refused (out of
    memory) was still written to flash, and the runtime ran the set before
    against a store holding the new one: every scene start read flash for the
    old set's layout and logged `layout:missing` until the next push (the
    reTerminal E1004, the hardware bench, 2026-11-16). The write now leaves an
    apply pending, which loads what flash holds one scene at a time."""
    functions = _functions(_source("fos_scenes.c"))
    take = functions["fos_scenes_take_backend_payload"]
    assert LOAD_BACKEND_SET in take
    assert ".reload = !whole" in take
    # A refused set dropped for a newer one leaves its reload to that one.
    assert "s_store_next.reload = reload || (dropped != NULL && s_store_next.reload);" in functions["store_behind"]
    store = functions["store_backend_payload"]
    pending = store.index("s_pending = true;")
    assert store.index("store_puts_as_changes_locked(") < pending < store.index("store_unlock();")
    assert "bool reload = job->reload;" in store, "whether the write worked or not: flash is what runs"

def test_no_apply_while_a_store_first_set_is_written():
    """A patch's apply that ran while a store-first set was being written
    could not load the resident scene (load_scene_slot waits for the write),
    took that for a refusal and pointed the scene back at its previous file:
    the E1004 kept a scene four pushes old, wearing a layout no longer on
    flash (the hardware bench, 2026-11-16). The apply waits for the write."""
    fns = _functions(_source("fos_scenes.c"))
    apply = fns["fos_scenes_apply_pending"]
    assert apply.index("if (s_store_changing) return false;") < apply.index("apply_index_change()")
    assert "if (!ok && !s_store_changing && before_slot >= 0" in fns["apply_index_change"]


def test_a_backend_set_is_read_in_pieces_and_its_patch_without_a_tree():
    """The desktop layouts' sets (365-465 KB) never reached two 8 MB boards
    (the hardware bench, 2026-11-16): a declared length was read and then
    grown to the 512 KB cap for an end it did not need (`read-failed`, HTTP
    200, 0 bytes, with a 480 KB largest block), a patch of fifteen scenes was
    parsed as one cJSON tree and refused out of memory, and then one block of
    the answer's size did not fit beside a photo on the E1004 (`no-memory`,
    1.5 MB free in 300 KB blocks). A backend's scenes are read each into a
    block of its own (fos_scene_pieces.c, host-tested in
    test_fos_scene_pieces.c), and only the patch without them is a tree."""
    http = _functions(_source("fos_backend_http.c"))
    assert "fos_scene_pieces_read(res->content_length" in http["read_body"]
    assert "fos_http_body_read(res->content_length" in http["read_body"]
    fns = _functions(_source("fos_scenes.c"))
    assert ".scene_set = pieces," in fns["fos_scenes_backend_fetch"]
    patch = fns["apply_backend_patch"]
    assert "cJSON_ParseWithLength(set->rest, set->rest_len)" in patch
    assert "change.puts = set_puts(set, puts)" in patch


def test_a_set_over_what_memory_holds_is_read_straight_into_the_store():
    """A set was 512 KB and 32 scenes whatever the partition: a reTerminal
    Sticky refused 529 KB with 14 MB of its 24 MB /state free
    (`payload-too-large`), and a reTerminal E1004 had no block for one scene
    of a 465 KB set (`no-memory`; the hardware bench, 2026-11-18). An answer
    over what is held in memory, or one there was no block for, goes to a
    sink that writes each scene to a slot file no index names
    (fos_scene_store_stage_*, host-tested), and the render task switches the
    index to them in one change."""
    http = _functions(_source("fos_backend_http.c"))
    read = http["read_body"]
    assert "fos_scene_pieces_read_to(res->content_length, max_body, &io, req->scene_sink, req->scene_set)" in read
    assert "req->scene_held_max == 0 || res->content_length > (int64_t)req->scene_held_max" in read
    assert "res->spooled = true;" in read
    # An answer the store refused is told by its ETag before its body is read.
    fetch_http = http["fos_http_fetch"]
    assert fetch_http.index("res->skipped = true;") < fetch_http.index("read_body(client, max_body, req, res);")

    scenes = _source("fos_scenes.c")
    fns = _functions(scenes)
    fetch = fns["fos_scenes_backend_fetch"]
    assert ".scene_sink = how == READ_HELD ? NULL : &sink," in fetch
    assert ".scene_held_max = how == READ_EITHER ? SCENES_HELD_MAX_BYTES : 0," in fetch
    # No block for a scene held in memory: once more, into the store.
    assert "how = READ_TO_STORE;" in fetch and "how = READ_HELD;" in fetch
    # What the store took of an answer that then failed goes back, and a set
    # it could not take is not read again.
    assert fetch.index("fos_scene_store_stage_drop(spool.id);") < fetch.index("refused_set(response.etag, spool.err")
    assert "if (response.spooled) set->staged = spool.id;" in fetch
    assert "if (force) refused_set" not in fetch, "a backend asks for a sync with every commands answer"

    # The sink: the lock for each call, never across them, and the store
    # task's own staging first.
    begin = fns["spool_begin"]
    assert begin.index("fos_scenes_store_wait(SPOOL_STORE_WAIT_MS)") < begin.index("store_lock()")
    # Waited for by the render task, the store task's pace does not wait for
    # an input hold that task alone releases.
    assert begin.index("s_render_waits_for_store = true") < begin.index("fos_scenes_store_wait(") < begin.index(
        "s_render_waits_for_store = false")
    assert begin.index("fos_scene_store_stage_open()") < begin.index("fos_scene_store_stage_begin(spool->id)")
    for name, call in (("spool_begin", "fos_scene_store_stage_begin("), ("spool_bytes", "fos_scene_store_stage_write("),
                       ("spool_end", "fos_scene_store_stage_end(")):
        body = fns[name]
        assert body.index("store_lock()") < body.index(call) < body.rindex("store_unlock()"), name
    # A staging that is gone is another set stored meanwhile, not a bad scene.
    assert "!fos_scene_store_staging(spool->id)) spool->busy = true;" in fns["spool_answer"]

    # Committed on the render task as one change; a set never committed gives
    # its files back.
    take = fns["fos_scenes_take_backend_payload"]
    assert "fos_scene_store_change_t change = {.staged = set->staged};" in take
    assert take.index("if (set->staged != 0)") < take.index("runtime_room_for_whole(len)")
    assert "fos_scene_store_change_t change = {.order = order, .staged = set->staged};" in fns["apply_backend_patch"]
    free_set = fns["scene_set_free"]
    assert free_set.index("store_lock()") < free_set.index("fos_scene_store_stage_drop(set->staged)")
    # More than one file may be never becomes a combined file.
    store = fns["store_backend_payload"]
    assert store.index("set->bytes > FOS_SCENE_STORE_MAX_BYTES") < store.index("fos_scene_store_write_set(SCENES_PATH")
    assert "(512 * 1024)" in scenes and "SCENES_MAX_BYTES" not in scenes.replace("FOS_SCENE_STORE_MAX_BYTES", "")


def test_a_set_taken_whole_is_the_list_not_the_catalog_from_before():
    """A backend set taken whole into the runtime (fos_scenes_take_backend_payload,
    load_into_nim) replaces the scenes the runtime holds, but the catalog it
    read off flash for the set before stayed: the scene list, the switcher's
    tiles and next / previous read the catalog first, so a reTerminal E1002
    given 4 scenes in place of 17 said "4 loaded, 16 available" and listed
    scenes it no longer had until its next boot (2026-11-18)."""
    runtime = (REPO_ROOT / "frameos" / "src" / "embedded" / "embedded_runtime.nim").read_text()
    whole = runtime[runtime.index("proc loadSceneInputs(inputs: seq[FrameSceneInput]): int ="):]
    whole = whole[: whole.index("\nproc ", 10)]
    order = [whole.index(s) for s in (
        "replaceInterpretedScenesCache(newScenes)", "sceneCatalog.setLen(0)", "catalogRefresh.setLen(0)")]
    assert order == sorted(order)
    # The readers that take the catalog first.
    assert runtime.count("if sceneCatalog.len == 0:") >= 2 and "if sceneCatalog.len > 0:" in runtime


def test_old_scene_files_are_emptied_off_the_render_task():
    """Emptying a file is a flash write for each of its pages. The files a
    change stops naming were emptied by the render task's apply, before its
    render (25 scenes replaced: seconds), and 71 dropped scenes held the
    store's lock a minute and a half on the store task (the reTerminal
    Sticky, 2026-11-18). The store task empties them, and lets the lock go
    after each."""
    fns = _functions(_source("fos_scenes.c"))
    apply = fns["apply_index_change"]
    assert "if (!store_sweep_behind()) fos_scene_store_sweep();" in apply
    assert apply.index("if (!s_patch_pending) {") < apply.index("store_sweep_behind()")
    sweep = fns["store_sweep"]
    order = [sweep.index(s) for s in (
        "store_lock()", "if (!s_patch_pending && !s_store_changing)", "fos_scene_store_sweep()", "store_unlock()")]
    assert order == sorted(order), "the sweep waits for the apply of a change made since"
    assert "store_sweep();" in fns["store_task"]
    # The boot's sweep holds the lock the store's `between` lets go.
    init = fns["fos_scenes_init"]
    assert init.index("store_lock();") < init.index("fos_scene_store_sweep();") < init.index("store_unlock();")
    store = _functions(_source("fos_scene_store.c"))
    assert "if (s_hooks.between) s_hooks.between();" in store["fos_scene_store_sweep"]
    assert store["apply_and_retire"].count("if (s_hooks.between) s_hooks.between();") == 2
    # One listing, never a lookup a slot.
    assert "opendir(s_dir)" in store["learn_slot_files"]


def test_room_on_state_is_made_in_one_walk():
    """SPIFFS_gc_quick starts at block 0 for every block it erases: 48 of the
    71 s a 529 KB set took to store on a 24 MB /state (the reTerminal Sticky,
    2026-11-18). fos_spiffs_gc.c walks the partition once, from where the last
    walk stopped (host-tested: test_fos_spiffs_gc.c)."""
    source = _source("fos_spiffs_gc.c")
    assert "SPIFFS_gc_quick(" not in source
    fns = _functions(source)
    walk = fns["erase_deleted_blocks"]
    assert "s_walk_block = (spiffs_block_ix)((s_walk_block + 1) % fs->block_count);" in walk
    assert walk.index("SPIFFS_LOCK(fs)") < walk.index("erase_deleted_block(fs, bix)") < walk.index("SPIFFS_UNLOCK(fs)")
    assert "erase_deleted_blocks(fs, size)" in fns["__wrap_SPIFFS_gc"]


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
    assert 'apply_store_change(&change, FOS_SCENES_SOURCE_BACKEND, etag, "scenes:patch", false, &result)' in scenes


def test_a_forced_backend_sync_still_asks_for_a_patch():
    """A deploy, "Push & activate" or a preview forces the pull; it used to
    leave its ETag off, so the backend answered the whole list every time
    (download, whole-set parse, combined-file write). Now it says what it
    holds, and the backend answers 304 or the scenes that changed, unless
    the frame holds no set at all."""
    fetch = _functions(_source("fos_scenes.c"))["fos_scenes_backend_fetch"]
    assert "bool holds_set = s_slot_count > 0 || s_loaded > 0;" in fetch
    # A set fetched and not taken yet is named whatever the rest says (one
    # fetch at a time: test_esp32_backend_link.py).
    assert 'held = (fetched || (etag[0] && strcmp(etag, "local") != 0 && (!force || holds_set))) ? etag : NULL' in fetch
    assert ".if_none_match = held," in fetch
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
