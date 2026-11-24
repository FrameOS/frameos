"""A mutation that rides the session cookie must come from one of this
backend's own pages (app/utils/same_origin.py)."""
import pytest

from app import config as app_config
from app.utils.same_origin import cross_site_mutation
from app.utils.session_cookie import SESSION_COOKIE_NAME

COOKIE = f"other=1; {SESSION_COOKIE_NAME}=abc"


def refused(method="POST", peer="8.8.4.4", **headers) -> bool:
    return cross_site_mutation(method, {name.replace("_", "-"): value for name, value in headers.items()}, peer)


def test_only_cookie_mutations_are_asked():
    cross = {"origin": "http://evil.example", "host": "frameos.local:8989"}
    assert refused(cookie=COOKIE, **cross)
    # Reads, bearers (a JWT, an API token, a frame's key) and requests with
    # no session cookie are never the browser's ambient credential at work.
    assert not refused(method="GET", cookie=COOKIE, **cross)
    assert not refused(cookie=COOKIE, authorization="Bearer fb_api_x", **cross)
    assert not refused(**cross)
    assert not refused(cookie="frameos_session_other=1", **cross)


def test_the_browser_says_where_the_request_came_from():
    host = {"cookie": COOKIE, "host": "frameos.local:8989"}
    # Sec-Fetch-Site is the browser's own verdict; same-site (another port on
    # this host, a sibling subdomain) is exactly what SameSite=Lax lets through.
    assert not refused(sec_fetch_site="same-origin", origin="http://whatever.example", **host)
    assert not refused(sec_fetch_site="none", **host)
    assert refused(sec_fetch_site="same-site", origin="http://frameos.local:8989", **host)
    assert refused(sec_fetch_site="cross-site", **host)
    # Plain http on a LAN address gets no Sec-Fetch-Site: Origin against the
    # host the browser dialled.
    assert not refused(origin="http://frameos.local:8989", **host)
    assert not refused(origin="http://FrameOS.local:8989", **host)
    assert refused(origin="http://frameos.local:3000", **host)
    assert refused(origin="http://other.frameos.local:8989", **host)
    assert refused(origin="null", **host)
    # Neither header: no browser, or the tools' own in-process calls.
    assert not refused(**host)


def test_a_proxy_that_rewrites_host(monkeypatch):
    behind = {"cookie": COOKIE, "host": "backend:8989", "origin": "https://frames.example.com"}
    assert refused(**behind)
    forwarded = {**behind, "x_forwarded_host": "frames.example.com"}
    assert not refused(peer="172.18.0.2", **forwarded)
    # A client out on the network cannot vouch for its own origin.
    assert refused(peer="8.8.4.4", **forwarded)
    monkeypatch.setattr(app_config.config, "FRAMEOS_PUBLIC_URL", "https://frames.example.com")
    assert not refused(**behind)
    assert refused(**{**behind, "origin": "https://evil.example.com"})


@pytest.mark.asyncio
async def test_the_guard_stands_in_front_of_the_routes(async_client, no_auth_client):
    login = await no_auth_client.post("/api/login", data={"username": "test@example.com", "password": "testpassword"})
    assert login.status_code == 200
    assert no_auth_client.cookies.get(SESSION_COOKIE_NAME)
    project = f"/api/projects/{async_client.project_id}"
    initialize = {"jsonrpc": "2.0", "id": 1, "method": "ping"}

    # The cookie alone, as a script or the tools' in-process client sends it.
    assert (await no_auth_client.post("/api/mcp", json=initialize)).status_code == 200
    # From our own page.
    ours = {"Origin": "http://test"}
    assert (await no_auth_client.post("/api/mcp", json=initialize, headers=ours)).status_code == 200
    # From a page on another port of this host, or another site: every way a
    # body can be sent without a preflight, and a bodyless POST.
    for headers in ({"Origin": "http://test:3000"}, {"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "same-site"}):
        for request in (
            no_auth_client.post("/api/mcp", json=initialize, headers=headers),
            no_auth_client.post("/api/mcp", content=b'{"jsonrpc":"2.0","id":1,"method":"ping"}', headers={**headers, "Content-Type": "text/plain"}),
            no_auth_client.post(f"{project}/frames/1/reboot", headers=headers),
            no_auth_client.post(f"{project}/templates", files={"file": ("x.zip", b"PK", "application/zip")}, headers=headers),
            no_auth_client.delete(f"{project}/frames/1", headers=headers),
        ):
            response = await request
            assert response.status_code == 403, (headers, response.request.url, response.text)
            assert response.json()["detail"]["error"] == "cross_site_request"
    # Reads are not asked, and a bearer is not ambient.
    assert (await no_auth_client.get(f"{project}/frames", headers={"Origin": "https://evil.example"})).status_code == 200
    assert (await async_client.post("/api/mcp", json=initialize, headers={"Origin": "https://evil.example"})).status_code == 200


@pytest.mark.asyncio
async def test_mcp_takes_json_only(async_client):
    body = b'{"jsonrpc":"2.0","id":1,"method":"ping"}'
    for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"):
        refused_response = await async_client.post("/api/mcp", content=body, headers={"Content-Type": content_type})
        assert refused_response.status_code == 415, content_type
    accepted = await async_client.post("/api/mcp", content=body, headers={"Content-Type": "application/json; charset=utf-8"})
    assert accepted.status_code == 200
