import asyncio
import ipaddress
import ssl

import httpx
import pytest

from app.models.frame import Frame
import app.utils.frame_http as frame_http
from app.utils import network
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


def test_embedded_direct_candidates_follow_the_boot_ip_over_plain_http_without_tls():
    frame = _frame("espvaarikas.local")
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.embedded = {"lastBoot": {"ip": "10.8.0.232"}}

    candidates = _frame_http_direct_candidates(frame, "/status", "GET")

    assert candidates == [("http://espvaarikas.local:80/status", True), ("http://10.8.0.232:80/status", True)]


def _tls_frame(frame_host: str, certificate_host: str | None, boot_ip: str | None = "10.8.0.232") -> Frame:
    frame = _frame(frame_host)
    frame.mode = "embedded"
    frame.frame_port = 80
    frame.https_proxy = {
        "enable": True,
        "port": 8443,
        "certs": generate_frame_tls_material(certificate_host) if certificate_host else {},
    }
    frame.embedded = {"lastBoot": {"ip": boot_ip}} if boot_ip else {}
    return frame


def test_with_tls_on_no_candidate_is_plain_http():
    """The request carries the frame's bearer, and every connect error moves
    on to the next candidate: an http one would be a downgrade anyone on the
    LAN can force by resetting the https port."""
    for frame in (
        _tls_frame("espvaarikas.local", "espvaarikas.local"),
        _tls_frame("espvaarikas.local", None),
        _tls_frame("10.8.0.232", "espvaarikas.local"),
        _tls_frame("10.8.0.232", "10.8.0.232"),
        _tls_frame("10.8.0.9", "10.8.0.9"),
        _tls_frame("10.8.0.232", "10.8.0.232", boot_ip=None),
    ):
        for method, path in (("GET", "/status"), ("POST", "/api/action/ota")):
            candidates = _frame_http_direct_candidates(frame, path, method)
            assert candidates, frame.frame_host
            assert all(url.startswith("https://") and ":8443/" in url for url, _ in candidates), candidates


def test_with_tls_on_the_boot_ip_is_tried_over_https_against_the_frames_own_certificate():
    frame = _tls_frame("espvaarikas.local", "espvaarikas.local")
    candidates = _frame_http_direct_candidates(frame, "/status", "GET")
    assert [url for url, _ in candidates] == ["https://espvaarikas.local:8443/status", "https://10.8.0.232:8443/status"]
    by_name, by_certificate = candidates[0][1], candidates[1][1]
    # The name the certificate was made for is checked the ordinary way; the
    # address it has moved to is not in the certificate, so there the
    # certificate itself is what is checked.
    assert by_name.check_hostname is True
    assert by_certificate.check_hostname is False and by_certificate.verify_mode == ssl.CERT_REQUIRED

    # The row holds an address the certificate does not cover: still https.
    moved = _tls_frame("10.8.0.232", "espvaarikas.local")
    candidates = _frame_http_direct_candidates(moved, "/api/action/ota", "POST")
    assert [url for url, _ in candidates] == ["https://10.8.0.232:8443/api/action/ota"]
    assert candidates[0][1].check_hostname is False

    # No certificate stored: nothing to pin, the ordinary check applies.
    bare = _tls_frame("espvaarikas.local", None)
    assert [verify for _, verify in _frame_http_direct_candidates(bare, "/status", "GET")] == [True, True]


@pytest.mark.asyncio
async def test_the_pinned_check_takes_the_frames_certificate_and_no_other(tmp_path):
    """A real handshake: the frame's own certificate passes at an address it
    does not name; another certificate made for the very same name does not."""
    frame = _tls_frame("espvaarikas.local", "espvaarikas.local")
    pinned = frame_http._pinned_verify(frame)
    assert pinned is not None

    async def handshake(certs: dict[str, str]) -> None:
        (tmp_path / "cert.pem").write_text(certs["server"])
        (tmp_path / "key.pem").write_text(certs["server_key"])
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")

        async def serve(reader, writer):
            writer.close()

        server = await asyncio.start_server(serve, "127.0.0.2", 0, ssl=server_context)
        port = server.sockets[0].getsockname()[1]
        try:
            _, writer = await asyncio.open_connection("127.0.0.2", port, ssl=pinned)
            writer.close()
        finally:
            server.close()
            await server.wait_closed()

    await handshake(frame.https_proxy["certs"])
    with pytest.raises(ssl.SSLCertVerificationError):
        await handshake(generate_frame_tls_material("espvaarikas.local"))


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
    # Reads a frame answers in full only to the server key: the scene JSON,
    # and the secret-typed fields of a scene's state.
    for path in ("/getUploadedScenes", "/states", "/state", "/states?x=1"):
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


