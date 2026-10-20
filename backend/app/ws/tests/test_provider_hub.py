"""A fake device against the backend's management WebSocket.

The device side is what frameos/src/frameos/cloud/hub_client.nim does: enroll
with a claim token (`POST /api/frames/enroll`), dial `/api/frames/ws` with the
link token, sign the challenge's raw nonce bytes with its Ed25519 key, and
answer verbs with acks. Everything below is docs/cloud-frames.md, asserted
against the backend as the provider (docs/convergence-todo.md item 7).
"""
from __future__ import annotations

import base64
import json
from datetime import timedelta
from typing import Any, Generator

import anyio
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from app import fastapi as fastapi_module
from app.database import SessionLocal
from app.fastapi import app
from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.models.frame_provider import FrameProviderLink
from app.models.log import Log
from app.models.metrics import Metrics
from app.models.user import User
from app.tenancy import ensure_default_project_for_user
from app.utils.frame_commands import enqueue_frame_command, utcnow
from app.utils.provider_frames import mint_claim_token
from app.ws import provider_hub

HARDWARE = {"platform": "buildroot", "device": "waveshare.EPD_7in5_V2", "width": 800, "height": 480, "color": "black"}


class Device:
    """One frame's keypair and link token."""

    def __init__(self) -> None:
        self.key = Ed25519PrivateKey.generate()
        self.public_key = base64.b64encode(
            self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        ).decode()
        self.token: str = ""
        self.frame_id: int = 0

    def sign(self, nonce: str) -> str:
        return base64.b64encode(self.key.sign(base64.b64decode(nonce))).decode()


@pytest.fixture
def client(monkeypatch) -> Generator[TestClient, None, None]:
    async def no_redis_listener():
        pass

    monkeypatch.setattr(fastapi_module, "redis_listener", no_redis_listener)
    import redis as sync_redis

    from app.config import config

    sync_redis.Redis.from_url(config.REDIS_URL).flushdb()
    with TestClient(app) as test_client:
        yield test_client
    provider_hub.sessions.clear()


@pytest.fixture
def project_id() -> int:
    db = SessionLocal()
    try:
        user = User(email="owner@example.com")
        user.set_password("testpassword")
        db.add(user)
        db.commit()
        return int(ensure_default_project_for_user(db, user).id)
    finally:
        db.close()


def portal(client: TestClient):
    assert client.portal is not None
    return client.portal


def receive(ws, seconds: float = 5.0) -> dict[str, Any]:
    """The next message from the hub, or fail instead of hanging the suite."""

    async def _receive():
        with anyio.fail_after(seconds):
            return await ws._send_rx.receive()

    message = ws.portal.call(_receive)
    ws._raise_on_close(message)
    return json.loads(message["text"])


def receive_until(ws, message_type: str, seconds: float = 5.0) -> dict[str, Any]:
    while True:
        message = receive(ws, seconds)
        if message.get("type") == message_type:
            return message


