from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_tone.c: a scene's tone as text
# (fos_tone.c, docs/tones.md), the notes of frameos.tone() as the runtime
# writes them and X-FrameOS-Tone as a plane sends them, read with the
# runtime's bounds. Pure C: a laptop compiler is all it needs, like
# test_esp32_motion.py next door.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN_DIR = REPO_ROOT / "embedded" / "esp32" / "main"
SOURCES = [MAIN_DIR / "fos_tone.c"]
TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_tone.c"


def test_tone_is_pure():
    """No IDF: text in, notes out."""
    text = (MAIN_DIR / "fos_tone.c").read_text()
    assert "ESP_PLATFORM" not in text
    assert "esp_" not in text
    assert "freertos" not in text


def test_the_bounds_are_the_runtimes():
    """tones.nim and fos_tone.h hold a tone to the same numbers."""
    nim = (REPO_ROOT / "frameos" / "src" / "frameos" / "tones.nim").read_text()
    header = (MAIN_DIR / "fos_tone.h").read_text()

    def nim_const(name: str) -> int:
        match = re.search(rf"^\s*{name}\*\s*=\s*([0-9_]+)", nim, re.MULTILINE)
        assert match, name
        return int(match.group(1).replace("_", ""))

    def c_define(name: str) -> int:
        match = re.search(rf"^#define {name} (\d+)", header, re.MULTILINE)
        assert match, name
        return int(match.group(1))

    assert nim_const("MinToneHz") == c_define("FOS_TONE_HZ_MIN")
    assert nim_const("MaxToneHz") == c_define("FOS_TONE_HZ_MAX")
    assert nim_const("MinNoteMs") == c_define("FOS_TONE_NOTE_MS_MIN")
    assert nim_const("MaxNoteMs") == c_define("FOS_TONE_NOTE_MS_MAX")
    assert nim_const("MaxToneMs") == c_define("FOS_TONE_TOTAL_MS_MAX")
    buzzer = (MAIN_DIR / "fos_buzzer.h").read_text()
    notes = re.search(r"^#define FOS_BUZZER_NOTES_MAX (\d+)", buzzer, re.MULTILINE)
    assert notes and int(notes.group(1)) == nim_const("MaxToneNotes")


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_tone_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_tone"
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
            *[str(source) for source in SOURCES],
            str(TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "tone host tests do not compile:\n" + compile_result.stderr

    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180)
    assert run_result.returncode == 0, "tone host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout[-4000:]
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 30, f"expected the full suite to run, saw {checks} checks"
