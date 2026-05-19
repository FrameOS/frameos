from urllib.parse import parse_qs, urlparse

import pytest

from app.models.assets import Assets
from app.models.cloud import CloudAuthSession
from app.models.user import User
from app.utils.cloud import protect_secret, state_hash, unprotect_secret


@pytest.mark.asyncio
async def test_cloud_signup_start_only_available_without_user(no_auth_client, db):
    db.query(User).delete()
    db.commit()

    response = await no_auth_client.post(
        "/api/cloud/signup/start",
        json={
            "email": "owner@example.com",
            "password": "testpassword",
            "password2": "testpassword",
            "newsletter": False,
        },
    )

    assert response.status_code == 200
    location = response.json()["cloud_auth_url"]
    parsed = urlparse(location)
    query = parse_qs(parsed.query)
    assert location.startswith("https://frameos.net/api/cloud/backend/auth/start?")
    assert query["redirect_uri"] == ["http://test/api/cloud/callback"]
    assert query["backend_url"] == ["http://test"]
    assert query["state"][0]

    user = User(email="existing@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    response = await no_auth_client.post(
        "/api/cloud/signup/start",
        json={
            "email": "owner@example.com",
            "password": "testpassword",
            "password2": "testpassword",
            "newsletter": False,
        },
    )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_cloud_signup_callback_creates_cloud_bound_first_user(no_auth_client, db, monkeypatch):
    db.query(User).delete()
    db.commit()

    start_response = await no_auth_client.post(
        "/api/cloud/signup/start",
        json={
            "email": "owner@example.com",
            "password": "testpassword",
            "password2": "testpassword",
            "newsletter": False,
        },
    )
    assert start_response.status_code == 200
    parsed = urlparse(start_response.json()["cloud_auth_url"])
    state = parse_qs(parsed.query)["state"][0]

    async def fake_exchange(request, session, code):
        assert code == "code-123"
        return {
            "backendToken": "cloud-backend-token",
            "backend": {
                "id": "bcl_123",
                "backendName": "FrameOS backend",
                "backendUrl": "http://test",
            },
            "user": {"id": "usr_123", "email": "owner@example.com"},
        }

    monkeypatch.setattr("app.api.cloud._exchange_cloud_code", fake_exchange)

    response = await no_auth_client.get(f"/api/cloud/callback?code=code-123&state={state}")

    assert response.status_code == 307
    assert "frameos_session" in response.cookies
    user = db.query(User).filter_by(email="owner@example.com").one()
    assert user.cloud_auth_required is True
    assert user.cloud_user_id == "usr_123"
    assert user.cloud_backend_link_id == "bcl_123"
    assert user.cloud_backend_token != "cloud-backend-token"
    assert unprotect_secret(user.cloud_backend_token) == "cloud-backend-token"
    assert user.check_password("testpassword") is True


@pytest.mark.asyncio
async def test_cloud_required_login_returns_cloud_auth_url(no_auth_client, db):
    user = User(email="cloud@example.com", cloud_auth_required=True, cloud_user_id="usr_123")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    response = await no_auth_client.post(
        "/api/login",
        data={"username": "cloud@example.com", "password": "testpassword"},
    )

    assert response.status_code == 403
    payload = response.json()
    assert payload["detail"] == "FrameOS Cloud authentication required"
    assert payload["cloud_auth_url"].startswith("https://frameos.net/api/cloud/backend/auth/start?")


@pytest.mark.asyncio
async def test_cloud_reauth_start_for_authenticated_first_user(async_client):
    response = await async_client.post("/api/cloud/reauth/start")

    assert response.status_code == 200
    payload = response.json()
    assert payload["cloud_auth_url"].startswith("https://frameos.net/api/cloud/backend/auth/start?")


