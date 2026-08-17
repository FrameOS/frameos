from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_board.c.
#
# Same arrangement as test_esp32_netguard.py next door, and for the same
# reason: host tests that nothing invokes are host tests that do not exist.
#
# What it covers came out of one XTEINK X4 log. The frame reported
# `"board":{"target":"esp32-s3","module":"Seeed XIAO ESP32-S3 class"}` — both
# hardcoded literals — and then failed with "out of memory for 96000 byte
# framebuffer". It is an ESP32-C3, so the first half sent its reader hunting a
# broken S3, and the second half is what a C3 does when a 96000-byte
# contiguous request meets an internal heap that Wi-Fi has already carved up.
#
# fos_board.c is pure string mapping, and fos_framebuffer.c keeps its
# reservation policy above the ESP_PLATFORM guard, so a laptop compiler is all
# this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
MAIN_DIR = ESP32_DIR / "main"
BOARD_SOURCE = MAIN_DIR / "fos_board.c"
FRAMEBUFFER_SOURCE = MAIN_DIR / "fos_framebuffer.c"
BOARD_TEST_SOURCE = MAIN_DIR / "tests" / "test_fos_board.c"


def test_sources_exist():
    assert BOARD_SOURCE.is_file(), f"missing {BOARD_SOURCE}"
    assert FRAMEBUFFER_SOURCE.is_file(), f"missing {FRAMEBUFFER_SOURCE}"
    assert BOARD_TEST_SOURCE.is_file(), f"missing {BOARD_TEST_SOURCE}"


def test_status_json_does_not_hardcode_a_board():
    """The regression itself: a literal chip name in the status JSON.

    Every board FrameOS supports shares this one builder, so a hardcoded
    target is wrong for all but one of them — and wrong in the place people
    look first when a frame misbehaves.
    """
    status_json = (MAIN_DIR / "fos_http.c").read_text()
    assert '"target":\\"esp32-s3\\"' not in status_json
    assert "Seeed XIAO ESP32-S3 class" not in status_json
    assert "fos_board_target()" in status_json


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_board_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_board"
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
            str(BOARD_SOURCE),
            str(FRAMEBUFFER_SOURCE),
            str(BOARD_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "board host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "board host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 20, f"expected the full board suite to run, saw {checks} checks"
