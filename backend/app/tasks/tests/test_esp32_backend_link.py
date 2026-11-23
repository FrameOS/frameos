from __future__ import annotations

import re
from pathlib import Path

# Source invariants for the ESP32's round trips to a self-hosted backend.
#
# A one-second clock on a reTerminal Sticky stood still for up to ten seconds
# at a time (2026-11-10): between two renders the render task spent 2-8 s on
# its backend, a 1-4 s picture push, two log uploads and the scenes, settings
# and commands pulls. A frame that stays awake now does them on a task of its
# own (main/fos_client.c backend_link_task), and the render task applies what
# it found. The rules a regression would break are threading rules, which a
# host test cannot run, so they are read off the source here; the pure
# decisions (when the link is on, when a push gives way, who the input hold
# is for) are host-tested in main/tests/test_fos_animation.c.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
CLIENT_C = ESP32_DIR / "main" / "fos_client.c"
HTTP_C = ESP32_DIR / "main" / "fos_http.c"
COMMANDS_C = ESP32_DIR / "main" / "fos_commands.c"
GLUE_C = ESP32_DIR / "components" / "frameos_nim" / "frameos_nim_glue.c"


def _blank_literals(text: str) -> str:
    """`text` with what is inside its string and character literals blanked,
    same length: a `'{'` must not count as a brace."""
    return re.sub(r"\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])'",
                  lambda m: m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[-1], text)


def _functions(text: str) -> dict[str, str]:
    """Every C function definition in `text`, by name, with its body."""
    bodies: dict[str, str] = {}
    masked = _blank_literals(text)
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


def _strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", source)


CLIENT = _functions(_strip_comments(CLIENT_C.read_text()))


def test_the_link_task_only_fetches():
    """It pulls and pushes; applying stays on the render task, where every
    Nim call and scene load runs. A scenes or settings sync, or running the
    commands, on the link task would load scenes beside a render."""
    body = CLIENT["link_round"] + CLIENT["link_pull_commands"]
    for applies in ("fos_scenes_sync(", "fos_settings_sync(", "fos_settings_apply(", "fos_commands_run(",
                    "fos_commands_sync(", "fos_scenes_apply_pending_selection(", "frameos_nim_render"):
        assert applies not in body, f"fos_client.c: the backend link task calls {applies}"
    for fetches in ("fos_scenes_backend_fetch(", "fos_settings_fetch(false)", "fos_commands_fetch(",
                    "push_image_state(", "frameos_nim_flush_logs()"):
        assert fetches in body, f"fos_client.c: the backend link task no longer does {fetches}"
    # Starts nothing unless the render task left the round trips to it.
    first_statement = body.strip("{} \n").split(";")[0]
    assert "!s_link_on" in first_statement, "link_round must check s_link_on before anything else"


def test_one_commands_answer_at_a_time_and_it_always_runs():
    """The backend marks every command it hands out `sent`: a pull is never
    only a look. So the link task pulls only into an empty mailbox, and the
    render task runs an answer it finds whatever the mode."""
    body = CLIENT["link_pull_commands"]
    fetch = body.index("fos_commands_fetch(reporting)")
    assert "if (!slot_free) return false;" in body[:fetch] and "s_link_answer == NULL" in body, (
        "fos_client.c: the link task pulls commands over an answer that has not run"
    )
    assert "fos_commands_fetch(" not in CLIENT["link_round"], "link_round pulls commands around the mailbox"
    sync = CLIENT["pass_commands_sync"]
    take = sync.index("link_take_answer()")
    assert take < sync.index("s_link_on"), "pass_commands_sync must run a pulled answer before asking the mode"
    assert "fos_commands_run(answer)" in sync


def test_taking_the_round_trips_back_waits_for_the_one_running():
    """When a frame is about to deep-sleep the round trips come back to the
    render task. A pull the link task was in the middle of would otherwise
    leave its commands in memory as the chip sleeps."""
    task = CLIENT["backend_link_task"]
    take, call, give = (task.index(s) for s in ("xSemaphoreTake(s_link_round", "link_round(", "xSemaphoreGive(s_link_round"))
    assert take < call < give, "fos_client.c: a link round runs outside s_link_round"
    hand_back = CLIENT["link_hand_back"]
    assert hand_back.index("xSemaphoreTake(s_link_round") < hand_back.index("pass_commands_sync()")
    client = _strip_comments(CLIENT_C.read_text())
    assert re.search(r"s_link_on = fos_backend_link_on\(", client), "s_link_on is no longer the tested rule"
    assert re.search(r"if \(link_was_on && !s_link_on\) link_hand_back\(config\);", client), (
        "fos_client.c: turning the link off no longer hands the round trips back"
    )