@pytest.mark.asyncio
async def test_cloud_reauth_returns_to_browser_url(async_client, db, monkeypatch):
    return_to = "http://localhost:8616/settings"
    response = await async_client.post(
        "/api/cloud/reauth/start",
        headers={
            "origin": "http://localhost:8616",
            "x-frameos-return-to": return_to,
        },
    )

    assert response.status_code == 200
    parsed = urlparse(response.json()["cloud_auth_url"])
    query = parse_qs(parsed.query)
    assert query["redirect_uri"] == ["http://localhost:8616/api/cloud/callback"]
    state = query["state"][0]

    session = db.query(CloudAuthSession).filter_by(state_hash=state_hash(state)).one()
    assert session.return_to == return_to

    async def fake_exchange(request, session, code):
        assert code == "code-123"
        return {
            "backendToken": "cloud-backend-token",
            "backend": {
                "id": "bcl_123",
                "backendName": "FrameOS backend",
                "backendUrl": "http://localhost:8616",
            },
            "user": {"id": "usr_123", "email": "test@example.com"},
        }

    monkeypatch.setattr("app.api.cloud._exchange_cloud_code", fake_exchange)

    callback = await async_client.get(f"/api/cloud/callback?code=code-123&state={state}")

    assert callback.status_code == 307
    assert callback.headers["location"] == return_to


@pytest.mark.asyncio
async def test_cloud_callback_denial_returns_to_browser_url(async_client, db):
    return_to = "http://localhost:8616/settings"
    response = await async_client.post(
        "/api/cloud/reauth/start",
        headers={
            "origin": "http://localhost:8616",
            "x-frameos-return-to": return_to,
        },
    )

    assert response.status_code == 200
    parsed = urlparse(response.json()["cloud_auth_url"])
    state = parse_qs(parsed.query)["state"][0]

    callback = await async_client.get(f"/api/cloud/callback?error=access_denied&state={state}")

    assert callback.status_code == 307
    assert callback.headers["location"] == return_to
    session = db.query(CloudAuthSession).filter_by(state_hash=state_hash(state)).one()
    assert session.consumed_at is not None


@pytest.mark.asyncio
async def test_cloud_status_marks_revoked_backend_for_reauth(async_client, db, monkeypatch):
    user = db.query(User).first()
    user.cloud_auth_required = True
    user.cloud_backend_token = protect_secret("revoked-token")
    user.cloud_backend_link_id = "bcl_revoked"
    user.cloud_backend_name = "FrameOS backend (localhost:8989)"
    user.cloud_backend_url = "http://localhost:8989"
    db.commit()

    class FakeCloudResponse:
        status_code = 401

        def json(self):
            return {"error": "Sign in or use a linked backend token."}

    async def fake_cloud_session(request, token):
        assert token == "revoked-token"
        return FakeCloudResponse()

    monkeypatch.setattr("app.api.cloud._request_cloud_backend_session", fake_cloud_session)

    response = await async_client.get("/api/cloud/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["linked"] is False
    assert payload["cloud_auth_required"] is True
    assert "no longer recognizes" in payload["cloud_error"]

    db.refresh(user)
    assert user.cloud_backend_token is None
    assert user.cloud_backend_link_id is None
    assert user.cloud_backend_name == "FrameOS backend (localhost:8989)"


@pytest.mark.asyncio
async def test_cloud_backup_proxy_rejects_plaintext_fields(async_client, db):
    user = db.query(User).first()
    user.cloud_backend_token = "not-needed-for-validation"
    db.commit()

    response = await async_client.post(
        "/api/cloud/backups",
        json={"frames": [], "encryptedManifest": {"algorithm": "AES-256-GCM", "iv": "123456789012", "ciphertext": "1234567890123456"}},
    )

    assert response.status_code == 400
    assert "inside an encrypted envelope" in response.json()["detail"]


@pytest.mark.asyncio
async def test_cloud_export_manifest_and_object_include_backend_assets(async_client, db):
    asset = Assets(path="fonts/custom.ttf", data=b"font-bytes")
    db.add(asset)
    db.commit()

    response = await async_client.get("/api/cloud/export/manifest?includeFrameFiles=false")

    assert response.status_code == 200
    manifest = response.json()
    assert manifest["schemaVersion"] == "frameos.backend.export.v1"
    asset_meta = manifest["database"]["assets"][0]
    assert asset_meta["path"] == "fonts/custom.ttf"
    object_id = asset_meta["objectId"]
    assert object_id

    object_response = await async_client.get(f"/api/cloud/export/objects/{object_id}")

    assert object_response.status_code == 200
    assert object_response.content == b"font-bytes"


@pytest.mark.asyncio
async def test_cloud_import_prepare_rejects_wrong_schema(async_client):
    response = await async_client.post("/api/cloud/import/prepare", json={"manifest": {"schemaVersion": "wrong"}})

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported backup manifest schemaVersion."
