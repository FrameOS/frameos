"""End-to-end happy path against a real FrameOS Cloud dev server (Phase 0).

Skipped unless a local provider is running and the env vars below are set.
The private frameos-cloud repo ships `scripts/e2e-frameos.sh`, which boots the
dev server, creates a verified account with a browser session, and runs this
file with:

    FRAMEOS_CLOUD_E2E_URL     e.g. http://localhost:3000
    FRAMEOS_CLOUD_E2E_COOKIE  the account's session cookie ("name=value")
    FRAMEOS_CLOUD_E2E_EMAIL   the account's email (for assertions)

Everything here goes over real HTTP: the device-authorization link, grants
sync, the login handoff (Phase 1), and config backups (Phase 3).
"""
import base64
import json
import os

import httpx
import pytest

from app.models.cloud import CloudIdentity
from app.models.frame import Frame

E2E_URL = os.environ.get("FRAMEOS_CLOUD_E2E_URL")
E2E_COOKIE = os.environ.get("FRAMEOS_CLOUD_E2E_COOKIE")
E2E_EMAIL = os.environ.get("FRAMEOS_CLOUD_E2E_EMAIL")

pytestmark = pytest.mark.skipif(
    not E2E_URL or not E2E_COOKIE,
    reason="Set FRAMEOS_CLOUD_E2E_URL and FRAMEOS_CLOUD_E2E_COOKIE (see frameos-cloud/scripts/e2e-frameos.sh)",
)

# Connect with login only; the backup features are enabled later through the
# in-place feature-change flow (also exercised end-to-end below).
SCOPES = ["backend:link", "backend:read", "auth:login"]
ALL_SCOPES = SCOPES + ["backup:templates", "backup:frames"]


def cloud_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=E2E_URL,
        headers={"cookie": E2E_COOKIE, "origin": E2E_URL},
        timeout=30.0,
        follow_redirects=False,
    )


@pytest.mark.asyncio
async def test_cloud_link_login_and_backups_happy_path(async_client, db):
    # ---- Phase 0: link through the device authorization flow ----------------
    response = await async_client.post("/api/cloud/provider", json={"provider_url": E2E_URL})
    assert response.status_code == 200, response.text

    response = await async_client.post("/api/cloud/connect", json={"scopes": SCOPES})
    assert response.status_code == 200, response.text
    connection = response.json()["connection"]
    assert connection["user_code"]

    async with cloud_client() as cloud:
        approve = await cloud.post("/api/device/authorize", json={"user_code": connection["user_code"]})
        assert approve.status_code == 200, approve.text

    response = await async_client.post("/api/cloud/poll")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "connected", data
    assert sorted(data["link"]["scopes"]) == sorted(SCOPES)
    if E2E_EMAIL:
        assert data["link"]["account_email"] == E2E_EMAIL

    # ---- Phase 1: login handoff over real HTTP -------------------------------
    response = await async_client.post("/api/cloud/identity/link", json={})
    assert response.status_code == 200, response.text
    authorization_url = response.json()["authorization_url"]
    assert authorization_url.startswith(E2E_URL)

    async with cloud_client() as cloud:
        authorize = await cloud.get(authorization_url)
        assert authorize.status_code in (302, 303, 307), authorize.text
        callback_url = authorize.headers["location"]
    assert callback_url.startswith("http://test/api/cloud/login/callback"), callback_url
    assert "code=" in callback_url and "state=" in callback_url

    response = await async_client.get(callback_url[len("http://test"):])
    assert response.status_code == 303, response.text
    assert response.headers["location"] == "/settings"

    identity = db.query(CloudIdentity).first()
    assert identity is not None
    if E2E_EMAIL:
        assert identity.email == E2E_EMAIL

    status = (await async_client.get("/api/cloud/status")).json()
    assert status["identity"] is not None

    # A second handoff now signs the linked user in (fresh session cookie).
    response = await async_client.post("/api/cloud/login/start", json={"next": "/frames"})
    assert response.status_code == 200, response.text
    async with cloud_client() as cloud:
        authorize = await cloud.get(response.json()["authorization_url"])
        callback_url = authorize.headers["location"]
    response = await async_client.get(callback_url[len("http://test"):])
    assert response.status_code == 303
    assert response.headers["location"] == "/frames"
    assert "frameos_session" in response.headers.get("set-cookie", "")

    # ---- enabled features: add the backup scopes without reconnecting --------
    response = await async_client.post(
        "/api/cloud/features",
        json={"scopes": ["auth:login", "backup:templates", "backup:frames"]},
    )
    assert response.status_code == 200, response.text
    upgrade = response.json().get("upgrade")
    assert upgrade and upgrade["user_code"], response.text

    async with cloud_client() as cloud:
        approve = await cloud.post("/api/device/authorize", json={"user_code": upgrade["user_code"]})
        assert approve.status_code == 200, approve.text

    response = await async_client.post("/api/cloud/poll")
    assert response.status_code == 200
    data = response.json()
    assert data.get("upgrade") is None
    assert sorted(data["link"]["scopes"]) == sorted(ALL_SCOPES)

    # ---- Phase 3: config backups over real HTTP ------------------------------
    frame = Frame(
        project_id=async_client.project_id,
        name="E2E frame",
        frame_host="10.0.0.99",
        ssh_pass="e2e-secret-pass",
        status="ready",
        scenes=[{"id": "scene-e2e", "nodes": []}],
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)

    response = await async_client.post("/api/cloud/backups/frames", json={"frame_id": frame.id})
    assert response.status_code == 200, response.text

    response = await async_client.get("/api/cloud/backups")
    assert response.status_code == 200
    backups = response.json()["backups"]
    match = next(b for b in backups if b["item_key"] == f"frame-{frame.id}")
    assert match["kind"] == "frames"

    # The blob stored in the cloud is sanitized.
    async with cloud_client() as cloud:
        blob = await cloud.get(
            f"/api/backends/backups/{match['id']}",
            headers={"cookie": "", "origin": E2E_URL},
        )
        # (bearer-only endpoint; expect 401 without the link token — the local
        # restore path below proves the content instead)
        assert blob.status_code == 401

    response = await async_client.post(
        "/api/cloud/backups/restore",
        json={"backup_id": match["id"], "project_id": async_client.project_id},
    )
    assert response.status_code == 200, response.text
    restored_id = response.json()["id"]
    restored = db.get(Frame, restored_id)
    assert restored.name == "E2E frame"
    assert restored.scenes == [{"id": "scene-e2e", "nodes": []}]
    assert restored.ssh_pass is None  # the secret never reached the cloud

    # ---- unlink ---------------------------------------------------------------
    response = await async_client.post("/api/cloud/disconnect")
    assert response.status_code == 200
    assert response.json()["status"] == "disconnected"
