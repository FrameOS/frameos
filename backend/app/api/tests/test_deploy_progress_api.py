"""The frame row's deploy_progress end to end on the self-hosted backend:
the routes start the record in the kind the worker will run, the worker's
steps and the device's own lines move it, and every failure path closes it.
The fold itself is pinned by the contract's corpus
(app/utils/tests/test_deploy_progress.py); this is the wiring."""
from __future__ import annotations

import importlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.api.embedded_device import embedded_scenes_etag, embedded_settings_etag
from app.models.frame import Frame, new_frame
from app.models.log import process_log
from app.tasks.utils import (
    JobAlreadyQueuedError,
    advance_deploy_progress,
    begin_deploy_progress,
    deploy_progress_kind_for_frame,
    record_task_failure,
)
from app.utils import deploy_progress as dp
from app.utils.frame_commands import enqueue_frame_command
from app.utils.frame_secrets import deploy_snapshot

from .test_embedded_firmware import create_embedded_frame

tasks_package = importlib.import_module("app.tasks")


def _no_enqueue(monkeypatch, *names: str) -> dict[str, list]:
    calls: dict[str, list] = {name: [] for name in names}
    for name in names:
        async def fake(*args, _name=name, **kwargs):
            calls[_name].append((args, kwargs))
        monkeypatch.setattr(tasks_package, name, fake)
    return calls


# ------------------------------------------------------------------ kinds

@pytest.mark.asyncio
async def test_the_kind_follows_what_the_worker_will_do(async_client, db, redis):
    pi = await new_frame(db, redis, "Pi", "pi.local", "localhost", project_id=async_client.project_id)
    assert deploy_progress_kind_for_frame(pi, "full") == "linux_full"
    assert deploy_progress_kind_for_frame(pi, "fast") == "linux_fast"

    card = SimpleNamespace(mode="buildroot", agent={}, ssh_pass="", ssh_keys=None, buildroot={"adopted": True})
    assert deploy_progress_kind_for_frame(card, "full") == "admin_push"
    assert deploy_progress_kind_for_frame(card, "fast") == "admin_push"

    esp32 = db.get(Frame, (await create_embedded_frame(async_client))["id"])
    assert deploy_progress_kind_for_frame(esp32, "full") == "esp32_full"
    assert deploy_progress_kind_for_frame(esp32, "fast") == "esp32_fast"


# ------------------------------------------------------------------ routes

@pytest.mark.asyncio
@pytest.mark.parametrize("verb, task_name, kind", [
    ("deploy", "deploy_frame", "linux_full"),
    ("fast_deploy", "fast_deploy_frame", "linux_fast"),
])
async def test_a_deploy_route_starts_the_bar_with_the_click(async_client, db, redis, monkeypatch, verb, task_name, kind):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost", project_id=async_client.project_id)
    calls = _no_enqueue(monkeypatch, task_name)

    response = await async_client.post(f"/api/frames/{frame.id}/{verb}?task_id={verb}:{frame.id}:abc")

    assert response.status_code == 200, response.text
    assert len(calls[task_name]) == 1
    db.expire_all()
    record = db.get(Frame, frame.id).deploy_progress
    assert record["kind"] == kind
    assert record["stage"] == "queued"
    assert record["status"] == "running"
    # The task id is the record's id: the browser's toast follows its bar.
    assert record["id"] == f"{verb}:{frame.id}:abc"
    # The frame GET serves it, so a reload shows the bar too.
    served = (await async_client.get(f"/api/frames/{frame.id}")).json()["frame"]
    assert served["deploy_progress"]["stage"] == "queued"


@pytest.mark.asyncio
async def test_a_refused_enqueue_says_so_on_the_bar(async_client, db, redis, monkeypatch):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost", project_id=async_client.project_id)

    async def already_queued(_id, _redis, **_kwargs):
        raise JobAlreadyQueuedError("A deploy_frame job with id 'x' is already queued or ran recently")

    monkeypatch.setattr(tasks_package, "deploy_frame", already_queued)
    response = await async_client.post(f"/api/frames/{frame.id}/deploy?task_id=deploy:{frame.id}:x")

    assert response.status_code == 409
    db.expire_all()
    record = db.get(Frame, frame.id).deploy_progress
    assert record["status"] == "error"
    assert "already queued" in record["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, task_name", [("restart", "restart_frame"), ("reboot", "reboot_frame")])
async def test_restart_and_reboot_routes_start_their_own_kind(async_client, db, redis, monkeypatch, verb, task_name):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost", project_id=async_client.project_id)
    _no_enqueue(monkeypatch, task_name)

    response = await async_client.post(f"/api/frames/{frame.id}/{verb}")

    assert response.status_code == 200, response.text
    db.expire_all()
    record = db.get(Frame, frame.id).deploy_progress
    assert (record["kind"], record["stage"]) == (verb, "queued")


@pytest.mark.asyncio
async def test_the_esp32_ota_route_starts_a_firmware_bar_that_waits_for_a_sleeping_frame(async_client, db, redis):
    frame = db.get(Frame, (await create_embedded_frame(async_client))["id"])
    with patch(
        "app.api.frames.request_embedded_firmware_update",
        new=AsyncMock(return_value={"applied": False, "status": "pending"}),
    ):
        response = await async_client.post(f"/api/frames/{frame.id}/embedded/firmware/ota")
    assert response.status_code == 200, response.text
    db.expire_all()
    record = db.get(Frame, frame.id).deploy_progress
    assert (record["kind"], record["stage"], record["status"]) == ("firmware", "waiting", "running")


