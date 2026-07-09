import pytest

from app.models.cloud import CloudBackendLink
from app.utils import cloud_link


PROVIDER = "https://cloud.frameos.net"

START_RESPONSE = {
    "device_code": "device-code-1",
    "user_code": "ABCD-1234",
    "verification_uri": f"{PROVIDER}/device",
    "verification_uri_complete": f"{PROVIDER}/device?code=ABCD-1234",
    "expires_in": 600,
    "interval": 5,
}

POLL_SUCCESS = {
    "access_token": "link-token-secret",
    "approved_by": {
        "account_id": "acc-1",
        "email": "owner@example.com",
        "email_verified": True,
        "name": "Owner",
        "provider_issuer": PROVIDER,
        "provider_subject": "subject-1",
        "sub": "subject-1",
    },
    "linked_client_id": "lc-1",
    "scope": "backend:link backend:read",
    "token_reference": "tokref-1",
    "token_type": "Bearer",
}

GRANTS_RESPONSE = {
    "grants": [{"account_id": "acc-1", "account_email": "owner@example.com", "role": "owner"}],
    "linked_client_id": "lc-1",
}


@pytest.fixture
def cloud_calls(monkeypatch):
    calls = {"start": [], "poll": [], "inventory": [], "grants": [], "unlink": []}
    responses = {
        "start": (200, START_RESPONSE),
        "poll": (428, {"error": "authorization_pending", "interval": 5}),
        "inventory": (200, {"status": "ok"}),
        "grants": (200, GRANTS_RESPONSE),
        "unlink": (200, {"status": "unlinked"}),
    }

    def make(name):
        async def call(*args, **kwargs):
            calls[name].append((args, kwargs))
            result = responses[name]
            if isinstance(result, Exception):
                raise result
            return result
        return call

    monkeypatch.setattr(cloud_link, "device_start", make("start"))
    monkeypatch.setattr(cloud_link, "device_poll", make("poll"))
    monkeypatch.setattr(cloud_link, "backend_inventory", make("inventory"))
    monkeypatch.setattr(cloud_link, "backend_grants", make("grants"))
    monkeypatch.setattr(cloud_link, "backend_unlink", make("unlink"))
    return calls, responses


@pytest.mark.asyncio
async def test_status_defaults_to_disconnected(async_client):
    response = await async_client.get("/api/cloud/status")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "disconnected"
    assert data["enabled"] is True
    assert data["provider_url"] == PROVIDER
    assert data["can_edit_provider"] is True
    assert data["link"] is None
    assert data["connection"] is None


@pytest.mark.asyncio
async def test_status_requires_login(db):
    from httpx import AsyncClient
    from httpx._transports.asgi import ASGITransport
    from app.fastapi import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/api/cloud/status")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_set_provider_url(async_client):
    response = await async_client.post("/api/cloud/provider", json={"provider_url": "https://my.cloud.example/"})
    assert response.status_code == 200
    assert response.json()["provider_url"] == "https://my.cloud.example"

    response = await async_client.post("/api/cloud/provider", json={"provider_url": "not a url"})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_connect_starts_device_flow(async_client, cloud_calls):
    calls, _ = cloud_calls
    response = await async_client.post("/api/cloud/connect", json={})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "connecting"
    assert data["connection"]["user_code"] == "ABCD-1234"
    assert data["connection"]["verification_uri_complete"] == f"{PROVIDER}/device?code=ABCD-1234"
    assert data["can_edit_provider"] is False

    (args, _kwargs) = calls["start"][0]
    provider_url, payload = args
    assert provider_url == PROVIDER
    assert payload["scopes"] == ["backend:link", "backend:read"]
    assert payload["local_origin"].startswith("http://")


@pytest.mark.asyncio
async def test_connect_filters_unknown_scopes(async_client, cloud_calls):
    calls, _ = cloud_calls
    response = await async_client.post(
        "/api/cloud/connect", json={"scopes": ["backend:link", "evil:scope", "auth:login"]}
    )
    assert response.status_code == 200
    (args, _kwargs) = calls["start"][0]
    assert args[1]["scopes"] == ["backend:link", "auth:login"]


