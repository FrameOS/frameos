import datetime
from urllib.parse import parse_qs, urlparse

import pytest

from app import config as app_config
from app.api import cloud_auth as cloud_auth_api
from app.config import normalize_frameos_auth_provider_url
from app.models.cloud_auth import CloudBackendLink, CloudIdentity, CloudMembership
from app.models.organization import OrganizationMember
from app.models.user import User
from app.utils import cloud_auth as cloud_auth_utils
from app.utils.cloud_auth import OidcDiscovery, encrypt_cloud_secret


def discovery() -> OidcDiscovery:
    return OidcDiscovery(
        issuer="https://auth.example.test",
        authorization_endpoint="https://auth.example.test/oauth/authorize",
        token_endpoint="https://auth.example.test/oauth/token",
        jwks_uri="https://auth.example.test/oauth/keys",
    )


def test_normalize_frameos_auth_provider_url():
    assert normalize_frameos_auth_provider_url(None) == {
        "disabled": False,
        "provider_url": "https://auth.frameos.net",
    }
    assert normalize_frameos_auth_provider_url(" disabled ") == {"disabled": True, "provider_url": None}
    assert normalize_frameos_auth_provider_url("https://auth.example.test/path/?x=1#hash") == {
        "disabled": False,
        "provider_url": "https://auth.example.test/path",
    }


@pytest.mark.asyncio
async def test_discover_oidc_provider_falls_back_to_oidc_path(monkeypatch):
    calls = []

    async def fake_request_json(method, url, **_kwargs):
        calls.append((method, url))
        if url == "https://auth.example.test/.well-known/openid-configuration":
            return 404, {}
        if url == "https://auth.example.test/oidc/.well-known/openid-configuration":
            return 200, {
                "issuer": "https://auth.example.test/oidc",
                "authorization_endpoint": "https://auth.example.test/oidc/auth",
                "token_endpoint": "https://auth.example.test/oidc/token",
                "jwks_uri": "https://auth.example.test/oidc/jwks",
            }
        raise AssertionError(f"Unexpected discovery URL: {url}")

    cloud_auth_utils._OIDC_DISCOVERY_CACHE.clear()
    monkeypatch.setattr(cloud_auth_utils, "_request_json", fake_request_json)

    discovered = await cloud_auth_utils.discover_oidc_provider("https://auth.example.test")

    assert discovered.issuer == "https://auth.example.test/oidc"
    assert calls == [
        ("GET", "https://auth.example.test/.well-known/openid-configuration"),
        ("GET", "https://auth.example.test/oidc/.well-known/openid-configuration"),
    ]


@pytest.mark.asyncio
async def test_public_cloud_auth_status_default(no_auth_client):
    response = await no_auth_client.get("/api/cloud-auth/status")

    assert response.status_code == 200
    assert response.json() == {
        "provider_enabled": True,
        "provider_url": "https://auth.frameos.net",
        "status": "disconnected",
        "local_fallback_enabled": True,
    }


@pytest.mark.asyncio
async def test_public_cloud_auth_status_disabled(no_auth_client, monkeypatch):
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_DISABLED", True)
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_URL", None)

    response = await no_auth_client.get("/api/cloud-auth/status")

    assert response.status_code == 200
    assert response.json()["provider_enabled"] is False
    assert response.json()["status"] == "provider_disabled"


@pytest.mark.asyncio
async def test_backend_device_link_start_poll_syncs_inventory_and_grants(async_client, db, monkeypatch):
    calls = []

    async def fake_discover(_provider_url, _http_client=None):
        raise AssertionError("Backend device linking should not run OIDC discovery")

    async def fake_provider_json_request(method, provider_url, path, **kwargs):
        calls.append((method, provider_url, path, kwargs.get("json_body")))
        if path == "/api/device/start":
            return 200, {
                "device_code": "device-code",
                "expires_in": 600,
                "interval": 3,
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://auth.example.test/device",
                "verification_uri_complete": "https://auth.example.test/device?user_code=ABCD-EFGH",
            }
        if path == "/api/device/poll":
            return 200, {
                "access_token": "link-token",
                "linked_client_id": "linked-client",
                "organization_id": "cloud-org",
                "project_id": "cloud-project",
                "scope": "backend:link backend:read project:read",
                "token_reference": "tok_ref",
                "token_type": "Bearer",
            }
        if path == "/api/backends/inventory":
            return 200, {"synced_frames": 0}
        if path == "/api/backends/grants":
            return 200, {
                "memberships": [
                    {
                        "account_id": "cloud-account",
                        "organization_id": "cloud-org",
                        "project_id": "cloud-project",
                        "role": "owner",
                        "updated_at": "2026-06-07T00:00:00Z",
                    }
                ]
            }
        raise AssertionError(f"Unexpected cloud API call: {method} {path}")

    monkeypatch.setattr(cloud_auth_api, "discover_oidc_provider", fake_discover)
    monkeypatch.setattr(cloud_auth_api, "provider_json_request", fake_provider_json_request)
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_URL", "https://auth.example.test")
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_DISABLED", False)

    start_response = await async_client.post(f"/api/projects/{async_client.project_id}/cloud-auth/backend-link/start")

    assert start_response.status_code == 200
    assert start_response.json()["status"] == "connecting"
    assert start_response.json()["link"]["user_code"] == "ABCD-EFGH"

    poll_response = await async_client.post(f"/api/projects/{async_client.project_id}/cloud-auth/backend-link/poll")

    assert poll_response.status_code == 200
    payload = poll_response.json()
    assert payload["status"] == "connected"
    assert payload["link"]["token_reference"] == "tok_ref"
    assert payload["link"]["cloud_organization_id"] == "cloud-org"
    assert payload["memberships"][0]["cloud_account_id"] == "cloud-account"
    assert [call[2] for call in calls] == [
        "/api/device/start",
        "/api/device/poll",
        "/api/backends/inventory",
        "/api/backends/grants",
    ]