def test_what_changed_waits_while_someone_is_at_the_frame():
    """The render task applies a change of scenes or settings the link task
    fetched. While someone taps that waits for them to stop: an apply (or,
    before, a fetch) there held their next tap. The commands are already
    pulled and run at once."""
    serve = CLIENT["serve_link"]
    hold = serve.index("if (!input_hold_on()) {")
    guarded = serve[hold : serve.index("}", hold)]
    assert "pass_scenes_sync();" in guarded and "pass_settings_sync();" in guarded, (
        "fos_client.c: serve_link fetches scenes or settings while the input hold is on"
    )
    assert serve.index("pass_commands_sync()") > serve.index("}", hold)
    assert "serve_link(config)" in CLIENT["run_held_network"], "the hold's release no longer serves the link"


SCENES_C = ESP32_DIR / "main" / "fos_scenes.c"


def test_a_scene_payload_is_written_off_the_render_task():
    """A backend sync held the render task for ~8 s on the E1003 (337 KB): the
    download, the write of the combined file, the parse. The link task
    downloads it, the render task only parses it, and the scene store's task
    writes it. What must hold: the etag on flash and the source are written
    only after the payload is (a crash may not claim a set that is not on
    flash), the runtime has the set before the write starts, and a deep sleep
    waits for the write."""
    scenes = _functions(_strip_comments(SCENES_C.read_text()))
    store = scenes["store_backend_payload"]
    write = store.index("fos_scene_store_write_set(SCENES_PATH")
    # Under the store lock like every other writer, paced on e-paper: the
    # store module calls the pace hook before each 2 KB, and it waits on every
    # task but the render task.
    assert store.index("store_lock()") < write < store.index("store_unlock()")
    assert ".pace = store_pace_hook" in _strip_comments(SCENES_C.read_text())
    hook = scenes["store_pace_hook"]
    assert "!fos_client_on_render_task()" in hook and "store_pace()" in hook
    pace = scenes["store_pace"]
    assert "fos_client_input_held()" in pace and "fos_client_render_in_flight()" in pace
    store_module = (ESP32_DIR / "main" / "fos_scene_store.c").read_text()
    assert "if (s_hooks.pace) s_hooks.pace();" in store_module
    for after in ("save_etag_file(", "persist_scene_source(", "fos_scene_store_remove_index()"):
        assert write < store.index(after), f"fos_scenes.c: {after} comes before the payload is on flash"
    take = scenes["take_backend_payload"]
    assert take.index("load_into_nim(") < take.index("store_behind("), "the write is queued before the parse"
    assert "etag_set(etag)" in take, "the next poll would fetch the payload being written again"
    assert "store_task_ready()" in scenes["store_behind"]
    assert "esp_register_shutdown_handler(store_shutdown)" in scenes["store_task_ready"]
    sync = scenes["fos_scenes_sync"]
    assert "fos_scenes_backend_fetch(" in sync and "fos_scenes_take_backend_payload(" in sync
    client = _strip_comments(CLIENT_C.read_text())
    sleep = client.index("esp_deep_sleep((uint64_t)")
    assert "fos_scenes_store_wait(" in client[sleep - 400 : sleep], "a deep sleep does not wait for the scene store"
    assert "fos_client_take_link_payload()" in CLIENT["pass_scenes_sync"]
    assert "fos_scenes_take_backend_payload(" in CLIENT["fos_client_take_link_payload"]
    assert "pass_scenes_sync();" in CLIENT["link_hand_back"]


def test_one_scenes_fetch_at_a_time_and_a_fetched_set_is_named():
    """After a push the SenseCAP fetched the same 372 KB set two or three
    times (2026-11-15): a deploy's forced sync on the render task and the link
    task's poll both asked with the ETag of the set before, and the second
    body could not be read. One fetch runs at a time (a poll skips, a forced
    sync waits), a set fetched and not yet taken is what the next one names,
    and the deploy's sync takes the link task's set around its own."""
    scenes = _functions(_strip_comments(SCENES_C.read_text()))
    fetch = scenes["fos_scenes_backend_fetch"]
    take_lock = fetch.index("xSemaphoreTake(s_fetch_lock, force ?")
    assert take_lock < fetch.index("s_sync_requested"), "a skipped poll must not eat a sync request"
    assert take_lock < fetch.index("s_fetched_etag") < fetch.index("fos_http_fetch(")
    assert "fetched ||" in fetch, "a fetched set is named even by a forced sync"
    assert fetch.index("fetched_set(response.etag)") < fetch.index("xSemaphoreGive(s_fetch_lock)")
    assert fetch.count("return") == 2, "every way out of the fetch after the lock gives it back"
    # Cleared once the set is taken, on every way out: before it, a set read
    # into the store was asked for again while its index was switched.
    take = scenes["fos_scenes_take_backend_payload"]
    assert take.index("take_backend_payload(set, etag)") < take.index('fetched_set("")') < take.index("return err;")
    assert "fetched_set(" not in scenes["take_backend_payload"]
    commands = _functions(_strip_comments(COMMANDS_C.read_text()))["run_answer"]
    sync = commands.index("fos_scenes_sync(true)")
    assert commands.rfind("fos_client_take_link_payload()", 0, sync) != -1
    assert commands.find("fos_client_take_link_payload()", sync) != -1


