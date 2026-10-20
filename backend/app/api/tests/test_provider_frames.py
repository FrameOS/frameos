"""A frame this backend is the provider of, through the backend's own routes.

Everything an owner does to such a frame becomes a contract verb on its
command queue (docs/cloud-frames.md), never SSH, the Remote, an admin login
or a LAN request. The socket that drains the queue is tested in
app/ws/tests/test_provider_hub.py; here the frame is away, so every verb
waits on the queue where the test can read it.
"""
from __future__ import annotations

import pytest

from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.models.frame_provider import FrameProviderLink
from app.utils.cloud_frames_contract import check_contract_settings
from app.utils.provider_frames import CLAIM_TOKEN_SCOPES, hash_secret, provider_profile
from app.utils.provider_payloads import provider_schedule_payload, provider_settings_payload, scenes_checksum

INTERPRETED = {"execution": "interpreted"}


def make_provider_frame(db, project_id: int, *, platform: str = "buildroot", version: str | None = "2026.10.17", **columns) -> Frame:
    values = {
        "project_id": project_id,
        "name": "Hall",
        "mode": "embedded" if platform.startswith("esp32") else platform,
        "frame_host": "",
        "status": "ready",
        "interval": 300,
        "scaling_mode": "cover",
        "rotate": 90,
        "device": "waveshare.EPD_7in5_V2",
        "scenes": [{"id": "s1", "name": "One", "nodes": [], "edges": [], "settings": INTERPRETED}],
        "schedule": {"events": []},
    }
    frame = Frame(**{**values, **columns})
    db.add(frame)
    db.flush()
    frame.provider_link = FrameProviderLink(
        project_id=project_id,
        frame_id=int(frame.id),
        public_key="A" * 43 + "=",
        token_hash=hash_secret(f"token-{frame.id}"),
        scopes=" ".join(CLAIM_TOKEN_SCOPES),
        status="active",
        connected=False,
        frameos_version=version,
        hardware={"platform": platform, "width": 800, "height": 480},
    )
    db.commit()
    db.refresh(frame)
    return frame


def commands(db, frame: Frame) -> list[FrameCommand]:
    db.expire_all()
    return (
        db.query(FrameCommand)
        .filter_by(frame_id=frame.id)
        .order_by(FrameCommand.created_at.asc(), FrameCommand.id.asc())
        .all()
    )


# ----------------------------------------------------------------- payloads

@pytest.mark.asyncio
async def test_settings_are_the_contract_keys_the_firmware_knows(db, project):
    frame = make_provider_frame(
        db, project.id, version="2026.8.29",
        flip="horizontal", debug=True, timezone="Europe/Tallinn",
        gpio_buttons=[{"pin": 5, "label": "Next", "role": "next"}],
    )
    settings = provider_settings_payload(frame)
    # The base six, never the 2026.8.30+ extended batch on older firmware.
    assert settings == {
        "name": "Hall", "rotate": 90, "interval": 300, "scaling_mode": "cover",
        "timezone": "Europe/Tallinn", "debug": True,
    }
    frame.provider_link.frameos_version = "2026.10.17"
    settings = provider_settings_payload(frame)
    assert settings["flip"] == "horizontal"
    assert settings["gpio_buttons"] == [{"pin": 5, "label": "Next", "role": "next"}]
    assert check_contract_settings(settings, "linux") is None


@pytest.mark.asyncio
async def test_button_roles_wait_for_the_input_batch(db, project):
    frame = make_provider_frame(db, project.id, version="2026.9.1", gpio_buttons=[{"pin": 5, "label": "Next", "role": "next"}])
    assert provider_settings_payload(frame)["gpio_buttons"] == [{"pin": 5, "label": "Next"}]


@pytest.mark.asyncio
async def test_an_esp32_gets_its_profile_and_its_tz_slice(db, project):
    frame = make_provider_frame(
        db, project.id, platform="esp32-s3", version="2026.10.17", timezone="Europe/Tallinn", flip="both",
        device_config={"deepSleep": True, "wakeCheckSeconds": 900},
    )
    assert provider_profile(frame) == "esp32"
    settings = provider_settings_payload(frame)
    assert "flip" not in settings  # a Linux-only key
    assert settings["deep_sleep"] is True and settings["wake_check_seconds"] == 900
    assert isinstance(settings.get("timezone_data"), dict)
    assert check_contract_settings(settings, "esp32") is None


@pytest.mark.asyncio
async def test_the_schedule_resolves_disabled_events(db, project):
    frame = make_provider_frame(db, project.id, schedule={"events": [
        {"id": "a", "hour": 7, "minute": 30, "weekday": 8, "event": "setCurrentScene", "payload": {"sceneId": "s1"}},
        {"id": "b", "hour": 8, "minute": 0, "event": "render", "disabled": True},
    ]})
    assert provider_schedule_payload(frame) == {"schedule": {"events": [
        {"id": "a", "minute": 30, "hour": 7, "weekday": 8, "event": "setCurrentScene", "payload": {"sceneId": "s1"}},
    ]}}
    frame.schedule = {"disabled": True, "events": [{"id": "a", "hour": 7, "minute": 30, "event": "render"}]}
    assert provider_schedule_payload(frame) == {"schedule": {"events": []}}


