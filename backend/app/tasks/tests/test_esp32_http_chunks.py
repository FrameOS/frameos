from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_http_chunks.c — how a response body
# is cut into the blocks it is buffered in (frameos_nim_glue.c) — and reads
# the glue and the runtime for what stands on it. Same arrangement as
# test_esp32_oom_policy.py: a host test nothing invokes is a host test that
# does not exist.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
INCLUDE = ESP32_DIR / "components" / "frameos_nim" / "include"
HEADER = INCLUDE / "fos_http_chunks.h"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_http_chunks.c"
GLUE = ESP32_DIR / "components" / "frameos_nim" / "frameos_nim_glue.c"
NIM_SRC = REPO_ROOT / "frameos" / "src"


def test_sources_exist():
    assert HEADER.is_file(), f"missing {HEADER}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_http_chunks_is_pure():
    source = HEADER.read_text()
    assert "esp_" not in source, "fos_http_chunks.h must not pull in IDF headers or calls"
    assert "freertos" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_http_chunks_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_http_chunks"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(INCLUDE), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "HTTP chunk host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "HTTP chunk host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 20


def test_glue_sizes_a_block_by_the_stated_length():
    # A 341 KB map took a 512 KB block (and a copy beside it) on a reTerminal
    # E1004; with the block its own size it is one block its reader uses
    # where it lies.
    glue = GLUE.read_text()
    assert "fos_http_chunk_want(FOS_NIM_HTTP_CHUNK_BYTES, limit, total, content_length)" in glue
    assert "fos_http_body_whole(total, content_length)" in glue
    # The last block ends with a NUL: boundedGetWhole hands it to the JSON
    # parser as it is.
    assert "chunks[chunk_count - 1].data[chunks[chunk_count - 1].len] = 0;" in glue


def test_fetch_json_parses_the_bytes_that_came():
    # No JS string of the text (two bytes a character with one name past
    # Latin-1) and no UTF-8 copy of that in JSON.parse.
    app_runtime = (NIM_SRC / "frameos" / "js_runtime" / "app_runtime.nim").read_text()
    assert "fetchJson: (url) => jsFetchJson(String(url || \"\"))," in app_runtime
    assert "boundedGetWhole(urlStr, parse, maxBytes = jsFetchMaxBytes(e))" in app_runtime
    http_client = (NIM_SRC / "frameos" / "utils" / "http_client.nim").read_text()
    # A body copied into one string asks for its block first: an allocation
    # of a download's size that fails is the end of the render.
    copy = http_client.index("result.body = newString(response.bodyLen)")
    assert "requireRoomForBody(response.bodyLen)" in http_client[copy - 200 : copy]


def test_a_reserve_that_could_not_be_armed_is_armed_later():
    # One failed arm left the frame without its emergency reserve until the
    # next failed allocation, which then had nothing to release.
    glue = GLUE.read_text()
    assert "bool fos_nim_emergency_reserve_unarmed(void)" in glue
    main = (NIM_SRC / "embedded" / "embedded_main.nim").read_text()
    recover = main[main.index("proc recoverEmergencyReserve(where: string) =") :]
    recover = recover[: recover.index("\n# ---")]
    assert "if emergencyReserveUnarmed():\n      armEmergencyReserve()" in recover
