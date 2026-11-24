from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

# JSON nested deeper than any FrameOS payload, on the ESP32.
#
# cJSON recurses once per nested array or object and stops at
# CJSON_NESTING_LIMIT, 1000 as it ships; the tasks that parse run on 8 to 10 KB
# stacks, and about a hundred levels were enough to reset the board. A scan in
# front of a parse (fos_json_depth_ok) was the guard, and about ten parses had
# none. Now cJSON itself is built with the firmware's limit, for every parse in
# the image, and the doors that hand JSON on to the runtime (whose reader
# recurses too) check it themselves: a scene the runtime takes whole, and an
# event's payload.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"


def _limit() -> int:
    match = re.search(r"#define FOS_JSON_MAX_DEPTH (\d+)", (MAIN_DIR / "fos_json_guard.h").read_text())
    assert match
    return int(match.group(1))


def cjson_dir() -> Path | None:
    idf_path = os.environ.get("IDF_PATH")
    for candidate in (Path(idf_path) if idf_path else None, Path.home() / "esp" / "esp-idf"):
        if candidate and (candidate / "components" / "json" / "cJSON" / "cJSON.c").is_file():
            return candidate / "components" / "json" / "cJSON"
    return None


def test_cjson_is_built_with_the_firmwares_limit():
    cmake = (ESP32_DIR / "CMakeLists.txt").read_text()
    # For the whole build (IDF's json component included), not one target.
    assert f'idf_build_set_property(COMPILE_DEFINITIONS "CJSON_NESTING_LIMIT={_limit()}" APPEND)' in cmake


def test_the_build_stops_if_the_two_numbers_part():
    guard = (MAIN_DIR / "fos_json_guard.c").read_text()
    assert "#ifndef CJSON_NESTING_LIMIT" in guard and "#error" in guard
    assert "_Static_assert(CJSON_NESTING_LIMIT == FOS_JSON_MAX_DEPTH" in guard


def test_the_runtime_takes_no_scene_the_store_would_refuse():
    scenes = (MAIN_DIR / "fos_scenes.c").read_text()
    start = scenes.index("static bool load_into_nim(")
    body = scenes[start:scenes.index("\n}\n", start)]
    guard = body.index("fos_json_depth_ok(scenes[i], lens[i], FOS_JSON_MAX_DEPTH)")
    assert guard < body.index("frameos_nim_load_scenes("), "checked before the runtime reads them"
    # Nothing else hands the runtime a set.
    assert scenes.count("frameos_nim_load_scenes(") == 1
    # And a payload is refused before it is stored for a later apply.
    start = scenes.index("esp_err_t fos_scenes_set_json_from(")
    body = scenes[start:scenes.index("\n}\n", start)]
    assert body.index("fos_json_depth_ok(json, len, FOS_JSON_MAX_DEPTH + 2)") < body.index("mount_state()")


def test_an_event_payload_is_checked_at_the_one_dispatcher():
    events = (MAIN_DIR / "fos_events.c").read_text()
    start = events.rindex("static fos_event_result_t dispatch_event(")  # the definition, after its prototype
    body = events[start:events.index("\n}\n", start)]
    guard = body.index("fos_json_depth_ok(payload, strlen(payload), FOS_JSON_MAX_DEPTH)")
    for later in ("dispatch_remote(", "set_current_scene(", "run_runtime_command(", "defer_event(", "frameos_nim_send_event("):
        assert guard < body.index(later), later


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.skipif(cjson_dir() is None, reason="no ESP-IDF checkout (IDF_PATH) for cJSON")
def test_cjson_honours_the_limit_it_is_built_with(tmp_path: Path):
    """The premise of all of the above, against the cJSON the firmware links."""
    cjson = cjson_dir()
    assert cjson is not None
    limit = _limit()
    source = tmp_path / "probe.c"
    source.write_text(
        """
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
static int parses(int depth)
{
    char text[4096];
    memset(text, '[', (size_t)depth);
    memset(text + depth, ']', (size_t)depth);
    text[2 * depth] = 0;
    cJSON *tree = cJSON_Parse(text);
    int ok = tree != NULL;
    cJSON_Delete(tree);
    return ok;
}
int main(void)
{
    printf("%d %d %d\\n", parses(LIMIT), parses(LIMIT + 1), parses(1000));
    return 0;
}
"""
    )
    binary = tmp_path / "probe"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-O2", "-w", f"-DCJSON_NESTING_LIMIT={limit}", f"-DLIMIT={limit}", "-I", str(cjson),
         str(cjson / "cJSON.c"), str(source), "-lm", "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    assert result.stdout.split() == ["1", "0", "0"], result.stdout