# ------------------------------------------------------------------ routes

@pytest.mark.asyncio
async def test_a_deploy_is_three_verbs(db, redis, project):
    from app.tasks.provider_deploy import deploy_over_provider_socket

    frame = make_provider_frame(db, project.id)
    frame.scenes = frame.scenes + [{"id": "nim", "name": "Old", "nodes": [], "edges": [], "settings": {"execution": "compiled"}}]
    db.commit()
    applied = await deploy_over_provider_socket(db, redis, int(frame.id), job_id=None, task_id=None)
    assert applied is False  # away: queued for its next connection
    rows = commands(db, frame)
    assert [row.type for row in rows] == ["set_settings", "set_schedule", "set_scenes", "refresh_service_settings"]
    settings_row, _schedule_row, scenes_row, _nudge = rows
    rows = rows[:3]
    assert settings_row.payload["settings"]["name"] == "Hall"
    # Only the interpreted scene: the device refuses a compiled payload.
    assert [scene["id"] for scene in scenes_row.payload["scenes"]] == ["s1"]
    assert scenes_row.payload["checksum"] == scenes_checksum(scenes_row.payload["scenes"])
    assert scenes_row.payload["_deploy"]["snapshot"]["frameos_version"] == "2026.10.17"
    assert all(row.expires_at is None for row in rows)


@pytest.mark.asyncio
async def test_saved_service_keys_nudge_the_frames_that_pull_them(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id)
    response = await async_client.post("/api/settings", json={"unsplash": {"accessKey": "new-key"}})
    assert response.status_code == 200
    assert [row.type for row in commands(db, frame)] == ["refresh_service_settings"]
    # A setting no frame pulls nudges nobody.
    await async_client.post("/api/settings", json={"defaults": {"timezone": "Europe/Tallinn"}})
    assert len(commands(db, frame)) == 1


@pytest.mark.asyncio
async def test_events_become_verbs(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id)
    response = await async_client.post(f"/api/frames/{frame.id}/event/render")
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    response = await async_client.post(
        f"/api/frames/{frame.id}/event/setCurrentScene", json={"sceneId": "s1", "state": {"n": 1}}
    )
    assert response.status_code == 200
    response = await async_client.post(f"/api/frames/{frame.id}/event/nextPage", json={"x": 1})
    assert response.status_code == 200
    rows = commands(db, frame)
    assert [(row.type, row.payload) for row in rows] == [
        ("render", None),
        ("set_current_scene", {"scene_id": "s1", "state": {"n": 1}}),
        ("scene_event", {"name": "nextPage", "payload": {"x": 1}}),
    ]
    # A device command is not an event this route sends.
    response = await async_client.post(f"/api/frames/{frame.id}/event/uploadScenes", json={"scenes": []})
    assert response.status_code in (200, 400)


@pytest.mark.asyncio
async def test_custom_events_wait_for_the_verb(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id, version="2026.9.1")
    response = await async_client.post(f"/api/frames/{frame.id}/event/nextPage", json={})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_restart_and_reboot_are_verbs(db, redis, project):
    from app.tasks.restart_frame import reboot_frame_task, restart_frame_task

    frame = make_provider_frame(db, project.id)
    await restart_frame_task({"db": db, "redis": redis}, int(frame.id))
    await reboot_frame_task({"db": db, "redis": redis}, int(frame.id))
    assert [row.type for row in commands(db, frame)] == ["restart_runtime", "reboot"]


@pytest.mark.asyncio
async def test_update_frameos_is_a_nudge(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id)
    response = await async_client.post(f"/api/frames/{frame.id}/device/upgrade", json={})
    assert response.status_code == 200
    assert [row.type for row in commands(db, frame)] == ["notify_update_available"]
    db.refresh(frame)
    assert frame.deploy_progress["kind"] == "upgrade"


@pytest.mark.asyncio
async def test_shell_verbs_are_refused(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id)
    for path in ("stop", "deploy_remote", "restart_remote", "clear_build_cache", "reset"):
        response = await async_client.post(f"/api/frames/{frame.id}/{path}")
        assert response.status_code == 400, path
        assert "management socket" in response.json()["detail"]


@pytest.mark.asyncio
async def test_ping_and_states_answer_from_the_link(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id)
    frame.provider_link.last_state = {"s1": {"n": 2}, "active_scene": "s1"}
    db.commit()
    ping = await async_client.get(f"/api/frames/{frame.id}/ping")
    assert ping.status_code == 200
    assert ping.json()["ok"] is False
    state = await async_client.get(f"/api/frames/{frame.id}/state")
    assert state.json() == {"sceneId": "s1", "state": {"n": 2}}
    listed = await async_client.get(f"/api/frames/{frame.id}")
    payload = listed.json()["frame"]
    assert payload["connected"] is False
    assert payload["frameos_version"] == "2026.10.17"
    assert payload["provider"]["status"] == "active"
    assert "token_hash" not in str(payload)


@pytest.mark.asyncio
async def test_an_away_frames_assets_say_so(db, redis, project, async_client):
    frame = make_provider_frame(db, project.id)
    response = await async_client.get(f"/api/frames/{frame.id}/assets")
    assert response.status_code == 503
