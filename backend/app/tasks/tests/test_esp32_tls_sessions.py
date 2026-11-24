from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_tls_sessions.c — the table of TLS
# sessions a frame can resume (fos_tls_sessions.h) — and reads the glue for
# what stands on it. Same arrangement as test_esp32_http_chunks.py: a host
# test nothing invokes is a host test that does not exist.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
COMPONENT = ESP32_DIR / "components" / "frameos_nim"
INCLUDE = COMPONENT / "include"
HEADER = INCLUDE / "fos_tls_sessions.h"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_tls_sessions.c"
GLUE = COMPONENT / "frameos_nim_glue.c"


def test_sources_exist():
    assert HEADER.is_file(), f"missing {HEADER}"
    assert TEST_SOURCE.is_file(), f"missing {TEST_SOURCE}"


def test_tls_sessions_is_pure():
    # The table holds pointers it never reads: no mbedTLS, no IDF, no lock.
    source = HEADER.read_text()
    assert "esp_" not in source, "fos_tls_sessions.h must not pull in IDF headers or calls"
    assert "freertos" not in source
    assert "#include \"mbedtls" not in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_tls_sessions_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_tls_sessions"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(INCLUDE), str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "TLS session host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "TLS session host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 60


def _open_request() -> str:
    glue = GLUE.read_text()
    start = glue.index("static esp_http_client_handle_t http_open_request(\n    const char *method, const char *url, const char *log_url,\n    const void *body")
    start = glue.index("{", glue.index("char *err_buf, size_t err_buf_len", start))
    return glue[start:]


def test_every_connect_of_a_scene_request_offers_and_keeps_its_hosts_session():
    # The first connect and each redirect hop: begin, the connect, end, in
    # that order and nothing else between, so no record outlives its connect
    # (one that did would keep the next host's session under this host's name).
    body = _open_request()
    opens = [m.start() for m in re.finditer(r"http_open_with_retry\(client, body_len, log_url\)", body)]
    assert len(opens) == 2, "http_open_request connects in two places: the request and a redirect hop"
    for at in opens:
        before = body[:at].rstrip()
        line = before[before.rindex("\n") + 1 :]
        previous = before[: before.rindex("\n")].rstrip()
        previous = previous[previous.rindex("\n") + 1 :]
        assert "http_open_with_retry" not in previous
        assert "tls_resume_begin(" in previous, "a connect without tls_resume_begin() before it: " + line
        after = body[at:].split("\n")[1]
        assert "tls_resume_end(err == ESP_OK);" in after, "a connect without tls_resume_end() after it"


def test_a_redirect_hop_gets_the_session_of_its_own_host():
    # Never the session of the host that sent it on: the hop's URL is the
    # one its key is made of.
    body = _open_request()
    assert "tls_resume_begin(url);" in body
    assert "tls_resume_begin(redirect_url_ok ? redirect_url : NULL);" in body
    glue = GLUE.read_text()
    begin = glue[glue.index("static void tls_resume_begin(const char *url)") :]
    begin = begin[: begin.index("\n}\n")]
    # https alone, and under the host and port the URL itself names.
    assert 'strncasecmp(url, "https://", 8) != 0' in begin
    assert "fos_netguard_parse_url(url, host, sizeof(host), &port)" in begin
    assert "fos_tls_session_key(host, port, key, sizeof(key))" in begin


def test_only_a_marked_task_goes_past_the_real_handshake():
    # The wrap is in front of every TLS handshake of the firmware (the cloud
    # link, OTA, the frame's own HTTPS server): all of them are the real call
    # and nothing else.
    glue = GLUE.read_text()
    wrap = glue[glue.index("int __wrap_mbedtls_ssl_handshake(mbedtls_ssl_context *ssl)") :]
    wrap = wrap[: wrap.index("\n}\n")]
    assert "if (mine == NULL) return __real_mbedtls_ssl_handshake(ssl);" in wrap
    assert wrap.index("if (mine == NULL) return") < wrap.index("mbedtls_ssl_set_session")
    # Offered once a connect: a retry after a handshake that failed with it
    # starts from nothing.
    assert "if (mine->offer != NULL && !mine->offered) {" in wrap
    cmake = (COMPONENT / "CMakeLists.txt").read_text()
    assert '"-Wl,--wrap=mbedtls_ssl_handshake"' in cmake


