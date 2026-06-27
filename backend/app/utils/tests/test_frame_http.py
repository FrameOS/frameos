import httpx
import pytest

from app.models.frame import Frame
import app.utils.frame_http as frame_http
from app.utils.tls import generate_frame_tls_material
from app.utils.frame_http import _auth_headers, _frame_http_direct_candidates, _tls_connect_error_detail


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


def test_embedded_direct_candidates_skip_https_ip_when_cert_does_not_cover_ip():
    frame = _frame("10.8.0.232")
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.https_proxy = {
        "enable": True,
        "port": 8443,
        "certs": generate_frame_tls_material("espvaarikas.local"),
    }
    frame.embedded = {"lastBoot": {"ip": "10.8.0.232"}}

    candidates = _frame_http_direct_candidates(frame, "/api/action/ota", "POST")

    assert candidates == [("http://10.8.0.232:80/api/action/ota", True)]


def test_embedded_direct_candidates_keep_https_ip_when_cert_covers_ip():
    frame = _frame("10.8.0.232")
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.https_proxy = {
        "enable": True,
        "port": 8443,
        "certs": generate_frame_tls_material("10.8.0.232"),
    }
    frame.embedded = {"lastBoot": {"ip": "10.8.0.232"}}

    candidates = _frame_http_direct_candidates(frame, "/api/action/ota", "POST")

    assert candidates[0][0] == "https://10.8.0.232:8443/api/action/ota"
    assert candidates[1][0] == "http://10.8.0.232:80/api/action/ota"


def test_embedded_auth_headers_use_server_api_key():
    frame = _frame("10.8.0.232")
    frame.mode = "embedded"
    frame.server_api_key = "server-secret"
    frame.frame_access = "private"
    frame.frame_access_key = "frame-access-key"

    assert _auth_headers(frame) == {"Authorization": "Bearer server-secret"}


@pytest.mark.asyncio
async def test_fetch_frame_http_bytes_falls_back_after_tls_candidate_error(monkeypatch):
    frame = _frame("espvaarikas.local")
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.https_proxy = {"enable": True, "port": 8443, "certs": {}}
    frame.embedded = {"lastBoot": {"ip": "10.8.0.232"}}
    calls = []

    async def fake_use_remote(_frame, _redis):
        return False

    class FakeAsyncClient:
        def __init__(self, verify=True):
            self.verify = verify

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def request(self, method, url, headers=None, content=None, timeout=None):
            calls.append((method, url, self.verify, headers, content, timeout))
            if url.startswith("https://"):
                raise httpx.ConnectError(
                    "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
                    "Hostname mismatch, certificate is not valid for 'espvaarikas.local'."
                )
            return httpx.Response(200, content=b"queued", headers={"x-frameos": "ok"})

    monkeypatch.setattr(frame_http, "_use_remote", fake_use_remote)
    monkeypatch.setattr(frame_http.httpx, "AsyncClient", FakeAsyncClient)

    status, body, headers = await frame_http._fetch_frame_http_bytes(
        frame,
        None,
        path="/api/action/ota",
        method="POST",
    )

    assert status == 200
    assert body == b"queued"
    assert headers["x-frameos"] == "ok"
    assert [call[1] for call in calls] == [
        "https://espvaarikas.local:8443/api/action/ota",
        "http://10.8.0.232:80/api/action/ota",
    ]