def test_a_deploy_is_downloaded_with_the_pull_and_taken_before_the_commands():
    """A deploy's pull answer says `sync`, and its set must be in before its
    commands run: a switch queued behind a push names a scene from it (E1002,
    2026-10-24). The render task used to download it right there, before the
    commands: a 35-scene, 1.48 MB deploy froze a reTerminal Sticky's screen
    and dropped its taps for 42 s (2026-11-23). The link task now downloads it
    with the pull and hands the answer over with its set; the render task
    takes that set (after one the poll fetched before it) and only then runs
    the commands. Where each step runs is host-tested (fos_sync_plan)."""
    commands = _functions(_strip_comments(COMMANDS_C.read_text()))
    fetch = commands["fos_commands_fetch"]
    pulled = fetch.index("pull()")
    asked = fetch.index("fos_sync_fetch_with_pull(")
    assert pulled < asked < fetch.index("fos_scenes_backend_fetch(true,") < fetch.index("return answer;")
    assert "fos_settings_fetch(true)" in fetch
    for applies in ("fos_scenes_sync(", "fos_scenes_take_backend_payload(", "fos_scenes_apply_pending",
                    "fos_settings_sync(", "fos_settings_apply(", "run_command(", "run_answer("):
        assert applies not in fetch, f"fos_commands.c: the link task's fetch calls {applies}"
    run = commands["run_answer"]
    plan = run.index("fos_sync_plan(")
    taken = run.index("if (plan.take_fetched)")
    slot = run.index("fos_client_take_link_payload()", taken)
    own = run.index("fos_scenes_take_backend_payload(answer->scenes", taken)
    first_command = run.index("run_command(command)")
    assert plan < taken < slot < own < run.index("fos_scenes_apply_pending()", own) < first_command, (
        "fos_commands.c: the commands run before the set fetched with the pull is in"
    )
    assert taken < run.index("fos_settings_apply(answer->settings)") < first_command
    report = run.index("fos_client_request_report_pull()")
    assert first_command < report and first_command < run.index("sync_pass(true)"), (
        "the ETags of the set are reported before the commands ran"
    )
    # The link task polls no scenes or settings while such an answer waits or
    # runs: it would name the poll's set, not the answer's, and fetch it again.
    link = CLIENT["link_pull_commands"]
    assert "fos_commands_answer_fetched(answer)" in link and "s_link_sync_running = true" in link
    poll = CLIENT["link_round"]
    assert "s_link_payload == NULL && !s_link_sync_running" in poll
    assert "s_link_settings == NULL && !s_link_sync_running" in poll
    pass_commands = CLIENT["pass_commands_sync"]
    assert pass_commands.index("fos_commands_run(answer)") < pass_commands.index("s_link_sync_running = false")
    # The report is the link task's pull, with `reporting` set: never a third.
    assert "link_pull_commands(reporting)" in poll and "__atomic_exchange_n(&s_report_owed, false" in poll
    assert "s_report_owed" in CLIENT["link_hand_back"]
    assert "fos_client_link_on()" in run


def test_the_render_task_uses_the_tested_rules():
    """The rules host-tested in test_fos_animation.c are the ones that run."""
    assert "fos_input_hold_applies(" in CLIENT["hold_applies"]
    assert "hold_applies()" in CLIENT["deliver_deferred_events"], (
        "an event from HTTP, the cloud or the console no longer engages the input hold"
    )
    assert "fos_image_push_yields(" in CLIENT["image_push_write"]
    assert "fos_idle_wait_goes_on(" in _strip_comments(CLIENT_C.read_text())


