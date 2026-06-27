from app.models.frame import Frame
from app.utils.frame_http import _frame_http_direct_candidates, _tls_connect_error_detail


def _frame(frame_host: str = "frame.local") -> Frame:
    return Frame(name="f", frame_host=frame_host, status="ok")


def test_tls_connect_error_detail_for_hostname_mismatch():
    detail = _tls_connect_error_detail(
        _frame("turvaraam.local"),
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: Hostname mismatch, certificate is not valid for 'turvaraam.local'.",
    )

    assert detail is not None
    assert "hostname verification failed" in detail.lower()
    assert "turvaraam.local" in detail


def test_tls_connect_error_detail_for_ca_issue():
    detail = _tls_connect_error_detail(
        _frame(),
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self signed certificate in certificate chain",
    )

    assert detail is not None
    assert "certs.client_ca" in detail


def test_tls_connect_error_detail_for_non_tls_error():
    detail = _tls_connect_error_detail(_frame(), "[Errno 111] Connection refused")

    assert detail is None


def test_embedded_direct_candidates_include_plain_http_last_boot_ip_fallback():
    frame = _frame("espvaarikas.local")
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.https_proxy = {"enable": True, "port": 8443, "certs": {}}
    frame.embedded = {"lastBoot": {"ip": "10.8.0.232"}}

    candidates = _frame_http_direct_candidates(frame, "/status", "GET")

    assert candidates[0][0] == "https://espvaarikas.local:8443/status"
    assert candidates[1][0] == "http://10.8.0.232:80/status"
    assert candidates[1][1] is True


def test_embedded_direct_candidates_include_plain_http_fallback_when_host_is_boot_ip():
    frame = _frame("10.8.0.232")
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.https_proxy = {"enable": True, "port": 8443, "certs": {}}
    frame.embedded = {"lastBoot": {"ip": "10.8.0.232"}}

    candidates = _frame_http_direct_candidates(frame, "/status", "GET")

    assert candidates[0][0] == "https://10.8.0.232:8443/status"
    assert candidates[1][0] == "http://10.8.0.232:80/status"
