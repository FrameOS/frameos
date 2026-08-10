from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_sd_probe.c.
#
# That file is 741 lines of host tests over the SD "provably empty" probe, and
# until this wrapper existed nothing invoked it: no CI job, no script, no CMake
# target — only build instructions in a header comment. It has been passing and
# unrun, which is the same thing as untested.
#
# It is the worst file in the tree to leave that way. fos_sd_probe.h states the
# stakes itself: the probe decides whether a card is blank, a wrong "blank"
# auto-formats it, and "destroys irreplaceable data and there is no undo". The
# 300-odd assertions encoding that one-directional bias are the safety net.
#
# fos_sd_probe.c is deliberately pure C over byte buffers — no IDF, no mocks —
# so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
PROBE_SOURCE = ESP32_DIR / "main" / "fos_sd_probe.c"
PROBE_TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_sd_probe.c"


def test_sources_exist():
    assert PROBE_SOURCE.is_file(), f"missing {PROBE_SOURCE}"
    assert PROBE_TEST_SOURCE.is_file(), f"missing {PROBE_TEST_SOURCE}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_sd_probe_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_sd_probe"
    compile_result = subprocess.run(
        [
            "cc",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-I",
            str(ESP32_DIR / "main"),
            str(PROBE_SOURCE),
            str(PROBE_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "SD probe host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "SD probe host tests failed:\n" + run_result.stdout[-4000:]
    )

    # The runner prints "<n> checks, <m> failures" and exits 0 on success. Assert
    # the count too: a binary that asserted nothing would also exit 0, and the
    # whole point of this wrapper is that silence is not proof.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 100, f"expected the full probe suite to run, saw {checks} checks"
