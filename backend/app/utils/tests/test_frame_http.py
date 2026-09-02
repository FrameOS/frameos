import httpx
import pytest

from app.models.frame import Frame
import app.utils.frame_http as frame_http
from app.utils.tls import generate_frame_tls_material
from app.utils.frame_http import (
    _auth_headers,
    _frame_http_direct_candidates,
    _is_control_path,
    _tls_connect_error_detail,
)


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


def test_linux_auth_headers_use_access_key_unless_server_key_preferred():
    frame = _frame("10.8.0.232")
    frame.mode = "rpios"
    frame.server_api_key = "server-secret"
    frame.frame_access = "private"
    frame.frame_access_key = "frame-access-key"

    assert _auth_headers(frame) == {"Authorization": "Bearer frame-access-key"}
    assert _auth_headers(frame, prefer_server_key=True) == {
        "Authorization": "Bearer server-secret"
    }
    # A caller-supplied Authorization header always wins.
    assert _auth_headers(frame, {"Authorization": "Bearer x"}, prefer_server_key=True) == {
        "Authorization": "Bearer x"
    }


def test_control_paths_are_the_runtime_control_events():
    for path in ("/uploadScenes", "/reload", "/event/reboot", "/event/restart", "/event/reload", "/event/uploadScenes?x=1"):
        assert _is_control_path(path), path
    for path in ("/event/setCurrentScene", "/event/render", "/image", "/api/frames/1/reload"):
        assert not _is_control_path(path), path


def _linux_frame_with_both_keys():
    frame = _frame("10.8.0.232")
    frame.mode = "rpios"
    frame.frame_port = 8787
    frame.server_api_key = "server-secret"
    frame.frame_access = "private"
    frame.frame_access_key = "frame-access-key"
    return frame


def _fake_client_factory(calls, respond):
    class FakeAsyncClient:
        def __init__(self, verify=True):
            self.verify = verify

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def request(self, method, url, headers=None, content=None, timeout=None):
            calls.append((method, url, dict(headers or {})))
            return respond(headers or {})

    return FakeAsyncClient


@pytest.mark.asyncio
async def test_control_verbs_use_the_server_key_and_fall_back_to_the_access_key(monkeypatch):
    """A frame from before the runtime accepted `Bearer serverApiKey` on
    /uploadScenes answers 401 to it; the backend retries once with the access
    key so deployed frames keep working until they are redeployed."""
    frame = _linux_frame_with_both_keys()
    calls = []

    async def fake_use_remote(_frame, _redis):
        return False

    def legacy_runtime(headers):
        if headers.get("Authorization") == "Bearer frame-access-key":
            return httpx.Response(200, content=b"ok")
        return httpx.Response(401, content=b"unauthorized")

    monkeypatch.setattr(frame_http, "_use_remote", fake_use_remote)
    monkeypatch.setattr(frame_http.httpx, "AsyncClient", _fake_client_factory(calls, legacy_runtime))

    status, body, _ = await frame_http._fetch_frame_http_bytes(
        frame, None, path="/uploadScenes", method="POST", body=b"[]"
    )
    assert status == 200 and body == b"ok"
    assert [c[2]["Authorization"] for c in calls] == [
        "Bearer server-secret",
        "Bearer frame-access-key",
    ]


@pytest.mark.asyncio
async def test_control_verbs_do_not_retry_when_the_server_key_is_accepted(monkeypatch):
    frame = _linux_frame_with_both_keys()
    calls = []

    async def fake_use_remote(_frame, _redis):
        return False

    def current_runtime(headers):
        if headers.get("Authorization") == "Bearer server-secret":
            return httpx.Response(200, content=b"ok")
        return httpx.Response(401, content=b"unauthorized")

    monkeypatch.setattr(frame_http, "_use_remote", fake_use_remote)
    monkeypatch.setattr(frame_http.httpx, "AsyncClient", _fake_client_factory(calls, current_runtime))

    status, _, _ = await frame_http._fetch_frame_http_bytes(
        frame, None, path="/event/reboot", method="POST", body=b"{}"
    )
    assert status == 200
    assert len(calls) == 1

    # Scene events keep the access key (what every runtime accepts for them)
    # and never retry: a 401 there is a real 401.
    calls.clear()
    status, _, _ = await frame_http._fetch_frame_http_bytes(
        frame, None, path="/event/setCurrentScene", method="POST", body=b"{}"
    )
    assert status == 401
    assert [c[2]["Authorization"] for c in calls] == ["Bearer frame-access-key"]


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


@pytest.mark.asyncio
async def test_fetch_frame_http_bytes_encodes_remote_text_as_utf8(monkeypatch):
    frame = _frame("frame.local")

    async def fake_use_remote(_frame, _redis):
        return True

    async def fake_http_get_on_frame(*_args, **_kwargs):
        return {
            "status": 200,
            "body": '{"name":"non\u2011breaking hyphen"}',
            "headers": {"content-type": "application/json"},
        }

    monkeypatch.setattr(frame_http, "_use_remote", fake_use_remote)
    monkeypatch.setattr(frame_http, "http_get_on_frame", fake_http_get_on_frame)

    status, body, headers = await frame_http._fetch_frame_http_bytes(frame, None, path="/api/frames/1")

    assert status == 200
    assert body == b'{"name":"non\xe2\x80\x91breaking hyphen"}'
    assert body.decode("utf-8") == '{"name":"non\u2011breaking hyphen"}'
    assert headers["content-type"] == "application/json"
