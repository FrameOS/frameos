from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_voice_chord.c.
#
# Same arrangement as test_esp32_button_timing.py next door: host tests that
# nothing invokes are host tests that do not exist.
#
# fos_voice_chord.c is the LEFT+RIGHT chord that starts a voice chat session
# (docs/voice-chat.md): both keys held FOS_VOICE_CHORD_HOLD_MS start one,
# either key let go ends it, nothing starts again until both are up. Pure
# arithmetic: the GPIO and the microphone live in fos_buttons.c and
# fos_voice.c, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
CHORD_SOURCE = MAIN_DIR / "fos_voice_chord.c"
CHORD_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_voice_chord.c"


def test_sources_exist():
    assert CHORD_SOURCE.is_file(), f"missing {CHORD_SOURCE}"
    assert CHORD_TEST_SOURCE.is_file(), f"missing {CHORD_TEST_SOURCE}"


def test_chord_helper_is_pure():
    source = CHORD_SOURCE.read_text()
    assert "esp_" not in source, "fos_voice_chord.c must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_voice_chord_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_voice_chord"
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
            str(CHORD_SOURCE),
            str(CHORD_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "voice chord host tests do not compile:\n" + compile_result.stderr

    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, "voice chord host tests failed:\n" + run_result.stdout[-4000:]

    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    assert int(summary.group(1)) >= 20
    assert int(summary.group(2)) == 0
