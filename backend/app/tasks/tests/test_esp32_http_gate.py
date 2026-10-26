from __future__ import annotations

import re
from pathlib import Path

# The ESP32 HTTP server's one access gate (embedded/esp32/main/fos_http.c).
#
# Until 2026-10-26 the gate handed back httpd_resp_send_err's result as its
# verdict: ESP_OK once the 401 had gone out, so REQUIRE_PROTECTED_ACCESS()
# fell through and every protected handler ran for the request it had just
# refused (an unauthenticated asset delete deleted the file). The handlers
# need ESP-IDF's httpd, so there is no host test of them; this pins the
# gate's shape instead: a yes/no decision, and a macro that returns from the
# handler whenever the answer is no.

HTTP_SOURCE = Path(__file__).resolve().parents[4] / "embedded" / "esp32" / "main" / "fos_http.c"


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
