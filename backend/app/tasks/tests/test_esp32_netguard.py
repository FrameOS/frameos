from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_netguard.c.
#
# Same arrangement as test_esp32_sd_probe.py next door, and for the same
# reason: host tests that nothing invokes are host tests that do not exist.
#
# What it covers is the private-network egress guard — the check that stops a
# scene installed by a cloud provider from reaching 192.168.x.x on the owner's
# LAN. The ESP32 firmware shipped without it for a while (the policy existed
# only in the native Nim runtime), so these assertions are the difference
# between "we have a policy" and "the policy is right".
#
# fos_netguard.c keeps its classifier and URL parser as plain C over strings,
# with the IDF bits behind ESP_PLATFORM, so a laptop compiler is all this needs.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
NETGUARD_SOURCE = ESP32_DIR / "components" / "frameos_nim" / "fos_netguard.c"
NETGUARD_INCLUDE = ESP32_DIR / "components" / "frameos_nim" / "include"
NETGUARD_TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_netguard.c"


def test_sources_exist():
    assert NETGUARD_SOURCE.is_file(), f"missing {NETGUARD_SOURCE}"
    assert NETGUARD_TEST_SOURCE.is_file(), f"missing {NETGUARD_TEST_SOURCE}"


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_netguard_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_netguard"
    compile_result = subprocess.run(
        [
            "cc",
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-I",
            str(NETGUARD_INCLUDE),
            str(NETGUARD_SOURCE),
            str(NETGUARD_TEST_SOURCE),
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, (
        "netguard host tests do not compile:\n" + compile_result.stderr
    )

    run_result = subprocess.run(
        [str(binary)], capture_output=True, text=True, timeout=180
    )
    assert run_result.returncode == 0, (
        "netguard host tests failed:\n" + run_result.stdout[-4000:]
    )

    # Assert the count too: a binary that asserted nothing would also exit 0.
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, (
        "could not find the check summary in the output:\n" + run_result.stdout[-4000:]
    )
    checks, failures = int(summary.group(1)), int(summary.group(2))
    assert failures == 0
    assert checks >= 100, f"expected the full netguard suite to run, saw {checks} checks"
