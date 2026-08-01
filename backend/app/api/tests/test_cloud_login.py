"""Cloud login (Phase 1): login handoff, identity linking, first-run setup,
and the local password fallback guard."""
import json

import pytest

from app.models.cloud import CloudBackendLink, CloudIdentity
from app.models.user import User
from app.utils import cloud_link

PROVIDER = "https://cloud.frameos.net"
ISSUER = "https://cloud.frameos.net"

CLAIMS = {
    "account_id": "acc-1",
    "email": "owner@example.com",
    "email_verified": True,
    "name": "Owner",
    "provider_subject": "subject-1",
    "sub": "subject-1",
}


def make_connected_link(db, scope="backend:link backend:read auth:login", local_origin="http://test"):
    link = CloudBackendLink(
        provider_url=PROVIDER,
        status="connected",
        access_token=cloud_link.encrypt_cloud_secret("link-token-secret"),
        linked_client_id="lc-1",
        token_reference="tokref-1",
        scope=scope,
        local_origin=local_origin,
        cloud_account_id="acc-1",
        cloud_account_email="owner@example.com",
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@pytest.fixture
def login_handoff(monkeypatch):
    """Fake provider for the login handoff; records the start payloads."""
    calls = {"start": [], "token": []}
    responses = {
        "start": (200, {"authorization_url": f"{PROVIDER}/api/frameos/login/authorize?request=jwt", "expires_in": 600}),
        "token": (200, {"claims": dict(CLAIMS), "provider_issuer": ISSUER}),
    }

    async def fake_start(provider_url, access_token, payload):
        calls["start"].append((provider_url, access_token, payload))
        return responses["start"]

    async def fake_token(provider_url, access_token, code):
        calls["token"].append((provider_url, access_token, code))
        return responses["token"]

    monkeypatch.setattr(cloud_link, "frameos_login_start", fake_start)
    monkeypatch.setattr(cloud_link, "frameos_login_token", fake_token)
    return calls, responses


@pytest.mark.asyncio
async def test_login_options_without_link(async_client):
    response = await async_client.get("/api/cloud/login/options")
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False
    assert data["local_login_enabled"] is True
    assert data["setup_mode"] is False


@pytest.mark.asyncio
async def test_login_options_with_auth_scope(async_client, db):
    make_connected_link(db)
    response = await async_client.get("/api/cloud/login/options")
    data = response.json()
    assert data["available"] is True
    assert data["provider_url"] == PROVIDER


@pytest.mark.asyncio
async def test_login_start_requires_scope(async_client, db):
    make_connected_link(db, scope="backend:link backend:read")
    response = await async_client.post("/api/cloud/login/start", json={})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_login_start_requires_link(async_client):
    response = await async_client.post("/api/cloud/login/start", json={})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_login_start_returns_authorization_url(async_client, db, redis, login_handoff):
    calls, _ = login_handoff
    make_connected_link(db)
    response = await async_client.post("/api/cloud/login/start", json={"next": "/frames"})
    assert response.status_code == 200
    assert response.json()["authorization_url"].startswith(PROVIDER)

    provider_url, access_token, payload = calls["start"][0]
    assert provider_url == PROVIDER
    assert access_token == "link-token-secret"
    assert payload["redirect_uri"] == "http://test/api/cloud/login/callback"
    assert payload["intent"] == "login"
    assert payload["state"]


async def _start_and_get_state(async_client, calls, next_path=None, path="/api/cloud/login/start"):
    response = await async_client.post(path, json={"next": next_path} if next_path else {})
    assert response.status_code == 200, response.text
    return calls["start"][-1][2]["state"]


@pytest.mark.asyncio
async def test_login_callback_unknown_identity_is_rejected(async_client, db, redis, login_handoff):
    calls, _ = login_handoff
    make_connected_link(db)
    state = await _start_and_get_state(async_client, calls)

    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "/login?cloudError=not_linked"
    # Email match alone must never log anyone in or create a second user.
    assert db.query(User).count() == 1


@pytest.mark.asyncio
async def test_login_callback_returns_to_dev_origin(async_client, db, redis, login_handoff):
    """In dev the UI (e.g. Vite on :8616) proxies to the backend: the callback
    must send the browser back to the origin it started from, not the link's
    registered origin."""
    calls, _ = login_handoff
    make_connected_link(db)

    # Link the identity first so the login succeeds.
    state = await _start_and_get_state(async_client, calls, path="/api/cloud/identity/link")
    await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")

    response = await async_client.post(
        "/api/cloud/login/start",
        json={"next": "/frames"},
        headers={"origin": "http://localhost:8616"},
    )
    assert response.status_code == 200
    state = calls["start"][-1][2]["state"]

    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "http://localhost:8616/frames"
    assert "frameos_session" in response.headers.get("set-cookie", "")

    # A non-loopback origin that is not the link's own is never used.
    response = await async_client.post(
        "/api/cloud/login/start",
        json={},
        headers={"origin": "https://evil.example"},
    )
    state = calls["start"][-1][2]["state"]
    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "/"


@pytest.mark.asyncio
async def test_login_callback_invalid_state(async_client, db, login_handoff):
    make_connected_link(db)
    response = await async_client.get("/api/cloud/login/callback?code=abc&state=bogus")
    assert response.status_code == 303
    assert response.headers["location"] == "/login?cloudError=invalid_state"


@pytest.mark.asyncio
async def test_identity_link_then_cloud_login(async_client, db, redis, login_handoff):
    calls, _ = login_handoff
    make_connected_link(db)

    # 1. The logged-in user explicitly links their cloud account.
    state = await _start_and_get_state(async_client, calls, path="/api/cloud/identity/link")
    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "/settings"

    identity = db.query(CloudIdentity).first()
    assert identity is not None
    assert identity.provider_issuer == ISSUER
    assert identity.provider_subject == "subject-1"
    assert identity.cloud_account_id == "acc-1"
    user = db.query(User).filter_by(email="test@example.com").first()
    assert identity.user_id == user.id

    # Status now reports the identity.
    status = (await async_client.get("/api/cloud/status")).json()
    assert status["identity"]["email"] == "owner@example.com"

    # 2. A later cloud login signs that user in with a session cookie.
    state = await _start_and_get_state(async_client, calls, next_path="/frames")
    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "/frames"
    assert "frameos_session" in response.headers.get("set-cookie", "")


@pytest.mark.asyncio
async def test_login_matches_identity_by_account_id(async_client, db, redis, login_handoff):
    """The same cloud account signing in through another method (different
    issuer/subject) still finds the identity via the stable account id."""
    calls, _ = login_handoff
    make_connected_link(db)
    user = db.query(User).filter_by(email="test@example.com").first()
    db.add(
        CloudIdentity(
            user_id=user.id,
            provider_url=PROVIDER,
            provider_issuer="https://accounts.google.com",
            provider_subject="google-subject-999",
            cloud_account_id="acc-1",
        )
    )
    db.commit()

    # The handoff claims carry subject-1 (password identity) but the same acc-1.
    state = await _start_and_get_state(async_client, calls)
    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "/"
    assert "frameos_session" in response.headers.get("set-cookie", "")


@pytest.mark.asyncio
async def test_identity_link_conflict(async_client, db, redis, login_handoff):
    calls, _ = login_handoff
    make_connected_link(db)
    other = User(email="other@example.com")
    other.set_password("password123")
    db.add(other)
    db.commit()
    identity = CloudIdentity(
        user_id=other.id,
        provider_url=PROVIDER,
        provider_issuer=ISSUER,
        provider_subject="subject-1",
        cloud_account_id="acc-1",
    )
    db.add(identity)
    db.commit()

    state = await _start_and_get_state(async_client, calls, path="/api/cloud/identity/link")
    response = await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert "identity_in_use" in response.headers["location"]


@pytest.mark.asyncio
async def test_setup_mode_creates_first_user(no_auth_client, db, redis, login_handoff):
    calls, _ = login_handoff
    make_connected_link(db)

    options = (await no_auth_client.get("/api/cloud/login/options")).json()
    assert options["setup_mode"] is True
    assert options["available"] is True

    response = await no_auth_client.post("/api/cloud/login/start", json={})
    assert response.status_code == 200
    state = calls["start"][0][2]["state"]
    assert calls["start"][0][2]["intent"] == "signup"

    response = await no_auth_client.get(f"/api/cloud/login/callback?code=abc&state={state}")
    assert response.status_code == 303
    assert response.headers["location"] == "/"
    assert "frameos_session" in response.headers.get("set-cookie", "")

    user = db.query(User).first()
    assert user is not None
    assert user.email == "owner@example.com"
    assert user.password is None  # cloud-only user, no local password
    identity = db.query(CloudIdentity).first()
    assert identity.user_id == user.id

    # The cookie authenticates follow-up requests.
    me = await no_auth_client.get("/api/user")
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"

    # Password login for that user fails cleanly (no crash on empty hash).
    login = await no_auth_client.post(
        "/api/login", data={"username": "owner@example.com", "password": "whatever123"}
    )
    assert login.status_code == 401


@pytest.mark.asyncio
async def test_setup_endpoints_forbidden_after_first_user(async_client):
    for path in ("/api/cloud/setup/status",):
        response = await async_client.get(path)
        assert response.status_code == 403
    response = await async_client.post("/api/cloud/setup/connect", json={})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_setup_connect_flow_without_login(no_auth_client, db, monkeypatch):
    async def fake_start(provider_url, payload):
        return (
            200,
            {
                "device_code": "device-code-1",
                "user_code": "ABCD-1234",
                "verification_uri": f"{PROVIDER}/device",
                "verification_uri_complete": f"{PROVIDER}/device?code=ABCD-1234",
                "expires_in": 600,
                "interval": 5,
            },
        )

    monkeypatch.setattr(cloud_link, "device_start", fake_start)
    response = await no_auth_client.get("/api/cloud/setup/status")
    assert response.status_code == 200
    assert response.json()["status"] == "disconnected"

    response = await no_auth_client.post(
        "/api/cloud/setup/connect", json={"scopes": ["backend:link", "backend:read", "auth:login"]}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "connecting"
    assert response.json()["connection"]["user_code"] == "ABCD-1234"


@pytest.mark.asyncio
async def test_local_fallback_disable_and_login_guard(async_client, db, redis, login_handoff, monkeypatch):
    calls, _ = login_handoff
    link = make_connected_link(db)

    # Cannot disable before the user has linked the owning cloud account.
    response = await async_client.post("/api/cloud/local-fallback", json={"enabled": False})
    assert response.status_code == 409

    # Link the identity through the handoff.
    state = await _start_and_get_state(async_client, calls, path="/api/cloud/identity/link")
    await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")

    async def fake_grants(provider_url, access_token):
        return 200, {"grants": [{"account_id": "acc-1", "role": "owner"}]}

    monkeypatch.setattr(cloud_link, "backend_grants", fake_grants)

    response = await async_client.post("/api/cloud/local-fallback", json={"enabled": False})
    assert response.status_code == 200, response.text
    assert response.json()["local_fallback_enabled"] is False

    # Password login is now rejected with a clear error.
    login = await async_client.post(
        "/api/login", data={"username": "test@example.com", "password": "testpassword"}
    )
    assert login.status_code == 403
    assert "FrameOS Cloud" in login.json()["detail"]

    # Unlinking the identity while passwords are disabled would lock the user out.
    response = await async_client.post("/api/cloud/identity/unlink")
    assert response.status_code == 409

    # Re-enable and everything works again.
    response = await async_client.post("/api/cloud/local-fallback", json={"enabled": True})
    assert response.json()["local_fallback_enabled"] is True
    login = await async_client.post(
        "/api/login", data={"username": "test@example.com", "password": "testpassword"}
    )
    assert login.status_code == 200


@pytest.mark.asyncio
async def test_local_fallback_disable_requires_live_link(async_client, db, redis, login_handoff, monkeypatch):
    calls, _ = login_handoff
    make_connected_link(db)
    state = await _start_and_get_state(async_client, calls, path="/api/cloud/identity/link")
    await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")

    async def dead_grants(provider_url, access_token):
        return 401, {"error": "invalid_link_token"}

    monkeypatch.setattr(cloud_link, "backend_grants", dead_grants)
    response = await async_client.post("/api/cloud/local-fallback", json={"enabled": False})
    assert response.status_code == 502

    status = (await async_client.get("/api/cloud/status")).json()
    assert status["local_fallback_enabled"] is True


@pytest.mark.asyncio
async def test_local_fallback_uses_identity_for_active_provider(async_client, db, monkeypatch):
    link = make_connected_link(db)
    user = db.query(User).filter_by(email="test@example.com").first()
    db.add(
        CloudIdentity(
            user_id=user.id,
            provider_url=PROVIDER,
            provider_issuer=ISSUER,
            provider_subject="active-provider-subject",
            cloud_account_id="acc-1",
        )
    )
    db.flush()
    db.add(
        CloudIdentity(
            user_id=user.id,
            provider_url="https://other-cloud.example",
            provider_issuer="https://other-cloud.example",
            provider_subject="newer-other-provider-subject",
            cloud_account_id="other-account",
        )
    )
    db.commit()

    async def fake_grants(provider_url, access_token):
        assert provider_url == link.provider_url
        return 200, {"grants": [{"account_id": "acc-1", "role": "owner"}]}

    monkeypatch.setattr(cloud_link, "backend_grants", fake_grants)
    response = await async_client.post("/api/cloud/local-fallback", json={"enabled": False})

    assert response.status_code == 200, response.text
    assert response.json()["local_fallback_enabled"] is False


@pytest.mark.asyncio
async def test_disconnect_reenables_local_fallback(async_client, db, redis, login_handoff, monkeypatch):
    calls, _ = login_handoff
    link = make_connected_link(db)
    state = await _start_and_get_state(async_client, calls, path="/api/cloud/identity/link")
    await async_client.get(f"/api/cloud/login/callback?code=abc&state={state}")

    async def fake_grants(provider_url, access_token):
        return 200, {"grants": [{"account_id": "acc-1", "role": "owner"}]}

    async def fake_unlink(provider_url, access_token):
        return 200, {"status": "unlinked"}

    monkeypatch.setattr(cloud_link, "backend_grants", fake_grants)
    monkeypatch.setattr(cloud_link, "backend_unlink", fake_unlink)
    await async_client.post("/api/cloud/local-fallback", json={"enabled": False})

    response = await async_client.post("/api/cloud/disconnect")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "disconnected"
    assert data["local_fallback_enabled"] is True

    login = await async_client.post(
        "/api/login", data={"username": "test@example.com", "password": "testpassword"}
    )
    assert login.status_code == 200