@pytest.mark.asyncio
async def test_local_fallback_disabled_rejects_password_login(no_auth_client, db, redis):
    user = User(email="local@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.add(
        CloudBackendLink(
            provider_url="https://auth.example.test",
            status="connected",
            local_fallback_enabled=False,
        )
    )
    db.commit()

    response = await no_auth_client.post("/api/login", data={"username": "local@example.com", "password": "testpassword"})

    assert response.status_code == 401
    assert response.json()["detail"] == "Local login is disabled. Continue with FrameOS Cloud Auth."


@pytest.mark.asyncio
async def test_disabling_local_fallback_requires_cloud_owner_admin(async_client, db):
    link = CloudBackendLink(
        provider_url="https://auth.example.test",
        status="connected",
        cloud_organization_id="cloud-org",
        cloud_project_id="cloud-project",
        local_project_id=async_client.project_id,
        local_fallback_enabled=True,
    )
    db.add(link)
    db.commit()
    db.refresh(link)

    denied = await async_client.post(
        f"/api/projects/{async_client.project_id}/cloud-auth/local-fallback",
        json={"enabled": False},
    )

    assert denied.status_code == 403

    user = db.query(User).filter(User.email == "test@example.com").one()
    identity = CloudIdentity(
        user_id=user.id,
        provider_url="https://auth.example.test",
        provider_issuer="https://auth.example.test",
        provider_subject="subject",
        cloud_account_id="cloud-account",
        email="test@example.com",
        email_verified=True,
        last_login_at=datetime.datetime.utcnow(),
    )
    db.add(identity)
    db.add(
        CloudMembership(
            backend_link_id=link.id,
            cloud_account_id="cloud-account",
            cloud_organization_id="cloud-org",
            cloud_project_id="cloud-project",
            role="owner",
            local_project_id=async_client.project_id,
            local_organization_id=db.query(OrganizationMember).filter_by(user_id=user.id).first().organization_id,
        )
    )
    db.commit()

    allowed = await async_client.post(
        f"/api/projects/{async_client.project_id}/cloud-auth/local-fallback",
        json={"enabled": False},
    )

    assert allowed.status_code == 200
    assert allowed.json()["local_fallback_enabled"] is False


@pytest.mark.asyncio
async def test_cloud_oidc_callback_creates_local_cloud_user(no_auth_client, db, monkeypatch):
    db.query(User).delete()
    db.commit()

    async def fake_discover(_provider_url, _http_client=None):
        return discovery()

    async def fake_exchange(*_args, **_kwargs):
        return {"id_token": "id-token", "token_type": "Bearer"}

    async def fake_verify(*_args, **_kwargs):
        return {
            "sub": "cloud-subject",
            "email": "cloud@example.com",
            "email_verified": True,
            "name": "Cloud User",
            "account_id": "cloud-account",
        }

    monkeypatch.setattr(cloud_auth_api, "discover_oidc_provider", fake_discover)
    monkeypatch.setattr(cloud_auth_api, "exchange_authorization_code", fake_exchange)
    monkeypatch.setattr(cloud_auth_api, "verify_oidc_id_token", fake_verify)
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_URL", "https://auth.example.test")
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_DISABLED", False)

    start = await no_auth_client.get("/api/cloud-auth/login", follow_redirects=False)
    assert start.status_code == 302
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    callback = await no_auth_client.get(f"/api/cloud-auth/callback?code=code&state={state}", follow_redirects=False)

    assert callback.status_code == 302
    assert "frameos_session" in callback.headers.get("set-cookie", "")
    user = db.query(User).filter(User.email == "cloud@example.com").one()
    identity = db.query(CloudIdentity).filter(CloudIdentity.user_id == user.id).one()
    assert identity.provider_subject == "cloud-subject"
    assert identity.cloud_account_id == "cloud-account"