class _FakeStream:
    """What `client.stream(...)` hands back: the response, with the body
    delivered the way frame_http reads it (aiter_bytes under a cap)."""

    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    @property
    def status_code(self):
        return self.response.status_code

    @property
    def headers(self):
        return self.response.headers

    async def aiter_bytes(self, chunk_size=None):
        yield self.response.content


def _fake_client_factory(calls, respond):
    class FakeAsyncClient:
        def __init__(self, verify=True):
            self.verify = verify

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, content=None, timeout=None):
            calls.append((method, url, dict(headers or {})))
            return _FakeStream(respond(headers or {}))

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
async def test_a_tls_failure_moves_on_to_the_boot_ip_over_https_and_never_to_http(monkeypatch):
    frame = _tls_frame("espvaarikas.local", "espvaarikas.local")
    frame.server_api_key = "server-secret"
    calls = []
    answering = {"https://10.8.0.232:8443/api/action/ota"}

    async def fake_use_remote(_frame, _redis):
        return False

    class FakeAsyncClient:
        def __init__(self, verify=True):
            self.verify = verify

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, content=None, timeout=None):
            calls.append((method, url, self.verify, headers, content, timeout))
            if url not in answering:
                raise httpx.ConnectError(
                    "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
                    "Hostname mismatch, certificate is not valid for 'espvaarikas.local'."
                )
            return _FakeStream(httpx.Response(200, content=b"queued", headers={"x-frameos": "ok"}))

    async def resolve_lan(host):
        return [ipaddress.ip_address("10.8.0.232")]

    monkeypatch.setattr(frame_http, "_use_remote", fake_use_remote)
    monkeypatch.setattr(frame_http.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(network, "resolve_target", resolve_lan)

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
        "https://10.8.0.232:8443/api/action/ota",
    ]
    # The second try checks the certificate itself, not the address.
    assert calls[1][2].check_hostname is False

    # Nothing answers over TLS: the bearer is never sent in clear instead.
    calls.clear()
    answering.clear()
    with pytest.raises(frame_http.HTTPException) as refused:
        await frame_http._fetch_frame_http_bytes(frame, None, path="/api/action/ota", method="POST")
    assert refused.value.status_code == 502
    assert calls and all(call[1].startswith("https://") for call in calls)
    assert all(call[3] == {"Authorization": "Bearer server-secret"} for call in calls)


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



def test_the_access_key_never_reaches_an_error_detail():
    from app.utils.frame_http import redact_access_key

    frame = _frame("10.0.0.9")
    frame.frame_access_key = "access-key-secret"
    url = "http://10.0.0.9:8787/image?k=access-key-secret&t=1"
    assert redact_access_key(url, frame) == "http://10.0.0.9:8787/image?k=[redacted]&t=1"
    assert redact_access_key(f"Timeout to {url}", frame).count("access-key-secret") == 0
    assert redact_access_key("connect failed for access-key-secret", frame) == "connect failed for [redacted]"
    assert redact_access_key("http://h/x?a=1&k=abc", None) == "http://h/x?a=1&k=[redacted]"


@pytest.mark.asyncio
async def test_a_timeout_names_the_url_without_its_key(monkeypatch):
    frame = _frame("10.0.0.9")
    frame.frame_port = 8787
    frame.frame_access = "private"
    frame.frame_access_key = "access-key-secret"

    async def fake_use_remote(_frame, _redis):
        return False

    class TimingOut:
        def __init__(self, verify=True):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def stream(self, *args, **kwargs):
            raise httpx.ConnectTimeout("timed out")

    async def resolve_lan(host):
        return [ipaddress.ip_address("10.0.0.9")]

    monkeypatch.setattr(frame_http, "_use_remote", fake_use_remote)
    monkeypatch.setattr(frame_http.httpx, "AsyncClient", TimingOut)
    monkeypatch.setattr(network, "resolve_target", resolve_lan)
    monkeypatch.setattr(frame_http, "FRAME_HTTP_RETRIES", 1)
    with pytest.raises(frame_http.HTTPException) as refused:
        await frame_http._fetch_frame_http_bytes(frame, None, path="/image")
    assert "Timeout to http://10.0.0.9:8787/image?k=[redacted]" == refused.value.detail
