from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_animation.c.
#
# Same arrangement as test_esp32_power.py next door: host tests that nothing
# invokes are host tests that do not exist.
#
# fos_animation.c is the render task's animation mode — a scene below a
# one-second interval on an LCD: when it starts, the per-second housekeeping,
# which frames log in full, when the next frame is due. Pure arithmetic; the
# clock, the render and the logs live in fos_client.c.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
ANIMATION_SOURCE = MAIN_DIR / "fos_animation.c"
ANIMATION_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_animation.c"


def test_sources_exist():
    assert ANIMATION_SOURCE.is_file(), f"missing {ANIMATION_SOURCE}"
    assert ANIMATION_TEST_SOURCE.is_file(), f"missing {ANIMATION_TEST_SOURCE}"


def test_animation_helper_is_pure():
    """The point of the split: fos_animation.c must stay buildable without the IDF."""
    source = ANIMATION_SOURCE.read_text()
    assert "#include" in source
    assert "esp_" not in source, "fos_animation.c must not pull in IDF headers or calls"
    assert "freertos" not in source


def test_the_pass_loop_reads_the_scene_interval_through_the_tested_rules():
    """A layout's 1 s wait arrives as 0.9999 s. Read raw, `>= 1.0` called it
    no opinion and the frame's 300 s took over: a reTerminal Sticky's clock
    stood still for five minutes now and then (2026-11-10). Every reader of
    the scene's interval in fos_client.c gets the snapped value."""
    client = (MAIN_DIR / "fos_client.c").read_text()
    reads = re.findall(r"[^\n]*frameos_nim_scene_interval\(\)[^\n]*", client)
    assert reads, "fos_client.c no longer reads the scene interval"
    for line in reads:
        assert "fos_scene_interval_snap(frameos_nim_scene_interval())" in line, (
            "fos_client.c reads the scene interval raw: " + line.strip()
        )
    assert "fos_pass_interval_seconds(scene_interval)" in client
    assert "scene_interval >= 1.0" not in client


def test_a_checkin_pass_sleeps_until_the_render_that_was_scheduled():
    """A deep-sleeping frame that wakes for commands (wake_check_seconds, 900 s
    on three reTerminal presets) skips its render and went back to sleep for
    the shorter of "until the scheduled render" and "this pass's interval".
    A pass that renders nothing builds no scene, so that interval is the
    frame's own or the scene's declared one, not the one the render was
    scheduled by. On a reTerminal E1002 (2026-11-18) a scene set to one day
    announced `nextRenderAt` 86,394 s on, and its first check-in rewrote that
    to 298 s on; with the scheduled render kept, five check-ins in a row left
    the date alone. Only a cell too low to render keeps its own long sleep."""
    client = (MAIN_DIR / "fos_client.c").read_text()
    checkin = client[client.index("        if (checkin_pass) {\n            /* This pass skipped the render"):]
    checkin = checkin[: checkin.index("s_next_render_due = time(NULL) + (time_t)sleep_s;")]
    assert "int64_t until_due = (int64_t)(s_next_render_due - time(NULL));" in checkin
    assert "if (!battery_critical || (uint64_t)until_due < sleep_s) sleep_s = (uint32_t)until_due;" in checkin
    assert "\n            if ((uint64_t)until_due < sleep_s) sleep_s" not in client, "the shorter of the two moved the render up"


def test_the_scheduled_render_is_kept_without_a_set_clock():
    """A frame whose network answers no SNTP never has a wall clock. Its due
    date was stored as 0 ("clock_ok ? ... : 0"), so no wake was ever a
    check-in pass and each one rendered: a reTerminal E1004 set to one day,
    woken every 900 s by its preset's wake check, drew a new photo every 15
    minutes, and its sleep line said `nextRenderAt=0` (a user's log,
    2026-11-18). The date and "now" come off the same counter, which runs
    through a deep sleep set or not; only what a plane is told needs a real
    clock. On an E1002 with a test image whose clock says "never set", six
    check-in wakes in a row skipped the render."""
    client = (MAIN_DIR / "fos_client.c").read_text()
    assert "clock_ok" not in client, "the render schedule depends on a set clock again"
    decision = client[client.index("bool checkin_pass = deep_sleep_now && !force_render &&"):]
    decision = decision[: decision.index(";")]
    assert "fos_wifi_time_synced" not in decision
    assert "s_next_render_due > wall_now + FOS_SLEEP_EARLY_WAKE_SEC" in decision
    # The date a plane shows is a real one or none.
    assert "fos_wifi_time_synced() && s_next_render_due > 1000000000 ? s_next_render_due : 0" in client
    assert client.count("announced_due") == 3
    # A boot that is not a wake from deep sleep still starts without a date.
    assert re.search(r"esp_reset_reason\(\) != ESP_RST_DEEPSLEEP\) \{\s*s_next_render_due = 0;", client)


def test_the_workspace_knows_what_a_preset_sleeps_by():
    """The console's `preset` turns deep sleep on battery and a wake check on
    for three reTerminals, on the device alone. The cloud keeps only what its
    owner set, so its Power panel said "Only wake to render" over a frame
    that woke every 15 minutes (2026-11-18). The panel reads the defaults off
    the preset the device names in its hello (utils/presetSleep.ts), which
    costs the firmware nothing and is right for frames already out there: so
    that list is the firmware's."""
    console = (MAIN_DIR / "fos_console.c").read_text()
    presets = console[console.index("} presets[] = {"):]
    presets = presets[: presets.index("};")]
    firmware = {}
    for name, body in re.findall(r'\{ "([a-z0-9_]+)",(.*?)\},', presets, re.S):
        numbers = re.findall(r"(\d+), (\d+) $", body.strip() + " ")
        if numbers and numbers[-1][0] == "1":
            firmware[name] = int(numbers[-1][1])
    assert firmware, "no preset turns deep sleep on battery on any more: is the table still read right?"
    spa = (REPO_ROOT / "frontend" / "src" / "utils" / "presetSleep.ts").read_text()
    listed = {name: int(seconds) for name, seconds in re.findall(r"^  ([a-z0-9_]+): (\d+),$", spa, re.M)}
    assert listed == firmware


def test_an_animation_goes_to_the_backend_once():
    """Both places a frame's picture is handed to the backend ask
    fos_animation_push_wanted first, and a push that reached the backend
    records its scene: while the SenseCAP's DVD logo ran, a push every 10 s
    held frames to 115 ms."""
    client = (MAIN_DIR / "fos_client.c").read_text()
    publishes = [m.start() for m in re.finditer(r"link_publish_picture\(scene_id\);", client)]
    assert len(publishes) == 2, "a new place publishes a picture: ask picture_push_wanted there too"
    for at in publishes:
        window = client[max(0, at - 400) : at]
        assert "picture_push_wanted(scene_id)" in window, "a picture is published without picture_push_wanted"
    assert "fos_animation_push_wanted(" in client
    assert "__atomic_store_n(&s_pushed_scene_key, scene_key(scene_id)" in client


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_animation_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_animation"
    compile_result = subprocess.run(
        [
            "cc",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-I",
            str(MAIN_DIR),
            str(ANIMATION_SOURCE),
            str(ANIMATION_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "animation host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "animation host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    assert int(summary.group(1)) >= 40
    assert int(summary.group(2)) == 0