def enroll(client: TestClient, project_id: int, device: Device, **body: Any) -> dict[str, Any]:
    db = SessionLocal()
    try:
        token, _row = mint_claim_token(db, project_id, name="Kitchen")
    finally:
        db.close()
    response = client.post(
        "/api/frames/enroll",
        json={"claim_token": token, "public_key": device.public_key, "hardware": HARDWARE, "frameos_version": "2026.10.17", **body},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    device.token = result["access_token"]
    device.frame_id = int(result["frame_id"])
    return result


def connect(client: TestClient, device: Device, hello: dict[str, Any] | None = None):
    ws = client.websocket_connect("/api/frames/ws", headers={"Authorization": f"Bearer {device.token}"})
    session = ws.__enter__()
    challenge = receive(session)
    assert challenge["type"] == "challenge"
    assert len(base64.b64decode(challenge["nonce"])) == 32
    session.send_json({
        "type": "hello",
        "frameos_version": "2026.10.17",
        "hardware": HARDWARE,
        "states": {"scene-a": {"count": 1}},
        "active_scene": "scene-a",
        "scenes_checksum": "",
        **(hello or {}),
    })
    session.send_json({"type": "auth", "signature": device.sign(challenge["nonce"])})
    return ws, session


def frame_row(frame_id: int) -> Frame:
    db = SessionLocal()
    try:
        frame = db.get(Frame, frame_id)
        assert frame is not None
        db.expunge(frame)
        return frame
    finally:
        db.close()


def link_row(frame_id: int) -> FrameProviderLink:
    db = SessionLocal()
    try:
        link = db.query(FrameProviderLink).filter_by(frame_id=frame_id).one()
        db.expunge(link)
        return link
    finally:
        db.close()


def queue(client: TestClient, frame_id: int, command_type: str, payload: dict | None = None) -> str:
    """What a backend route does: enqueue, then wake the hub."""
    from app.redis import get_shared_redis
    from app.utils.provider_commands import wake_provider_frame

    db = SessionLocal()
    try:
        frame = db.get(Frame, frame_id)
        assert frame is not None
        command = enqueue_frame_command(db, frame, command_type, payload)
        command_id = command.id
    finally:
        db.close()
    portal(client).call(lambda: wake_provider_frame(get_shared_redis(), frame_id))
    return command_id


def command_row(command_id: str) -> FrameCommand:
    db = SessionLocal()
    try:
        command = db.get(FrameCommand, command_id)
        assert command is not None
        db.expunge(command)
        return command
    finally:
        db.close()


def wait_for(predicate, client: TestClient, seconds: float = 5.0):
    async def _wait():
        with anyio.fail_after(seconds):
            while True:
                value = predicate()
                if value:
                    return value
                await anyio.sleep(0.05)

    return portal(client).call(_wait)


# ------------------------------------------------------------- enrollment

def test_enrollment_creates_a_provider_frame(client, project_id):
    device = Device()
    result = enroll(client, project_id, device)
    assert result["token_type"] == "Bearer"
    assert result["ws_path"] == "/api/frames/ws"
    assert result["status"] == "active"
    assert set(result["scope"].split()) == {"frame:managed", "settings:services", "telemetry:logs", "telemetry:metrics"}
    frame = frame_row(device.frame_id)
    assert frame.name == "Kitchen"
    assert frame.mode == "buildroot"
    assert (frame.width, frame.height, frame.device) == (800, 480, "waveshare.EPD_7in5_V2")
    link = link_row(device.frame_id)
    assert link.public_key == device.public_key
    assert link.token_hash != device.token  # only the hash is stored
    assert link.frameos_version == "2026.10.17"


def test_a_lost_enrollment_response_can_be_retried_with_the_same_key(client, project_id):
    device = Device()
    db = SessionLocal()
    try:
        token, _row = mint_claim_token(db, project_id)
    finally:
        db.close()
    body = {"claim_token": token, "public_key": device.public_key, "hardware": HARDWARE}
    first = client.post("/api/frames/enroll", json=body).json()
    again = client.post("/api/frames/enroll", json=body).json()
    assert again["frame_id"] == first["frame_id"]
    assert again["access_token"] != first["access_token"]
    # Another device presenting the spent token is refused like an unknown one.
    other = Device()
    refused = client.post("/api/frames/enroll", json={**body, "public_key": other.public_key})
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_claim_token"


@pytest.mark.parametrize(
    "body, error",
    [
        ({"claim_token": "FRCT_nope"}, "invalid_claim_token"),
        ({"public_key": "not base64!"}, "invalid_public_key"),
        ({"public_key": base64.b64encode(b"short").decode()}, "invalid_public_key"),
    ],
)
def test_enrollment_refusals(client, project_id, body, error):
    device = Device()
    db = SessionLocal()
    try:
        token, _row = mint_claim_token(db, project_id)
    finally:
        db.close()
    response = client.post("/api/frames/enroll", json={"claim_token": token, "public_key": device.public_key, **body})
    assert response.status_code == 400
    assert response.json()["error"] == error


def test_an_expired_claim_token_is_refused(client, project_id):
    device = Device()
    db = SessionLocal()
    try:
        token, _row = mint_claim_token(db, project_id, ttl=timedelta(seconds=-1))
    finally:
        db.close()
    response = client.post("/api/frames/enroll", json={"claim_token": token, "public_key": device.public_key})
    assert response.status_code == 400


def test_a_bound_claim_token_rekeys_the_same_frame(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    replacement = Device()
    db = SessionLocal()
    try:
        token, _row = mint_claim_token(db, project_id, frame_id=device.frame_id)
    finally:
        db.close()
    response = client.post("/api/frames/enroll", json={"claim_token": token, "public_key": replacement.public_key})
    assert response.status_code == 200
    assert int(response.json()["frame_id"]) == device.frame_id
    assert link_row(device.frame_id).public_key == replacement.public_key
    # The old link token no longer opens a socket.
    with pytest.raises(WebSocketDenialResponse) as denied:
        with client.websocket_connect("/api/frames/ws", headers={"Authorization": f"Bearer {device.token}"}):
            pass
    assert denied.value.status_code == 401


def test_the_owner_mints_claim_tokens(client, project_id):
    login = client.post("/api/login", data={"username": "owner@example.com", "password": "testpassword"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    response = client.post(f"/api/projects/{project_id}/frames/claim-tokens", json={"name": "Hall"}, headers=headers)
    assert response.status_code == 200
    token = response.json()["token"]
    assert token.startswith("FRCT_")
    device = Device()
    enrolled = client.post("/api/frames/enroll", json={"claim_token": token, "public_key": device.public_key})
    assert frame_row(int(enrolled.json()["frame_id"])).name == "Hall"


# --------------------------------------------------------------- session

def test_session_start_and_ready(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        ready = receive_until(session, "ready")
        assert ready["pending_commands"] == 0
        assert "frame:managed" in ready["scopes"]
        link = link_row(device.frame_id)
        assert link.connected is True
        assert link.last_state == {"scene-a": {"count": 1}, "active_scene": "scene-a"}
        db = SessionLocal()
        try:
            assert db.get(Frame, device.frame_id).to_dict()["connected"] is True
        finally:
            db.close()
    finally:
        ws.__exit__(None, None, None)
    wait_for(lambda: not link_row(device.frame_id).connected, client)


def test_a_bad_token_is_a_plain_401(client, project_id):
    with pytest.raises(WebSocketDenialResponse) as denied:
        with client.websocket_connect("/api/frames/ws", headers={"Authorization": "Bearer fb_link_nope"}):
            pass
    assert denied.value.status_code == 401
    assert denied.value.json() == {"error": "invalid_link_token"}


def test_a_bad_signature_closes_4401(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    with client.websocket_connect("/api/frames/ws", headers={"Authorization": f"Bearer {device.token}"}) as session:
        challenge = receive(session)
        session.send_json({"type": "hello"})
        forged = base64.b64encode(Ed25519PrivateKey.generate().sign(base64.b64decode(challenge["nonce"]))).decode()
        session.send_json({"type": "auth", "signature": forged})
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(session)
        assert closed.value.code == 4401


def test_signing_the_base64_text_is_the_classic_mistake(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    with client.websocket_connect("/api/frames/ws", headers={"Authorization": f"Bearer {device.token}"}) as session:
        challenge = receive(session)
        session.send_json({"type": "hello"})
        wrong = base64.b64encode(device.key.sign(challenge["nonce"].encode())).decode()
        session.send_json({"type": "auth", "signature": wrong})
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(session)
        assert closed.value.code == 4401


def test_an_unanswered_challenge_closes_4408(client, project_id, monkeypatch):
    monkeypatch.setattr(provider_hub, "AUTH_TIMEOUT_SECONDS", 0.2)
    device = Device()
    enroll(client, project_id, device)
    with client.websocket_connect("/api/frames/ws", headers={"Authorization": f"Bearer {device.token}"}) as session:
        receive(session)
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(session)
        assert closed.value.code == 4408


def test_a_second_socket_supersedes_the_first(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    first_ws, first = connect(client, device)
    receive_until(first, "ready")
    second_ws, second = connect(client, device)
    try:
        receive_until(second, "ready")
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(first)
        assert closed.value.code == 4409
        # The late close of the old socket does not mark the frame offline.
        assert link_row(device.frame_id).connected is True
    finally:
        second_ws.__exit__(None, None, None)
        first_ws.__exit__(None, None, None)


def test_deleting_the_frame_kicks_its_socket(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        receive_until(session, "ready")
        from app.models.frame import delete_frame
        from app.redis import get_shared_redis

        async def _delete():
            db = SessionLocal()
            try:
                assert await delete_frame(db, get_shared_redis(), device.frame_id, project_id)
            finally:
                db.close()

        portal(client).call(_delete)
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(session)
        assert closed.value.code == 4401
    finally:
        ws.__exit__(None, None, None)


# ------------------------------------------------------------------ verbs

def test_queued_verbs_are_delivered_and_acked(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    early = queue(client, device.frame_id, "set_current_scene", {"scene_id": "scene-b"})
    ws, session = connect(client, device)
    try:
        ready = receive_until(session, "ready")
        assert ready["pending_commands"] == 1
        verb = receive(session)
        assert verb == {"id": early, "type": "set_current_scene", "scene_id": "scene-b"}
        session.send_json({"id": early, "type": "ack", "ok": True})
        wait_for(lambda: command_row(early).status == "acked", client)

        live = queue(client, device.frame_id, "render")
        assert receive(session) == {"id": live, "type": "render"}
        session.send_json({"id": live, "type": "ack", "ok": False, "error": "busy"})
        wait_for(lambda: command_row(live).status == "failed", client)
        assert command_row(live).error == "busy"
    finally:
        ws.__exit__(None, None, None)


def test_backend_bookkeeping_never_reaches_the_device(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        receive_until(session, "ready")
        command_id = queue(client, device.frame_id, "set_scenes", {"scenes": [], "checksum": "c1", "_deploy": {"id": "d1"}})
        assert receive(session) == {"id": command_id, "type": "set_scenes", "scenes": [], "checksum": "c1"}
    finally:
        ws.__exit__(None, None, None)


def test_an_unacked_verb_is_delivered_again_on_the_next_connection(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    receive_until(session, "ready")
    scene = queue(client, device.frame_id, "set_current_scene", {"scene_id": "x"})
    reboot = queue(client, device.frame_id, "reboot")
    assert receive(session)["id"] == scene
    assert receive(session)["id"] == reboot
    ws.__exit__(None, None, None)
    wait_for(lambda: not link_row(device.frame_id).connected, client)

    ws, session = connect(client, device)
    try:
        ready = receive_until(session, "ready")
        # The scene switch comes again; the reboot was written once and is not
        # repeated (its disconnect is its expected effect).
        assert ready["pending_commands"] == 1
        assert receive(session)["id"] == scene
        assert command_row(reboot).status == "expired"
        assert command_row(reboot).error == "delivered_once"
    finally:
        ws.__exit__(None, None, None)


# --------------------------------------------------------------- reports

def test_logs_metrics_and_state(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        receive_until(session, "ready")
        session.send_json({"type": "log_batch", "logs": [
            {"timestamp": 1760000000, "payload": {"event": "render:done", "sceneId": "scene-a"}},
            {"timestamp": "2026-10-20T10:00:00Z", "payload": {"event": "log", "message": "hello"}, "scene": "scene-a"},
        ]})
        session.send_json({"type": "metrics", "metrics": {"load": [0.1, 0.2, 0.3], "memoryUsage": {"used": 1}}})
        session.send_json({"type": "state", "states": {"scene-b": {"n": 2}}, "active_scene": "scene-b"})

        def logged():
            db = SessionLocal()
            try:
                lines = [row.line for row in db.query(Log).filter_by(frame_id=device.frame_id, type="webhook").all()]
                metrics = db.query(Metrics).filter_by(frame_id=device.frame_id).count()
                return (lines, metrics) if len(lines) == 2 and metrics == 1 else None
            finally:
                db.close()

        lines, _metrics = wait_for(logged, client)
        assert {json.loads(line)["event"] for line in lines} == {"render:done", "log"}
        assert any(json.loads(line).get("scene") == "scene-a" for line in lines)
        wait_for(lambda: link_row(device.frame_id).last_state == {"scene-b": {"n": 2}, "active_scene": "scene-b"}, client)
    finally:
        ws.__exit__(None, None, None)


def test_sleep_records_the_forecast_and_hangs_up(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        receive_until(session, "ready")
        session.send_json({"type": "sleep", "wake_in_seconds": 900, "reason": "battery"})
        with pytest.raises(WebSocketDisconnect):
            receive(session)
        frame = frame_row(device.frame_id)
        assert frame.sleep_reason == "battery"
        assert frame.next_wake_at is not None and frame.next_wake_at > utcnow()
        assert link_row(device.frame_id).connected is False
    finally:
        ws.__exit__(None, None, None)


def test_scene_ack_and_the_deploy_record(client, project_id):
    from app.utils.provider_payloads import scenes_checksum

    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        receive_until(session, "ready")
        scenes = [{"id": "s1", "name": "One", "nodes": [], "edges": [], "settings": {"execution": "interpreted"}}]
        checksum = scenes_checksum(scenes)
        command_id = queue(client, device.frame_id, "set_scenes", {
            "scenes": scenes, "checksum": checksum, "_deploy": {"id": "d1", "snapshot": {"scenes": scenes}},
        })
        assert receive(session)["id"] == command_id
        session.send_json({"id": command_id, "type": "ack", "ok": True})
        session.send_json({"id": command_id, "type": "scene_ack", "checksum": checksum, "active_scene": "s1"})
        wait_for(lambda: link_row(device.frame_id).scenes_checksum == checksum, client)
        frame = wait_for(lambda: (f := frame_row(device.frame_id)).last_successful_deploy and f, client)
        assert frame.last_successful_deploy["scenes"][0]["id"] == "s1"
    finally:
        ws.__exit__(None, None, None)


def test_a_frame_with_scenes_of_its_own_hands_them_over(client, project_id):
    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device, {"scene_count": 1})
    try:
        receive_until(session, "ready")
        ask = receive(session)
        assert ask["type"] == "scenes_get"
        session.send_json({"id": ask["id"], "type": "ack", "ok": True})
        document = json.dumps({"scenes": [{"id": "mine", "name": "Mine", "nodes": [], "edges": []}], "active_scene": "mine"})
        encoded = base64.b64encode(document.encode()).decode()
        session.send_json({"id": ask["id"], "type": "asset_chunk", "seq": 0, "data": encoded[:40], "content_type": "application/json"})
        # A chunk boundary inside the base64 must land on a 4-char edge.
        session.send_json({"id": ask["id"], "type": "asset_chunk", "seq": 1, "data": encoded[40:], "done": True})
        frame = wait_for(lambda: (f := frame_row(device.frame_id)).scenes and f, client)
        assert [scene["id"] for scene in frame.scenes] == ["mine"]
    finally:
        ws.__exit__(None, None, None)


def test_asset_listing_and_download_reach_the_caller(client, project_id):
    from app.redis import get_shared_redis
    from app.utils.provider_commands import provider_get_file, provider_list_assets

    device = Device()
    enroll(client, project_id, device)
    ws, session = connect(client, device)
    try:
        receive_until(session, "ready")

        async def list_assets():
            db = SessionLocal()
            try:
                return await provider_list_assets(db, get_shared_redis(), db.get(Frame, device.frame_id), timeout=5)
            finally:
                db.close()

        async def download():
            db = SessionLocal()
            try:
                return await provider_get_file(
                    db, get_shared_redis(), db.get(Frame, device.frame_id), "asset_get", {"path": "a.txt"}, timeout=5
                )
            finally:
                db.close()

        with portal(client).wrap_async_context_manager(_task_group()) as group:
            listing_future = portal(client).start_task_soon(list_assets)
            ask = receive(session)
            assert ask["type"] == "assets_list"
            session.send_json({"id": ask["id"], "type": "ack", "ok": True})
            session.send_json({"id": ask["id"], "type": "assets", "assets": [
                {"path": "a.txt", "size": 5, "mtime": 1}, {"path": "../etc/passwd", "size": 1}, {"path": "dir", "is_dir": True},
            ]})
            listing = listing_future.result(timeout=5)
            assert [entry["path"] for entry in listing["assets"]] == ["a.txt", "dir"]

            file_future = portal(client).start_task_soon(download)
            ask = receive(session)
            assert ask == {"id": ask["id"], "type": "asset_get", "path": "a.txt"}
            session.send_json({"id": ask["id"], "type": "ack", "ok": True})
            session.send_json({
                "id": ask["id"], "type": "asset_chunk", "seq": 0, "done": True,
                "data": base64.b64encode(b"hello").decode(), "content_type": "text/plain",
            })
            assert file_future.result(timeout=5) == (b"hello", "text/plain")
            del group
    finally:
        ws.__exit__(None, None, None)


class _task_group:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


# --------------------------------------------------------- service settings

def test_service_settings_pull(client, project_id):
    from app.models.settings import Settings

    device = Device()
    enroll(client, project_id, device)
    db = SessionLocal()
    try:
        db.add(Settings(project_id=project_id, key="unsplash", value={"accessKey": "key-1"}))
        db.add(Settings(project_id=project_id, key="openAI", value={"apiKey": "sk-not-for-this-frame"}))
        frame = db.get(Frame, device.frame_id)
        frame.scenes = [{
            "id": "s1", "name": "Photos", "settings": {"execution": "interpreted"}, "edges": [],
            "nodes": [{"id": "n1", "type": "app", "data": {"keyword": "data/unsplash", "sources": {
                "config.json": json.dumps({"settings": ["unsplash"]}),
            }}}],
        }]
        db.commit()
    finally:
        db.close()
    url = f"/api/frames/{device.frame_id}/service-settings"
    response = client.get(url, headers={"Authorization": f"Bearer {device.token}"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"settings": {"unsplash": {"accessKey": "key-1"}}, "groups": ["unsplash"]}
    etag = response.headers["etag"]
    cached = client.get(url, headers={"Authorization": f"Bearer {device.token}", "If-None-Match": etag})
    assert cached.status_code == 304
    assert client.get(url, headers={"Authorization": "Bearer nope"}).status_code == 401
    mismatch = client.get(f"/api/frames/{device.frame_id + 1}/service-settings", headers={"Authorization": f"Bearer {device.token}"})
    assert mismatch.status_code == 403 and mismatch.json()["error"] == "frame_mismatch"
