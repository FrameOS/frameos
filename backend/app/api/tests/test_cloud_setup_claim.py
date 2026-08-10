"""First-run setup linking is bound to the browser that started it.

Without this, any LAN caller could link a fresh install to their own cloud
account and read the pending user code out of /api/cloud/setup/status; the
owner would finish setup on top of someone else's link.
"""
import pytest
from httpx import AsyncClient
from httpx._transports.asgi import ASGITransport

from app.fastapi import app
from app.utils import cloud_link


@pytest.fixture
def device_start(monkeypatch):
    async def fake_device_start(provider_url, payload):
        return 200, {
            "device_code": "device-code-1",
            "user_code": "ABCD-1234",
            "verification_uri": f"{provider_url}/device",
            "verification_uri_complete": f"{provider_url}/device?user_code=ABCD-1234",
            "expires_in": 600,
            "interval": 5,
        }

    async def fake_device_poll(provider_url, device_code):
        # Still waiting for approval, so the link — and with it the claim —
        # stays in place across a poll.
        return 428, {"error": "authorization_pending"}

    monkeypatch.setattr(cloud_link, "device_start", fake_device_start)
    monkeypatch.setattr(cloud_link, "device_poll", fake_device_poll)


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_second_browser_cannot_see_or_drive_a_claimed_setup(db, device_start):
    async with _client() as owner, _client() as attacker:
        response = await owner.post("/api/cloud/setup/connect", json={"scopes": ["backend:link"]})
        assert response.status_code == 200
        assert response.json()["connection"]["user_code"] == "ABCD-1234"

        # The other browser learns a link is pending, but not the code that
        # approves it, and cannot advance the flow.
        status = await attacker.get("/api/cloud/setup/status")
        assert status.status_code == 200
        assert status.json()["connection"] is None
        assert status.json()["claimed_by_other_browser"] is True

        assert (await attacker.post("/api/cloud/setup/poll")).status_code == 409
        assert (
            await attacker.post("/api/cloud/setup/provider", json={"provider_url": "https://evil.example"})
        ).status_code == 409


@pytest.mark.asyncio
async def test_the_claiming_browser_keeps_full_access(db, device_start):
    async with _client() as owner:
        assert (await owner.post("/api/cloud/setup/connect", json={"scopes": ["backend:link"]})).status_code == 200

        status = await owner.get("/api/cloud/setup/status")
        assert status.json()["connection"]["user_code"] == "ABCD-1234"
        assert "claimed_by_other_browser" not in status.json()

        # Polling stays available to the browser that started the flow.
        assert (await owner.post("/api/cloud/setup/poll")).status_code == 200


@pytest.mark.asyncio
async def test_disconnect_releases_the_claim_so_setup_can_be_retried(db, device_start):
    async with _client() as owner, _client() as second:
        await owner.post("/api/cloud/setup/connect", json={"scopes": ["backend:link"]})
        assert (await second.post("/api/cloud/setup/poll")).status_code == 409

        # A stuck link must never brick first-run setup: any browser can clear
        # it while the install has no users, and then claim it afresh.
        assert (await second.post("/api/cloud/setup/disconnect")).status_code == 200
        assert (await second.post("/api/cloud/setup/connect", json={"scopes": ["backend:link"]})).status_code == 200
        assert (await second.post("/api/cloud/setup/poll")).status_code == 200
        # The original browser is now the outsider.
        assert (await owner.post("/api/cloud/setup/poll")).status_code == 409


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.1.10:3000",
        "http://frame.local",
        "https://cloud.example.com",
    ],
)
def test_local_and_https_providers_are_accepted(url):
    assert cloud_link.normalize_cloud_provider_url(url) is not None


@pytest.mark.parametrize("url", ["http://cloud.example.com", "http://8.8.8.8", "http://example.org:8080"])
def test_plain_http_to_a_public_provider_is_refused(url):
    # Grants, identity claims and the link token all ride this connection; on
    # http an on-path attacker can forge any of them.
    with pytest.raises(ValueError):
        cloud_link.normalize_cloud_provider_url(url)