# ------------------------------------------------------- the device's lines

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_the_bootup_and_the_first_render_finish_a_full_deploy(mock_pub, db, redis):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost")
    await begin_deploy_progress(db, redis, frame, "linux_full", deploy_id="d1", stage="installing")

    # A render of the runtime that is about to be replaced moves nothing.
    await process_log(db, redis, frame, {"event": "render:done", "sceneId": "old"})
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "installing"

    assert await advance_deploy_progress(db, redis, frame, "restarting", kind="linux_full")
    await process_log(db, redis, frame, {"event": "bootup", "version": "2026.10.11"})
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "rendering"

    # The worker finishing after the device came back moves nothing back.
    assert not await advance_deploy_progress(db, redis, frame, "booting", kind="linux_full")
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "rendering"

    await process_log(db, redis, frame, {"event": "render:done", "sceneId": "new"})
    record = db.get(Frame, frame.id).deploy_progress
    assert (record["stage"], record["status"]) == ("done", "done")


@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_a_runtime_upgrade_follows_the_cloud_upgrade_lines(mock_pub, db, redis):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost")
    await begin_deploy_progress(db, redis, frame, "upgrade", deploy_id="u1")

    await process_log(db, redis, frame, {"event": "cloud:upgrade", "status": "running", "latest_version": "2026.10.11"})
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "downloading"
    await process_log(db, redis, frame, {"event": "cloud:upgrade", "status": "success"})
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "verified"
    await process_log(db, redis, frame, {"event": "bootup", "version": "2026.10.11"})
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "rendering"


# --------------------------------------------------------- the queue's acks

@pytest.mark.asyncio
async def test_esp32_queue_acks_move_a_full_deploy_to_its_first_render(async_client, no_auth_client, db, redis):
    frame = db.get(Frame, (await create_embedded_frame(async_client))["id"])
    frame.scenes = [{"id": "clock", "name": "Clock", "nodes": [], "edges": []}]
    frame.last_log_at = datetime(2026, 10, 11, 10, 0, 0)
    db.commit()
    headers = {"Authorization": f"Bearer {frame.server_api_key}"}

    await begin_deploy_progress(db, redis, frame, "esp32_full", deploy_id="d1", stage="waiting")
    deploy = {"_deploy": {"id": "deploy-1", "snapshot": frame.to_dict()}}
    enqueue_frame_command(db, frame, "set_scenes", deploy)
    enqueue_frame_command(db, frame, "set_settings", {"_deploy": {"id": "deploy-1"}})
    notify = enqueue_frame_command(db, frame, "notify_update_available", None)

    # The device takes the update check: downloading.
    pulled = await no_auth_client.post(f"/api/frames/{frame.id}/embedded/commands", json={}, headers=headers)
    assert pulled.status_code == 200
    acked = await no_auth_client.post(
        f"/api/frames/{frame.id}/embedded/commands/{notify.id}/ack", json={"ok": True}, headers=headers
    )
    assert acked.status_code == 200
    db.expire_all()
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "downloading"

    # Its boot on the new release, then the pull that reports what it holds.
    with patch("app.models.log.publish_message", new_callable=AsyncMock):
        await process_log(db, redis, db.get(Frame, frame.id), {"event": "bootup", "version": "2026.10.11"})
    db.expire_all()
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "receiving"

    frame = db.get(Frame, frame.id)
    body = {"scenes_checksum": embedded_scenes_etag(frame), "settings_etag": embedded_settings_etag(db, frame)}
    pulled = await no_auth_client.post(f"/api/frames/{frame.id}/embedded/commands", json=body, headers=headers)
    assert pulled.status_code == 200
    db.expire_all()
    assert db.get(Frame, frame.id).deploy_progress["stage"] == "rendering"


# ------------------------------------------------------------- failures

@pytest.mark.asyncio
async def test_a_task_failure_closes_the_bar(db, redis):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost")
    await begin_deploy_progress(db, redis, frame, "linux_full", deploy_id="d1", stage="building")

    await record_task_failure(db, redis, int(frame.id), RuntimeError("cross compile failed"), frame=frame)

    record = db.get(Frame, frame.id).deploy_progress
    assert record["status"] == "error"
    assert "cross compile failed" in record["error"]


@pytest.mark.asyncio
async def test_cancelling_a_deploy_closes_the_bar(db, redis):
    from app.tasks.deploy_frame import cancel_active_deploy

    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost")
    frame.status = "deploying"
    db.commit()
    await begin_deploy_progress(db, redis, frame, "linux_full", deploy_id="d1", stage="uploading")

    await cancel_active_deploy(db, redis, frame)

    record = db.get(Frame, frame.id).deploy_progress
    assert (record["status"], record["error"]) == ("error", "cancelled")


# ------------------------------------------------------------- baseline

@pytest.mark.asyncio
async def test_the_record_is_telemetry_not_configuration(db, redis):
    frame = await new_frame(db, redis, "Pi", "pi.local", "localhost")
    await begin_deploy_progress(db, redis, frame, "linux_fast", deploy_id="d1")
    assert "deploy_progress" in frame.to_dict()
    assert "deploy_progress" not in deploy_snapshot(frame.to_dict())


def test_a_stale_record_is_not_running():
    now = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
    record = dp.start("linux_full", deploy_id="x", now=now, stage="booting")
    assert dp.is_running(record, now + timedelta(seconds=60))
    assert not dp.is_running(record, now + timedelta(hours=1))