def test_a_session_the_server_takes_frees_the_receive_buffers_its_skipped_states_left():
    # ESP-IDF's dynamic buffers free a handshake message's receive buffer by
    # the state before the current one, which a resumed handshake skips
    # twice: after the server's hello and after its Finished. Left as they
    # were, the next message was read into a block of the last one's size
    # (heap asserts on a reTerminal E1003, 2026-11-24). A connection that
    # offered a session is stepped by the glue, which frees both.
    glue = GLUE.read_text()
    steps = glue[glue.index("static int tls_handshake_resuming(mbedtls_ssl_context *ssl, bool *taken)") :]
    steps = steps[: steps.index("\n}\n")]
    assert "mbedtls_ssl_handshake_step(ssl)" in steps
    assert "before == MBEDTLS_SSL_SERVER_HELLO &&" in steps
    assert "MBEDTLS_SSL_SERVER_CHANGE_CIPHER_SPEC" in steps and "MBEDTLS_SSL_NEW_SESSION_TICKET" in steps
    assert "before == MBEDTLS_SSL_SERVER_FINISHED && state == MBEDTLS_SSL_CLIENT_CHANGE_CIPHER_SPEC" in steps
    assert steps.index("mbedtls_ssl_handshake_step(ssl)") < steps.index("esp_mbedtls_free_rx_buffer(ssl)")
    wrap = glue[glue.index("int __wrap_mbedtls_ssl_handshake(mbedtls_ssl_context *ssl)") :]
    wrap = wrap[: wrap.index("\n}\n")]
    assert "mine->offer != NULL ? tls_handshake_resuming(ssl, &mine->taken) : __real_mbedtls_ssl_handshake(ssl)" in wrap
    # The buffers it stands on are the ones the image is built with.
    assert "CONFIG_MBEDTLS_DYNAMIC_BUFFER=y" in (ESP32_DIR / "sdkconfig.defaults").read_text()


def test_a_server_that_did_not_take_the_session_is_not_kept():
    # GitHub and DuckDuckGo answer an offered session with a full handshake:
    # their sessions held two of the four slots and put Hacker News's and
    # Wikipedia's out (the E1003, 2026-11-24).
    glue = GLUE.read_text()
    end = glue[glue.index("static void tls_resume_end(bool connected)") :]
    end = end[: end.index("\n}\n")]
    assert "if (connected && spare != NULL && (offer == NULL || mine->taken)) {" in end
    steps = glue[glue.index("static int tls_handshake_resuming(mbedtls_ssl_context *ssl, bool *taken)") :]
    steps = steps[: steps.index("\n}\n")]
    assert "if (resumed) *taken = true;" in steps


def test_no_connection_is_kept_open_for_it():
    # A session is ~40 KB of internal RAM while its connection is open; what
    # is kept is the session's own data, in PSRAM.
    glue = GLUE.read_text()
    section = glue[glue.index("TLS sessions resumed (fos_tls_sessions.h)") : glue.index("int __real_mbedtls_ssl_handshake")]
    assert "heap_caps_calloc(1, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)" in section
    assert "esp_http_client_init" not in section and "keep_alive" not in section
    sdkconfig = (ESP32_DIR / "sdkconfig.defaults").read_text()
    # mbedTLS's own client ticket support is what the wrap stands on; ESP-TLS's
    # switch (which keeps a session inside one client only) stays off.
    assert "CONFIG_MBEDTLS_CLIENT_SSL_SESSION_TICKETS is not set" not in sdkconfig
    assert "CONFIG_ESP_TLS_CLIENT_SESSION_TICKETS=y" not in sdkconfig
