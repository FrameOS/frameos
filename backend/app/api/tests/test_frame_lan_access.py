"""The frame-level LAN access switch on the self-hosted backend: the column
and where it is set (creation, import, adoption mirror), what the device is
handed (frame.json, ESP32 provisioning), and the two routes that change it
(app/api/frame_lan_access.py) for each kind of frame."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.models.frame import Frame, get_frame_json, new_frame
from app.models.frame_command import FrameCommand
from app.models.log import Log
from app.tasks.embedded_firmware import embedded_provisioning_plan
from app.utils.frame_commands import enqueue_frame_command, get_frame_command
from app.utils.frame_http import _auth_headers, _is_control_path

from .test_embedded_firmware import create_embedded_frame

CODE = "482913"


def _setting(plan: dict, key: str):
    return next((item["value"] for item in plan["settings"] if item["key"] == key), None)


def _codes_logged(db, frame_id: int) -> list[str]:
    return [row.line for row in db.query(Log).filter(Log.frame_id == frame_id).all() if CODE in (row.line or "")]


async def _linux_frame(async_client, db, **extra) -> Frame:
    response = await async_client.post(
        "/api/frames/new", json={"name": "Kitchen", "frame_host": "kitchen.local", "server_host": "backend.local", **extra}
    )
    assert response.status_code == 200, response.text
    return db.get(Frame, response.json()["frame"]["id"])


async def _esp32_frame(async_client, db) -> Frame:
    frame = db.get(Frame, (await create_embedded_frame(async_client))["id"])
    frame.last_log_at = datetime(2026, 10, 17, 10, 0, 0)
    db.commit()
    return frame


async def _virtual_frame(async_client, db) -> Frame:
    response = await async_client.post(
        "/api/frames/new",
        json={"name": "Kiosk", "frame_host": "", "server_host": "localhost", "mode": "embedded", "platform": "virtual"},
    )
    assert response.status_code == 200, response.text
    return db.get(Frame, response.json()["frame"]["id"])


def _device(status: int, body) -> AsyncMock:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return AsyncMock(return_value=(status, raw, {"content-type": "application/json"}))


def _relay(mock: AsyncMock):
    return patch("app.api.frame_lan_access._fetch_frame_http_bytes", new=mock)


# ------------------------------------------------------------- the column


@pytest.mark.asyncio
async def test_a_new_frame_starts_with_what_the_form_chose_and_off_without_a_choice(async_client, db):
    assert (await _linux_frame(async_client, db)).lan_access is False
    on = await _linux_frame(async_client, db, lan_access=True)
    assert on.lan_access is True
    assert on.to_dict()["lan_access"] is True

    buildroot = await _linux_frame(
        async_client,
        db,
        mode="buildroot",
        platform="raspberry-pi-64",
        network={"wifiSSID": "Home", "wifiPassword": "secret1234"},
        lan_access=True,
    )
    assert buildroot.lan_access is True
    esp32 = await async_client.post(
        "/api/frames/new",
        json={"name": "E", "frame_host": "", "server_host": "localhost", "mode": "embedded", "platform": "esp32-s3", "lan_access": True},
    )
    assert esp32.json()["frame"]["lan_access"] is True
    assert (await _virtual_frame(async_client, db)).lan_access is False


@pytest.mark.asyncio
async def test_the_settings_save_never_moves_it(async_client, db):
    frame = await _linux_frame(async_client, db)
    response = await async_client.post(f"/api/frames/{frame.id}", json={"name": "Renamed", "lan_access": True})
    assert response.status_code == 200, response.text
    db.refresh(frame)
    assert frame.name == "Renamed"
    assert frame.lan_access is False


@pytest.mark.asyncio
async def test_an_import_keeps_the_switch_it_had_and_an_old_export_had_lan_access(async_client, db):
    base = {"name": "Restored", "frame_host": "restored.local", "server_host": "backend.local"}
    response = await async_client.post("/api/frames/import", json=base)
    assert response.status_code == 200, response.text
    assert response.json()["frame"]["lan_access"] is True
    response = await async_client.post("/api/frames/import", json={**base, "lan_access": False})
    assert response.json()["frame"]["lan_access"] is False


@pytest.mark.asyncio
@patch("app.models.frame.publish_message", new_callable=AsyncMock)
async def test_frame_json_carries_the_creation_seed(_publish, db, redis):
    frame = await new_frame(db, redis, "Seed", "host", "server.local")
    assert get_frame_json(db, frame)["network"]["lanAccess"] is False
    frame.lan_access = True
    db.commit()
    network = get_frame_json(db, frame)["network"]
    assert network["lanAccess"] is True
    # The legacy key is not a seed, and the backend never writes it.
    assert "allowLocalNetworkAccess" not in network


@pytest.mark.asyncio
async def test_esp32_provisioning_sets_the_switch_over_the_console(async_client, db):
    frame = await _esp32_frame(async_client, db)
    assert _setting(embedded_provisioning_plan(frame), "allow_local_network") == "0"
    frame.lan_access = True
    assert _setting(embedded_provisioning_plan(frame), "allow_local_network") == "1"


def test_the_device_routes_are_control_paths_and_take_the_server_key():
    assert _is_control_path("/api/network/local-access")
    assert _is_control_path("/api/network/local-access/challenge")
    frame = Frame(mode="rpios", server_api_key="server-key", frame_access="private", frame_access_key="viewer-key")
    headers = _auth_headers(frame, prefer_server_key=_is_control_path("/api/network/local-access/challenge"))
    assert headers["Authorization"] == "Bearer server-key"


# ------------------------------------------------------- Linux: the relay


@pytest.mark.asyncio
async def test_linux_challenge_shows_the_code_on_the_panel(async_client, db):
    frame = await _linux_frame(async_client, db)
    device = _device(200, {"status": "ok", "codeLength": 6, "expiresInSeconds": 300})
    with _relay(device):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "shown", "expires_in_seconds": 300}
    kwargs = device.await_args.kwargs
    assert kwargs["path"] == "/api/network/local-access/challenge"
    assert kwargs["method"] == "POST"
    # Once: a retry would replace the code on the panel.
    assert kwargs["attempts"] == 1
    assert json.loads(kwargs["body"]) == {"scope": "localNetwork"}


@pytest.mark.asyncio
async def test_linux_set_on_with_the_code_applies_and_mirrors_the_device(async_client, db):
    frame = await _linux_frame(async_client, db)
    device = _device(
        200, {"allowLocalNetworkAccess": True, "allowShellApps": False, "challengePending": False, "challengeSecondsLeft": 0}
    )
    with _relay(device):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": "482 913"})
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "applied", "lan_access": True}
    sent = json.loads(device.await_args.kwargs["body"])
    assert sent == {"enabled": True, "code": CODE, "scope": "localNetwork"}
    assert device.await_args.kwargs["attempts"] == 1
    db.refresh(frame)
    assert frame.lan_access is True
    assert _codes_logged(db, frame.id) == []

    # Off needs no code, and none is forwarded.
    device = _device(200, {"allowLocalNetworkAccess": False})
    with _relay(device):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": False, "code": "999999"})
    assert response.json() == {"status": "applied", "lan_access": False}
    assert json.loads(device.await_args.kwargs["body"]) == {"enabled": False, "scope": "localNetwork"}
    db.refresh(frame)
    assert frame.lan_access is False


@pytest.mark.asyncio
async def test_linux_refusals_carry_the_devices_token(async_client, db):
    frame = await _linux_frame(async_client, db)
    cases = [
        (_device(403, {"detail": "Invalid code", "error": "invalid_code"}), 403, "invalid_code"),
        (_device(403, {"detail": "Expired", "error": "code_expired"}), 403, "code_expired"),
        (_device(403, {"detail": "Too many", "error": "too_many_attempts"}), 403, "too_many_attempts"),
        (_device(500, {"detail": "Disk", "error": "persist_failed"}), 500, "persist_failed"),
        # A runtime from before the switch.
        (_device(404, b"Not found"), 409, "unsupported"),
        (_device(401, {"detail": "Unauthorized"}), 409, "unsupported"),
    ]
    for device, status, error in cases:
        with _relay(device):
            response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": CODE})
        assert response.status_code == status, (error, response.text)
        assert response.json()["error"] == error
        assert response.json()["detail"]
    db.refresh(frame)
    assert frame.lan_access is False


@pytest.mark.asyncio
async def test_linux_challenge_without_a_panel_or_a_frame_that_does_not_answer(async_client, db):
    frame = await _linux_frame(async_client, db)
    with _relay(_device(409, {"detail": "This frame has no panel", "error": "no_panel"})):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 409
    assert response.json()["error"] == "no_panel"

    with _relay(AsyncMock(side_effect=HTTPException(status_code=502, detail="Connection refused"))):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 502
    assert response.json()["error"] == "unreachable"
    assert "Connection refused" in response.json()["detail"]

    with _relay(AsyncMock(side_effect=HTTPException(status_code=408, detail="Timeout to http://kitchen.local"))):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": CODE})
    assert response.status_code == 504
    assert response.json()["error"] == "timeout"


@pytest.mark.asyncio
async def test_the_body_is_checked_before_the_device_is_asked(async_client, db):
    frame = await _linux_frame(async_client, db)
    device = _device(200, {})
    with _relay(device):
        cases = [
            ({}, 400, "invalid_lan_access"),
            ({"enabled": "yes"}, 400, "invalid_lan_access"),
            ({"enabled": True}, 400, "code_required"),
            ({"enabled": True, "code": "  "}, 400, "code_required"),
            ({"enabled": True, "code": "12345"}, 400, "invalid_code"),
            ({"enabled": True, "code": 482913}, 400, "invalid_code"),
        ]
        for body, status, error in cases:
            response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json=body)
            assert response.status_code == status, (body, response.text)
            assert response.json()["error"] == error
    device.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_frame_of_another_project_is_not_found(async_client):
    response = await async_client.post("/api/frames/9999/lan_access/challenge")
    assert response.status_code == 404
    response = await async_client.post("/api/frames/9999/lan_access", json={"enabled": False})
    assert response.status_code == 404


# ------------------------------------------------------- ESP32: the queue


def _device_answers(no_auth_client, frame: Frame, ack: dict):
    """wait_for_frame_command as an awake ESP32 makes it: the device takes the
    command and posts its ack to the real route while the producer waits."""

    async def answer(db, waiting_frame, command_id, _timeout):
        response = await no_auth_client.post(
            f"/api/frames/{frame.id}/embedded/commands/{command_id}/ack",
            json=ack,
            headers={"Authorization": f"Bearer {frame.server_api_key}"},
        )
        assert response.status_code == 200, response.text
        db.expire_all()
        return get_frame_command(db, waiting_frame, command_id)

    return answer


@pytest.mark.asyncio
async def test_esp32_challenge_and_set_go_through_the_queue(async_client, no_auth_client, db):
    frame = await _esp32_frame(async_client, db)
    with patch("app.utils.embedded_commands.nudge_embedded_frame", new_callable=AsyncMock, return_value=True), patch(
        "app.utils.embedded_commands.wait_for_frame_command", side_effect=_device_answers(no_auth_client, frame, {"ok": True})
    ):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "shown", "expires_in_seconds": 300}
    (challenge,) = db.query(FrameCommand).filter_by(frame_id=frame.id, type="lan_access_challenge").all()
    assert challenge.status == "acked"

    ack = {"ok": True, "lan_access": True, "frameos_version": "2026.10.17"}
    with patch("app.utils.embedded_commands.nudge_embedded_frame", new_callable=AsyncMock, return_value=True), patch(
        "app.utils.embedded_commands.wait_for_frame_command", side_effect=_device_answers(no_auth_client, frame, ack)
    ):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": CODE})
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "applied", "lan_access": True}
    db.expire_all()
    assert db.get(Frame, frame.id).lan_access is True
    (row,) = db.query(FrameCommand).filter_by(frame_id=frame.id, type="lan_access_set").all()
    # The code lived on the row only until the device answered.
    assert row.status == "acked"
    assert row.payload == {"enabled": True}
    assert row.detail == "on"
    assert _codes_logged(db, frame.id) == []


@pytest.mark.asyncio
async def test_esp32_refusals_and_old_firmware(async_client, no_auth_client, db):
    frame = await _esp32_frame(async_client, db)
    with patch("app.utils.embedded_commands.nudge_embedded_frame", new_callable=AsyncMock, return_value=True), patch(
        "app.utils.embedded_commands.wait_for_frame_command",
        side_effect=_device_answers(no_auth_client, frame, {"ok": False, "error": "invalid_code", "lan_access": False}),
    ):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": CODE})
    assert response.status_code == 403
    assert response.json()["error"] == "invalid_code"
    row = db.query(FrameCommand).filter_by(frame_id=frame.id, type="lan_access_set").one()
    assert row.status == "failed" and row.payload == {"enabled": True}
    db.expire_all()
    assert db.get(Frame, frame.id).lan_access is False

    # Firmware that pulls the queue but predates the verbs.
    with patch("app.utils.embedded_commands.nudge_embedded_frame", new_callable=AsyncMock, return_value=True), patch(
        "app.utils.embedded_commands.wait_for_frame_command",
        side_effect=_device_answers(no_auth_client, frame, {"ok": False, "error": "unknown_verb"}),
    ):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 409
    assert response.json()["error"] == "unsupported"

    # Firmware that does not pull the queue at all.
    frame = db.get(Frame, frame.id)
    frame.embedded = {**frame.embedded, "lastBoot": {"frameosVersion": "v2026.10.4"}}
    db.commit()
    response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 409
    assert response.json()["error"] == "unsupported"


@pytest.mark.asyncio
async def test_esp32_asleep_queues_and_the_wake_ack_updates_the_row(async_client, no_auth_client, db):
    frame = await _esp32_frame(async_client, db)
    with patch("app.utils.embedded_commands.nudge_embedded_frame", new_callable=AsyncMock, return_value=False):
        response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": CODE})
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "queued"}
    row = db.query(FrameCommand).filter_by(frame_id=frame.id, type="lan_access_set").one()
    assert row.status == "pending"
    # The device needs the code to check it; the owner's listing never shows it.
    assert row.payload == {"enabled": True, "code": CODE}
    listing = await async_client.get(f"/api/frames/{frame.id}/commands")
    assert CODE not in listing.text

    headers = {"Authorization": f"Bearer {frame.server_api_key}"}
    pulled = await no_auth_client.post(f"/api/frames/{frame.id}/embedded/commands", json={}, headers=headers)
    assert pulled.json()["commands"] == [{"id": row.id, "type": "lan_access_set", "enabled": True, "code": CODE}]
    # An ack without state fields (older firmware): the applied verb says what it set.
    acked = await no_auth_client.post(
        f"/api/frames/{frame.id}/embedded/commands/{row.id}/ack", json={"ok": True}, headers=headers
    )
    assert acked.status_code == 200, acked.text
    db.expire_all()
    assert db.get(Frame, frame.id).lan_access is True
    assert db.get(FrameCommand, row.id).payload == {"enabled": True}


@pytest.mark.asyncio
async def test_a_queued_code_is_forgotten_when_the_row_expires_or_is_replaced(async_client, db):
    frame = await _esp32_frame(async_client, db)
    first = enqueue_frame_command(db, frame, "lan_access_set", {"enabled": True, "code": "111111"})
    second = enqueue_frame_command(db, frame, "lan_access_set", {"enabled": True, "code": "222222"})
    db.refresh(first)
    assert first.status == "expired" and first.error == "superseded"
    assert first.payload == {"enabled": True}
    response = await async_client.delete(f"/api/frames/{frame.id}/commands/{second.id}")
    assert response.status_code == 200, response.text
    db.refresh(second)
    assert second.payload == {"enabled": True}


@pytest.mark.asyncio
async def test_the_esp32_hello_keeps_the_row_in_step(async_client, no_auth_client, db):
    frame = await _esp32_frame(async_client, db)
    headers = {"Authorization": f"Bearer {frame.server_api_key}"}
    response = await no_auth_client.post(
        f"/api/frames/{frame.id}/embedded/commands", json={"frameos_version": "2026.10.17", "lan_access": True}, headers=headers
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    assert db.get(Frame, frame.id).lan_access is True
    # A hello that does not say (older firmware) leaves it.
    await no_auth_client.post(f"/api/frames/{frame.id}/embedded/commands", json={}, headers=headers)
    db.expire_all()
    assert db.get(Frame, frame.id).lan_access is True


# ------------------------------------------------ frames the backend renders


@pytest.mark.asyncio
async def test_a_virtual_frame_has_no_panel_for_a_code_but_can_turn_it_off(async_client, db):
    frame = await _virtual_frame(async_client, db)
    response = await async_client.post(f"/api/frames/{frame.id}/lan_access/challenge")
    assert response.status_code == 409
    assert response.json()["error"] == "no_panel"
    response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": True, "code": CODE})
    assert response.status_code == 409
    assert response.json()["error"] == "no_panel"

    frame.lan_access = True
    db.commit()
    response = await async_client.post(f"/api/frames/{frame.id}/lan_access", json={"enabled": False})
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "applied", "lan_access": False}
    db.refresh(frame)
    assert frame.lan_access is False
    assert db.query(FrameCommand).filter_by(frame_id=frame.id).count() == 0


# ------------------------------------------------------ frame sync mirror


@pytest.mark.asyncio
async def test_the_sync_status_read_mirrors_the_devices_switch(async_client, db, redis):
    frame = await new_frame(db, redis, "Synced", "localhost", "localhost")
    frame.frame_admin_auth = {"enabled": True, "user": "admin", "pass": "secret"}
    frame.last_successful_deploy = frame.to_dict()
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.commit()
    remote_frame = {**frame.to_dict(), "id": 1, "lan_access": True}

    async def fetch(_frame, _redis, *, path, method="GET", body=None, headers=None):
        if path == "/api/admin/login":
            return 200, b'{"status":"ok"}', {"set-cookie": "frame_admin_session=s; Path=/"}
        return 200, json.dumps({"frame": remote_frame}).encode(), {"content-type": "application/json"}

    with patch("app.api.frames._fetch_frame_http_bytes", new=AsyncMock(side_effect=fetch)):
        response = await async_client.get(f"/api/frames/{frame.id}/sync")
    assert response.status_code == 200, response.text
    assert response.json()["frame"]["lan_access"] is True
    # Not a sync change: no "LAN access" row in the diff.
    changes = [change["path"] for section in response.json()["sync"]["sections"] for change in section["changes"]]
    assert not any("lan" in path.lower() for path in changes)
    db.refresh(frame)
    assert frame.lan_access is True
