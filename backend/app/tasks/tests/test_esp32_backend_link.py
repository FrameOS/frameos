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


def _functions(text: str) -> dict[str, str]:
    """Every C function definition in `text`, by name, with its body."""
    bodies: dict[str, str] = {}
    for match in re.finditer(r"^[a-z][^;{}\n]*\b(\w+)\(([^;{}]*)\)\s*\{", text, re.MULTILINE):
        depth = 0
        for index in range(match.end() - 1, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
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
    body = CLIENT["link_round"]
    for applies in ("fos_scenes_sync(", "fos_settings_sync(", "fos_commands_run(", "fos_commands_sync(",
                    "fos_scenes_apply_pending_selection(", "frameos_nim_render"):
        assert applies not in body, f"fos_client.c: the backend link task calls {applies}"
    for fetches in ("fos_scenes_backend_changed()", "fos_settings_changed()", "fos_commands_fetch()",
                    "push_image_state(", "frameos_nim_flush_logs()"):
        assert fetches in body, f"fos_client.c: the backend link task no longer does {fetches}"
    # Starts nothing unless the render task left the round trips to it.
    first_statement = body.strip("{} \n").split(";")[0]
    assert "!s_link_on" in first_statement, "link_round must check s_link_on before anything else"


def test_one_commands_answer_at_a_time_and_it_always_runs():
    """The backend marks every command it hands out `sent`: a pull is never
    only a look. So the link task pulls only into an empty mailbox, and the
    render task runs an answer it finds whatever the mode."""
    body = CLIENT["link_round"]
    fetch = body.index("fos_commands_fetch()")
    assert "slot_free" in body[:fetch] and "s_link_answer == NULL" in body, (
        "fos_client.c: the link task pulls commands over an answer that has not run"
    )
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