@pytest.mark.asyncio
async def test_poll_pending_then_connected(async_client, cloud_calls, db):
    _calls, responses = cloud_calls
    await async_client.post("/api/cloud/connect", json={})

    response = await async_client.post("/api/cloud/poll")
    assert response.json()["status"] == "connecting"

    responses["poll"] = (200, POLL_SUCCESS)
    response = await async_client.post("/api/cloud/poll")
    data = response.json()
    assert data["status"] == "connected"
    assert data["link"]["linked_client_id"] == "lc-1"
    assert data["link"]["scopes"] == ["backend:link", "backend:read"]
    assert data["link"]["account_email"] == "owner@example.com"
    assert data["connection"] is None
    assert "access_token" not in str(data)

    link = db.query(CloudBackendLink).first()
    assert link.access_token is not None
    assert "link-token-secret" not in link.access_token
    assert cloud_link.decrypt_cloud_secret(link.access_token) == "link-token-secret"
    assert link.device_code is None


@pytest.mark.asyncio
async def test_poll_auto_links_identity_of_approver(async_client, cloud_calls, db):
    """The cloud account that approved the link is the person connecting, so
    the identity mapping is created without a separate handoff."""
    from app.models.cloud import CloudIdentity
    from app.models.user import User

    _calls, responses = cloud_calls
    await async_client.post("/api/cloud/connect", json={})
    responses["poll"] = (200, POLL_SUCCESS)
    response = await async_client.post("/api/cloud/poll")
    data = response.json()
    assert data["identity"]["email"] == "owner@example.com"

    identity = db.query(CloudIdentity).first()
    user = db.query(User).filter_by(email="test@example.com").first()
    assert identity is not None
    assert identity.user_id == user.id
    assert identity.provider_subject == "subject-1"
    assert identity.cloud_account_id == "acc-1"


@pytest.mark.asyncio
async def test_poll_never_steals_an_existing_identity(async_client, cloud_calls, db):
    from app.models.cloud import CloudIdentity
    from app.models.user import User

    other = User(email="other@example.com")
    other.set_password("password123")
    db.add(other)
    db.commit()
    db.add(
        CloudIdentity(
            user_id=other.id,
            provider_url=PROVIDER,
            provider_issuer=PROVIDER,
            provider_subject="subject-1",
            cloud_account_id="acc-1",
        )
    )
    db.commit()

    _calls, responses = cloud_calls
    await async_client.post("/api/cloud/connect", json={})
    responses["poll"] = (200, POLL_SUCCESS)
    response = await async_client.post("/api/cloud/poll")
    assert response.json()["status"] == "connected"

    identity = db.query(CloudIdentity).first()
    assert identity.user_id == other.id  # unchanged
    assert db.query(CloudIdentity).count() == 1


@pytest.mark.asyncio
async def test_poll_denied_resets_link(async_client, cloud_calls):
    _calls, responses = cloud_calls
    await async_client.post("/api/cloud/connect", json={})
    responses["poll"] = (403, {"error": "access_denied"})
    response = await async_client.post("/api/cloud/poll")
    data = response.json()
    assert data["status"] == "disconnected"
    assert data["poll_error"] == "access_denied"


@pytest.mark.asyncio
async def test_disconnect_unlinks_and_resets(async_client, cloud_calls, db):
    calls, responses = cloud_calls
    await async_client.post("/api/cloud/connect", json={})
    responses["poll"] = (200, POLL_SUCCESS)
    await async_client.post("/api/cloud/poll")

    response = await async_client.post("/api/cloud/disconnect")
    data = response.json()
    assert data["status"] == "disconnected"
    assert len(calls["unlink"]) == 1
    (args, kwargs) = calls["unlink"][0]
    assert args == (PROVIDER, "link-token-secret")

    link = db.query(CloudBackendLink).first()
    assert link.access_token is None
    assert link.linked_client_id is None


@pytest.mark.asyncio
async def test_cannot_change_provider_while_connecting(async_client, cloud_calls):
    await async_client.post("/api/cloud/connect", json={})
    response = await async_client.post("/api/cloud/provider", json={"provider_url": "https://other.example"})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_connect_unreachable_provider(async_client, cloud_calls, monkeypatch):
    async def boom(*_args, **_kwargs):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(cloud_link, "device_start", boom)
    response = await async_client.post("/api/cloud/connect", json={})
    assert response.status_code == 502
