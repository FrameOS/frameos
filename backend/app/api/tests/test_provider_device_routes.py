"""The provider protocol's HTTP half: claim codes, enrollment, service settings.

docs/cloud-frames.md "Enrollment" and "Service settings", served by the
backend (app/api/provider_frames.py); an enrolled frame is handed to the
provider sidecar's hub (faked here, app/utils/tests/provider_bridge_fake.py)
with its link token's hash and device key, which is all the hub needs to
authenticate its socket.
"""
from __future__ import annotations

import base64
import json
from datetime import timedelta

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.models.frame import Frame, delete_frame
from app.models.frame_provider import FrameProviderLink
from app.models.settings import Settings
from app.utils.provider_frames import hash_secret, mint_claim_token


HARDWARE = {"platform": "buildroot", "device": "waveshare.EPD_7in5_V2", "width": 800, "height": 480}


def public_key() -> str:
    raw = Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.b64encode(raw).decode()


async def enroll(no_auth_client, db, project_id: int, key: str, **token_args):
    token, _row = mint_claim_token(db, project_id, **token_args)
    response = await no_auth_client.post(
        "/api/frames/enroll",
        json={"claim_token": token, "public_key": key, "hardware": HARDWARE, "frameos_version": "2026.10.17", "name": "Hall"},
    )
    return token, response


@pytest.mark.asyncio
async def test_enrollment_hands_the_frame_to_the_hub(db, redis, project, no_auth_client, fake_bridge):
    key = public_key()
    _token, response = await enroll(no_auth_client, db, project.id, key)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ws_path"] == "/api/frames/ws"
    assert body["status"] == "active"
    frame = db.get(Frame, int(body["frame_id"]))
    assert frame.mode == "buildroot" and (frame.width, frame.height) == (800, 480)
    registered = fake_bridge.frames[frame.id]
    # The hub authenticates the socket with exactly this: the token's hash
    # (never the token) and the key the device enrolled.
    assert registered["body"]["token_hash"] == hash_secret(body["access_token"])
    assert registered["body"]["public_key"] == key
    assert "frame:managed" in registered["body"]["scopes"]
    db.refresh(frame)
    assert frame.provider_link.remote_frame_id == registered["remote_id"]


@pytest.mark.asyncio
async def test_a_retry_and_a_rekey_reach_the_hub(db, redis, project, no_auth_client, fake_bridge):
    key = public_key()
    token, first = await enroll(no_auth_client, db, project.id, key)
    retry = await no_auth_client.post("/api/frames/enroll", json={"claim_token": token, "public_key": key})
    assert retry.json()["frame_id"] == first.json()["frame_id"]
    frame_id = int(first.json()["frame_id"])
    assert fake_bridge.frames[frame_id]["body"]["token_hash"] == hash_secret(retry.json()["access_token"])
    # A different device with the spent code is refused like an unknown one.
    refused = await no_auth_client.post("/api/frames/enroll", json={"claim_token": token, "public_key": public_key()})
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_claim_token"
    # A code bound to the frame re-keys it in place.
    replacement = public_key()
    bound, _row = mint_claim_token(db, project.id, frame_id=frame_id)
    rekeyed = await no_auth_client.post("/api/frames/enroll", json={"claim_token": bound, "public_key": replacement})
    assert int(rekeyed.json()["frame_id"]) == frame_id
    assert fake_bridge.frames[frame_id]["body"]["public_key"] == replacement


@pytest.mark.asyncio
async def test_a_frame_enrolls_while_the_sidecar_is_down(db, redis, project, no_auth_client, fake_bridge):
    from app.utils.provider_commands import queue_provider_command

    fake_bridge.down = True
    _token, response = await enroll(no_auth_client, db, project.id, public_key())
    assert response.status_code == 200
    frame = db.get(Frame, int(response.json()["frame_id"]))
    assert frame.provider_link.remote_frame_id is None
    # The first verb registers it.
    fake_bridge.down = False
    outcome = await queue_provider_command(db, redis, frame, "render")
    assert outcome["status"] == "queued"
    assert frame.provider_link.remote_frame_id == fake_bridge.frames[frame.id]["remote_id"]


@pytest.mark.parametrize(
    "body, error",
    [
        ({"claim_token": "FRCT_nope"}, "invalid_claim_token"),
        ({"public_key": "not base64!"}, "invalid_public_key"),
        ({"public_key": base64.b64encode(b"short").decode()}, "invalid_public_key"),
    ],
)
@pytest.mark.asyncio
async def test_enrollment_refusals(db, redis, project, no_auth_client, fake_bridge, body, error):
    token, _row = mint_claim_token(db, project.id)
    response = await no_auth_client.post("/api/frames/enroll", json={"claim_token": token, "public_key": public_key(), **body})
    assert response.status_code == 400
    assert response.json()["error"] == error


@pytest.mark.asyncio
async def test_an_expired_claim_code_is_refused(db, redis, project, no_auth_client, fake_bridge):
    _token, response = await enroll(no_auth_client, db, project.id, public_key(), ttl=timedelta(seconds=-1))
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_the_owner_mints_claim_codes(db, redis, project, async_client, fake_bridge):
    response = await async_client.post("/api/frames/claim-tokens", json={"name": "Kitchen"})
    assert response.status_code == 200
    assert response.json()["token"].startswith("FRCT_")


@pytest.mark.asyncio
async def test_deleting_the_frame_forgets_it_in_the_hub(db, redis, project, no_auth_client, fake_bridge):
    _token, response = await enroll(no_auth_client, db, project.id, public_key())
    frame_id = int(response.json()["frame_id"])
    remote_id = fake_bridge.frames[frame_id]["remote_id"]
    assert await delete_frame(db, redis, frame_id, project.id)
    assert fake_bridge.deleted == [remote_id]
    assert db.query(FrameProviderLink).count() == 0


@pytest.mark.asyncio
async def test_service_settings_pull(db, redis, project, no_auth_client, fake_bridge):
    _token, response = await enroll(no_auth_client, db, project.id, public_key())
    body = response.json()
    frame = db.get(Frame, int(body["frame_id"]))
    db.add(Settings(project_id=project.id, key="unsplash", value={"accessKey": "key-1"}))
    db.add(Settings(project_id=project.id, key="openAI", value={"apiKey": "sk-not-for-this-frame"}))
    frame.scenes = [{
        "id": "s1", "name": "Photos", "settings": {"execution": "interpreted"}, "edges": [],
        "nodes": [{"id": "n1", "type": "app", "data": {"keyword": "data/unsplash", "sources": {
            "config.json": json.dumps({"settings": ["unsplash"]}),
        }}}],
    }]
    db.commit()
    url = f"/api/frames/{frame.id}/service-settings"
    bearer = {"Authorization": f"Bearer {body['access_token']}"}
    pulled = await no_auth_client.get(url, headers=bearer)
    assert pulled.status_code == 200
    assert pulled.headers["cache-control"] == "no-store"
    assert pulled.json() == {"settings": {"unsplash": {"accessKey": "key-1"}}, "groups": ["unsplash"]}
    cached = await no_auth_client.get(url, headers={**bearer, "If-None-Match": pulled.headers["etag"]})
    assert cached.status_code == 304
    assert (await no_auth_client.get(url, headers={"Authorization": "Bearer nope"})).status_code == 401
    mismatch = await no_auth_client.get(f"/api/frames/{frame.id + 1}/service-settings", headers=bearer)
    assert mismatch.status_code == 403 and mismatch.json()["error"] == "frame_mismatch"
