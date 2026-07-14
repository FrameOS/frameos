"""In-place feature (scope) changes and the cloud logout handoff."""
import pytest

from app.models.cloud import CloudBackendLink, CloudIdentity
from app.utils import cloud_link

PROVIDER = "https://cloud.frameos.net"


def make_connected_link(db, scope="backend:link backend:read auth:login", local_origin="http://test"):
    link = CloudBackendLink(
        provider_url=PROVIDER,
        status="connected",
        access_token=cloud_link.encrypt_cloud_secret("link-token-secret"),
        linked_client_id="lc-1",
        scope=scope,
        local_origin=local_origin,
        cloud_account_id="acc-1",
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@pytest.fixture
def scope_calls(monkeypatch):
    calls = {"set_scopes": [], "poll": []}
    responses = {
        "set_scopes": (
            200,
            {
                "status": "updated",
                "scope": "backend:link backend:read backup:scenes backup:frames store:publish",
                "linked_client_id": "lc-1",
            },
        ),
        "poll": (428, {"error": "authorization_pending", "interval": 5}),
    }

    async def fake_set_scopes(provider_url, access_token, scopes):
        calls["set_scopes"].append((provider_url, access_token, scopes))
        return responses["set_scopes"]

    async def fake_poll(provider_url, device_code):
        calls["poll"].append((provider_url, device_code))
        return responses["poll"]

    monkeypatch.setattr(cloud_link, "backend_set_scopes", fake_set_scopes)
    monkeypatch.setattr(cloud_link, "device_poll", fake_poll)
    return calls, responses


@pytest.mark.asyncio
async def test_features_requires_link(async_client):
    response = await async_client.post("/api/cloud/features", json={"scopes": ["auth:login"]})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_feature_removal_applies_immediately(async_client, db, scope_calls):
    calls, _ = scope_calls
    link = make_connected_link(db)
    link.local_fallback_enabled = False
    db.commit()

    response = await async_client.post("/api/cloud/features", json={"scopes": []})
    assert response.status_code == 200, response.text
    data = response.json()
    # auth:login is dropped; the included features are always kept on the link
    assert data["link"]["scopes"] == [
        "backend:link",
        "backend:read",
        "backup:scenes",
        "backup:frames",
        "store:publish",
    ]
    assert data["local_fallback_enabled"] is True
    assert data.get("upgrade") is None

    db.refresh(link)
    assert link.local_fallback_enabled is True

    _url, token, scopes = calls["set_scopes"][0]
    assert token == "link-token-secret"
    assert scopes == ["backend:link", "backend:read", "backup:scenes", "backup:frames", "store:publish"]


@pytest.mark.asyncio
async def test_feature_addition_needs_approval_then_polls(async_client, db, scope_calls):
    calls, responses = scope_calls
    make_connected_link(db, scope="backend:link backend:read")
    responses["set_scopes"] = (
        200,
        {
            "status": "approval_required",
            "device_code": "upgrade-device-1",
            "user_code": "WXYZ-1234",
            "verification_uri": f"{PROVIDER}/device",
            "verification_uri_complete": f"{PROVIDER}/device?user_code=WXYZ-1234",
            "expires_in": 600,
            "interval": 5,
            "scope": "backend:link backend:read auth:login",
        },
    )

    response = await async_client.post("/api/cloud/features", json={"scopes": ["auth:login"]})
    assert response.status_code == 200, response.text
    # the included features ride along with the security-scope request
    assert calls["set_scopes"][0][2] == [
        "backend:link",
        "backend:read",
        "auth:login",
        "backup:scenes",
        "backup:frames",
        "store:publish",
    ]
    data = response.json()
    assert data["status"] == "connected"  # the link never drops
    assert data["upgrade"]["user_code"] == "WXYZ-1234"
    # the old scopes stay granted until approval
    assert data["link"]["scopes"] == ["backend:link", "backend:read"]

    # A second change while one is pending is rejected.
    response = await async_client.post("/api/cloud/features", json={"scopes": []})
    assert response.status_code == 409

    # Pending poll keeps the upgrade block.
    response = await async_client.post("/api/cloud/poll")
    assert response.json()["upgrade"]["user_code"] == "WXYZ-1234"
    assert calls["poll"][0][1] == "upgrade-device-1"

    # Approval: poll returns the new scope set but no token.
    responses["poll"] = (
        200,
        {"status": "approved", "scope": "backend:link backend:read auth:login", "linked_client_id": "lc-1"},
    )
    response = await async_client.post("/api/cloud/poll")
    data = response.json()
    assert data.get("upgrade") is None
    assert data["link"]["scopes"] == ["backend:link", "backend:read", "auth:login"]
    assert data["status"] == "connected"

    link = db.query(CloudBackendLink).first()
    assert link.device_code is None
    # the token was never replaced
    assert cloud_link.decrypt_cloud_secret(link.access_token) == "link-token-secret"


@pytest.mark.asyncio
async def test_feature_denial_keeps_link(async_client, db, scope_calls):
    calls, responses = scope_calls
    make_connected_link(db, scope="backend:link backend:read")
    responses["set_scopes"] = (
        200,
        {
            "status": "approval_required",
            "device_code": "upgrade-device-2",
            "user_code": "WXYZ-5678",
            "expires_in": 600,
            "interval": 5,
        },
    )
    await async_client.post("/api/cloud/features", json={"scopes": ["auth:login"]})

    responses["poll"] = (403, {"error": "access_denied"})
    response = await async_client.post("/api/cloud/poll")
    data = response.json()
    assert data["status"] == "connected"
    assert data.get("upgrade") is None
    assert data["poll_error"] == "access_denied"
    assert data["link"]["scopes"] == ["backend:link", "backend:read"]


@pytest.mark.asyncio
async def test_feature_change_cancel(async_client, db, scope_calls):
    _calls, responses = scope_calls
    make_connected_link(db, scope="backend:link backend:read")
    responses["set_scopes"] = (
        200,
        {
            "status": "approval_required",
            "device_code": "upgrade-device-3",
            "user_code": "WXYZ-9999",
            "expires_in": 600,
            "interval": 5,
        },
    )
    await async_client.post("/api/cloud/features", json={"scopes": ["auth:login"]})

    response = await async_client.post("/api/cloud/features/cancel")
    data = response.json()
    assert data.get("upgrade") is None
    assert data["status"] == "connected"


@pytest.mark.asyncio
async def test_logout_returns_cloud_logout_url_for_cloud_users(async_client, db):
    link = make_connected_link(db)
    from app.models.user import User

    user = db.query(User).filter_by(email="test@example.com").first()
    db.add(
        CloudIdentity(
            user_id=user.id,
            provider_url=PROVIDER,
            provider_issuer=PROVIDER,
            provider_subject="subject-1",
            cloud_account_id="acc-1",
        )
    )
    db.commit()

    response = await async_client.post("/api/logout")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["cloud_logout_url"].startswith(f"{PROVIDER}/logout?return_to=")
    assert "%2Flogin" in data["cloud_logout_url"]


@pytest.mark.asyncio
async def test_logout_without_cloud_identity_has_no_cloud_url(async_client, db):
    make_connected_link(db)
    response = await async_client.post("/api/logout")
    assert response.status_code == 200
    assert response.json()["cloud_logout_url"] is None
