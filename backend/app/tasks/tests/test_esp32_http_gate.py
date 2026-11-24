from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# The ESP32 HTTP server's one access gate (embedded/esp32/main/fos_http.c).
#
# Until 2026-10-26 the gate handed back httpd_resp_send_err's result as its
# verdict: ESP_OK once the 401 had gone out, so REQUIRE_PROTECTED_ACCESS()
# fell through and every protected handler ran for the request it had just
# refused (an unauthenticated asset delete deleted the file). The handlers
# need ESP-IDF's httpd, so there is no host test of them; this pins the
# gate's shape instead: a yes/no decision, and a macro that returns from the
# handler whenever the answer is no.

MAIN_DIR = Path(__file__).resolve().parents[4] / "embedded" / "esp32" / "main"
HTTP_SOURCE = MAIN_DIR / "fos_http.c"
THROTTLE_TEST = MAIN_DIR / "tests" / "test_fos_login_throttle.c"


def _gate_macro(source: str) -> str:
    match = re.search(r"#define REQUIRE_PROTECTED_ACCESS\(\)((?:.*\\\n)*.*)", source)
    assert match, "REQUIRE_PROTECTED_ACCESS is gone: point this test at what replaced it"
    return match.group(1)


def test_the_gate_decides_with_a_bool():
    source = HTTP_SOURCE.read_text()
    assert re.search(r"static bool protected_access_allowed\(httpd_req_t \*req\)", source)


def test_a_refused_request_returns_from_the_handler():
    macro = _gate_macro(HTTP_SOURCE.read_text())
    assert re.search(r"if \(!protected_access_allowed\(req\)\) return ", macro)


def test_the_gate_is_used():
    # 26 handlers on 2026-10-26; a drop to none means the gate moved.
    source = HTTP_SOURCE.read_text()
    assert source.count("REQUIRE_PROTECTED_ACCESS();") >= 20


def _function(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start)
    return source[start:end]


# A page that is not the device's own may not change anything on it: a browser
# sends a remembered device login with another site's form too, and on the
# setup hotspot there is no login to ask. The rule is asked where every route
# passes (logged_dispatch), before any handler, and the comparison itself is
# fos_url_origin_is_host (host-tested by tests/test_fos_url_guard.c, which
# the ESP32 job of e2e-docker.yml runs).


def test_every_route_goes_through_the_one_dispatch():
    source = HTTP_SOURCE.read_text()
    assert source.count("httpd_register_uri_handler(") == 1
    assert "httpd_register_uri_handler(server, &wrapped)" in _function(source, "static esp_err_t register_logged_route(")
    assert "wrapped.handler = logged_dispatch;" in source


def test_a_cross_site_write_is_refused_before_any_handler():
    source = HTTP_SOURCE.read_text()
    dispatch = _function(source, "static esp_err_t logged_dispatch(httpd_req_t *req)")
    refusal = dispatch.index("if (cross_site_write(req))")
    assert refusal < dispatch.index("route->handler(req)")
    assert "HTTPD_403_FORBIDDEN" in dispatch[refusal:dispatch.index("route->handler(req)")]
    check = _function(source, "bool cross_site_write(httpd_req_t *req)")
    # Reading is not writing, and what names no Origin is no browser's cross-site request.
    assert "req->method == HTTP_GET || req->method == HTTP_HEAD" in check
    assert "fos_url_origin_is_host(origin, host)" in check


# Wrong device logins are counted (fos_login_throttle.h): ten in five minutes,
# then no Basic login is looked at until the five minutes are over. A plane's
# Bearer key is not counted and is never locked out.


def test_a_wrong_login_is_counted_and_a_spent_window_looks_at_none():
    source = HTTP_SOURCE.read_text()
    basic = _function(source, "static bool request_basic_matches(")
    throttled = basic.index("fos_login_throttled(&s_login_throttle")
    compared = basic.index("fos_consttime_eq(")
    assert throttled < compared, "the window is asked before the password is compared"
    assert "fos_login_wrong(&s_login_throttle" in basic[compared:]
    bearer = _function(source, "static bool request_bearer_matches(")
    assert "s_login_throttle" not in bearer
    assert "429 Too Many Requests" in _function(source, "static esp_err_t refuse_protected_access(")


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_login_throttle_host_test(tmp_path: Path):
    binary = tmp_path / "test_fos_login_throttle"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(MAIN_DIR), str(THROTTLE_TEST), "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert compile_result.returncode == 0, compile_result.stderr
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " checks, 0 failures" in result.stdout


# With TLS up, only the TLS port: the frame has always reported
# `expose_only_port: true`, and a client that tries the plain port must be
# refused the connection, not answered after it sent its key in the clear.


def test_the_plain_server_stops_once_tls_is_up():
    source = HTTP_SOURCE.read_text()
    start = _function(source, "esp_err_t fos_http_start(bool portal_mode)")
    running = start.index('s_https_state = "running";')
    stopped = start.index("httpd_stop(s_http_server);", running)
    # Only on that branch: a TLS server that did not come up leaves the plain one.
    assert "} else {" not in start[running:stopped]
    assert "s_http_server = NULL;" in start[stopped:stopped + 80]
    assert 'cJSON_AddBoolToObject(https, "expose_only_port", true);' in source