@pytest.mark.asyncio
async def test_cloud_login_uses_broker_when_provider_is_cloud_app(no_auth_client, db, default_project, monkeypatch):
    db.query(User).filter(User.email == "broker@example.com").delete()
    link = CloudBackendLink(
        provider_url="http://localhost:3000",
        status="connected",
        access_token=encrypt_cloud_secret("link-token"),
        cloud_organization_id="cloud-org",
        cloud_project_id="cloud-project",
        local_organization_id=default_project.organization_id,
        local_project_id=default_project.id,
        local_fallback_enabled=True,
    )
    db.add(link)
    db.flush()
    db.add(
        CloudMembership(
            backend_link_id=link.id,
            cloud_account_id="cloud-account",
            cloud_organization_id="cloud-org",
            cloud_project_id="cloud-project",
            role="owner",
            local_organization_id=default_project.organization_id,
            local_project_id=default_project.id,
        )
    )
    db.add(
        CloudMembership(
            backend_link_id=link.id,
            cloud_account_id="cloud-account",
            cloud_organization_id="cloud-org",
            cloud_project_id="cloud-project-secondary",
            role="member",
            local_organization_id=default_project.organization_id,
            local_project_id=default_project.id,
        )
    )
    db.commit()

    async def fake_discover(_provider_url, _http_client=None):
        raise ValueError("cloud app is not an OIDC issuer")

    async def fake_provider_json_request(method, provider_url, path, **kwargs):
        assert provider_url == "http://localhost:3000"
        assert kwargs.get("access_token") == "link-token"
        if path == "/api/frameos/login/start":
            body = kwargs.get("json_body") or {}
            assert method == "POST"
            assert body["redirect_uri"] == "http://localhost:8616/api/cloud-auth/callback"
            return 200, {"authorization_url": f"https://auth.example.test/frameos-login?state={body['state']}"}
        if path == "/api/frameos/login/token":
            assert method == "POST"
            assert kwargs.get("json_body") == {"code": "broker-code"}
            return 200, {
                "provider_issuer": "https://auth.example.test",
                "claims": {
                    "sub": "cloud-subject",
                    "account_id": "cloud-account",
                    "email": "broker@example.com",
                    "email_verified": True,
                    "name": "Broker User",
                },
            }
        raise AssertionError(f"Unexpected cloud API call: {method} {path}")

    monkeypatch.setattr(cloud_auth_api, "discover_oidc_provider", fake_discover)
    monkeypatch.setattr(cloud_auth_api, "provider_json_request", fake_provider_json_request)
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_URL", "http://localhost:3000")
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_DISABLED", False)

    start = await no_auth_client.get(
        "/api/cloud-auth/login?callback_origin=http%3A%2F%2Flocalhost%3A8616",
        follow_redirects=False,
    )
    assert start.status_code == 302
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    callback = await no_auth_client.get(
        f"/api/cloud-auth/callback?code=broker-code&state={state}",
        follow_redirects=False,
    )

    assert callback.status_code == 302
    assert "frameos_session" in callback.headers.get("set-cookie", "")
    user = db.query(User).filter(User.email == "broker@example.com").one()
    identity = db.query(CloudIdentity).filter(CloudIdentity.user_id == user.id).one()
    assert identity.provider_subject == "cloud-subject"
    assert identity.cloud_account_id == "cloud-account"
    local_members = (
        db.query(OrganizationMember)
        .filter(
            OrganizationMember.organization_id == default_project.organization_id,
            OrganizationMember.user_id == user.id,
        )
        .all()
    )
    assert len(local_members) == 1
    assert local_members[0].role == "owner"


@pytest.mark.asyncio
async def test_cloud_oidc_callback_requires_grant_when_backend_connected(no_auth_client, db, default_project, monkeypatch):
    async def fake_discover(_provider_url, _http_client=None):
        return discovery()

    async def fake_exchange(*_args, **_kwargs):
        return {"id_token": "id-token", "token_type": "Bearer"}

    async def fake_verify(*_args, **_kwargs):
        return {
            "sub": "no-grant-subject",
            "email": "nogrant@example.com",
            "email_verified": True,
            "account_id": "cloud-account-without-grant",
        }

    monkeypatch.setattr(cloud_auth_api, "discover_oidc_provider", fake_discover)
    monkeypatch.setattr(cloud_auth_api, "exchange_authorization_code", fake_exchange)
    monkeypatch.setattr(cloud_auth_api, "verify_oidc_id_token", fake_verify)
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_URL", "https://auth.example.test")
    monkeypatch.setattr(app_config.config, "FRAMEOS_AUTH_PROVIDER_DISABLED", False)

    db.add(
        CloudBackendLink(
            provider_url="https://auth.example.test",
            status="connected",
            cloud_organization_id="cloud-org",
            cloud_project_id="cloud-project",
            local_organization_id=default_project.organization_id,
            local_project_id=default_project.id,
            local_fallback_enabled=True,
        )
    )
    db.commit()

    start = await no_auth_client.get("/api/cloud-auth/login", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    callback = await no_auth_client.get(f"/api/cloud-auth/callback?code=code&state={state}", follow_redirects=False)

    assert callback.status_code == 302
    assert callback.headers["location"] == "/login?error=cloud_grant_required"
    assert "frameos_session" not in callback.headers.get("set-cookie", "")