def test_the_picture_stream_lets_go_of_the_snapshot():
    """The picture push streamed the snapshot with its lock held, and the
    render after it waited 1.3 to 4.3 s to take its buffer back. Small
    snapshots are copied out; a big one is held a row at a time, and a render
    that took the buffer back ends the stream."""
    stream = _functions(_strip_comments(HTTP_C.read_text()))["fos_http_preview_bmp_stream"]
    release = stream.index("fos_client_snapshot_release()")
    assert release < stream.index("sink->write(ctx, header"), (
        "fos_http.c: the snapshot is still held when the stream starts writing"
    )
    loop = stream[stream.index("for (int y = out_height - 1"):]
    assert "fos_client_snapshot_acquire(" in loop and "fos_client_snapshot_release()" in loop
    assert "fos_client_snapshot_render_count_locked() == taken" in loop, (
        "fos_http.c: a row is read without checking that no render took the buffer back"
    )
    assert loop.index("fos_client_snapshot_release()") < loop.index("sink->write(ctx, row"), (
        "fos_http.c: a row is written to the socket with the snapshot held"
    )


def test_commands_are_fetched_and_run_apart():
    commands = _functions(_strip_comments(COMMANDS_C.read_text()))
    assert "fos_commands_fetch" in commands and "fos_commands_run" in commands
    fetch = commands["fos_commands_fetch"]
    # An answer with nothing to run is not handed over (the mailbox would
    # hold an empty answer and block the next pull for a pass).
    assert "answer_has_work(" in fetch


def test_a_log_batch_keeps_up_with_a_one_second_clock():
    """A 1 s clock logs about eight lines a second and a backend on a laptop
    answers a POST in one to two seconds: with batches of eight, half the
    lines were dropped (2026-11-10)."""
    glue = GLUE_C.read_text()
    batch = int(re.search(r"#define FOS_NIM_LOG_BATCH_MAX (\d+)", glue).group(1))
    body = re.search(r"#define FOS_NIM_LOG_BODY_MAX \((\d+) \* 1024\)", glue)
    assert batch >= 32
    assert body is not None and int(body.group(1)) >= 64


def test_settings_are_fetched_on_the_link_task_and_applied_on_the_render_task():
    """A settings change the link task saw was fetched again, whole, on the
    render task (fos_settings_sync in serve_link): a backend that hung held
    renders and taps for the connect timeout. The link task fetches the body
    and hands it over like the scenes payload."""
    settings = _functions(_strip_comments((ESP32_DIR / "main" / "fos_settings.c").read_text()))
    sync = settings["fos_settings_sync"]
    assert "settings_fetch(" in sync and "fos_settings_apply(" in sync, "fos_settings_sync is not fetch + apply"
    fetch = settings["settings_fetch"]
    for applies in ("apply_service_settings(", "apply_frame_settings(", "frameos_nim_apply_service_settings(",
                    "fos_config_save(", "fos_schedule_set_json(", "s_etag_source = ", "strlcpy(s_etag,"):
        assert applies not in fetch, f"fos_settings.c: the fetch half (any task) calls {applies}"
    assert "fos_settings_changed" not in (ESP32_DIR / "main" / "fos_settings.h").read_text()
    pass_settings = CLIENT["pass_settings_sync"]
    assert pass_settings.index("fos_client_take_link_settings()") < pass_settings.index("s_link_on"), (
        "pass_settings_sync must apply what the link task fetched before asking the mode"
    )
    take = CLIENT["fos_client_take_link_settings"]
    assert take.index("s_link_settings = NULL") < take.index("fos_settings_apply(settings)")


def test_a_commands_nudge_is_the_link_tasks_pull_while_it_has_the_round_trips():
    """COMMANDS_BIT (the backend's nudge, a new address, a store action) ran
    fos_commands_sync on the render task even while the link task had the
    round trips: with a backend that hung that held renders and taps for the
    connect timeout. The voice relay alone still pulls on the render task,
    since its release expects the answer in the very next render."""
    client = _strip_comments(CLIENT_C.read_text())
    nudge = CLIENT["serve_commands_nudge"]
    assert "fos_commands_nudge_to_link(s_link_on, here)" in nudge
    assert nudge.index("xTaskNotify(s_link_task, LINK_NOTIFY_PULL") < nudge.index("fos_commands_sync()")
    # Every COMMANDS_BIT the render task serves goes through it.
    assert "(bits & COMMANDS_BIT) && serve_commands_nudge()" in CLIENT["animation_wait"]
    assert len(re.findall(r"fos_commands_sync\(\)", client)) == 3, (
        "fos_client.c: a new render-task commands pull (expected: pass_commands_sync, serve_commands_nudge, "
        "run_held_network)"
    )
    task = CLIENT["backend_link_task"]
    assert "LINK_NOTIFY_PULL" in task and "&pull_owed" in task
    voice = (ESP32_DIR / "main" / "fos_voice.c").read_text()
    assert "fos_client_request_commands_pull_here();" in voice, "the voice relay's pull left the render task"
