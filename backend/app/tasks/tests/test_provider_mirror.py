"""The provider mirror: the hub's fleet-socket events onto the backend's rows.

The events are the cloud hub's (cloud/apps/frame-hub, browserEvent): an
`update_frame` carries the cloud's frameSummary plus last_state, a `new_log`
the stored line as JSON text, a `new_metrics` the sample.
"""
from __future__ import annotations

import json

import pytest

from app.api.tests.test_provider_frames import make_provider_frame
from app.models.frame import Frame
from app.models.log import Log
from app.models.metrics import Metrics
from app.tasks.provider_mirror import apply_event



def remote(db, frame: Frame, remote_id: str = "8a3f6c2e-1b4d-4e5f-9a0b-1c2d3e4f5a6b") -> str:
    frame.provider_link.remote_frame_id = remote_id
    db.commit()
    return remote_id


@pytest.mark.asyncio
async def test_an_update_lands_on_the_link_and_the_frame(db, redis, project, fake_bridge):
    frame = make_provider_frame(db, project.id)
    remote_id = remote(db, frame)
    progress = {"id": "c1", "kind": "cloud_scenes", "stage": "rendering", "status": "running",
                "at": "2026-10-20T01:00:00.000Z", "started_at": "2026-10-20T01:00:00.000Z"}
    await apply_event(redis, {"event": "update_frame", "data": {
        "id": remote_id,
        "connected": True,
        "last_seen_at": "2026-10-20T01:00:05.000Z",
        "frameos_version": "2026.10.18",
        "hardware": {"platform": "buildroot", "width": 1024, "height": 600, "device": "framebuffer"},
        "scenes_checksum": "abc",
        "last_state": {"s1": {"n": 3}, "active_scene": "s1"},
        "deploy_progress": progress,
        "firmware_update": None,
        "next_wake_at": None,
        "next_render_at": None,
        "sleep_reason": None,
    }})
    db.expire_all()
    frame = db.get(Frame, frame.id)
    link = frame.provider_link
    assert link.connected is True
    assert link.frameos_version == "2026.10.18"
    assert link.scenes_checksum == "abc"
    assert link.last_state == {"s1": {"n": 3}, "active_scene": "s1"}
    assert (frame.width, frame.height, frame.device) == (1024, 600, "framebuffer")
    assert frame.deploy_progress == progress
    assert await redis.get(f"frame:{frame.id}:active_scene") == b"s1"


@pytest.mark.asyncio
async def test_an_unknown_frame_is_ignored(db, redis, project, fake_bridge):
    await apply_event(redis, {"event": "update_frame", "data": {"id": "nobody", "connected": True}})
    await apply_event(redis, {"event": "something_new", "data": {}})


@pytest.mark.asyncio
async def test_logs_and_metrics_land_where_every_frame_keeps_them(db, redis, project, fake_bridge):
    frame = make_provider_frame(db, project.id)
    remote_id = remote(db, frame)
    await apply_event(redis, {"event": "new_log", "data": {
        "frame_id": remote_id, "id": 1, "type": "webhook",
        "line": json.dumps({"event": "render:done", "sceneId": "s1"}), "timestamp": "2026-10-20T01:00:00.000Z",
    }})
    await apply_event(redis, {"event": "new_metrics", "data": {
        "frame_id": remote_id, "metrics": {"memoryUsage": {"used": 1}}, "timestamp": "2026-10-20T01:00:00.000Z",
    }})
    lines = [json.loads(row.line) for row in db.query(Log).filter_by(frame_id=frame.id, type="webhook").all()]
    assert lines == [{"event": "render:done", "sceneId": "s1"}]
    assert db.query(Metrics).filter_by(frame_id=frame.id).count() == 1
    # process_log folded the render line exactly as for /api/log.
    db.expire_all()
    assert db.get(Frame, frame.id).status == "ready"


@pytest.mark.asyncio
async def test_the_scenes_a_frame_joined_with_are_imported_once(db, redis, project, fake_bridge):
    frame = make_provider_frame(db, project.id, scenes=[])
    remote_id = remote(db, frame)
    fake_bridge.device_scenes_documents[remote_id] = {"scenes": [{"id": "mine", "name": "Mine", "nodes": [], "edges": []}]}
    for _ in range(2):
        await apply_event(redis, {"event": "update_frame", "data": {"id": remote_id, "connected": True}})
    db.expire_all()
    assert [scene["id"] for scene in db.get(Frame, frame.id).scenes] == ["mine"]
    assert fake_bridge.imported == [remote_id]
