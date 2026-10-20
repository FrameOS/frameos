"""The frame command queue's rules (app/utils/frame_commands.py): the cloud's
queue semantics, checked against a real table."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models.frame import Frame, new_frame
from app.models.frame_command import FrameCommand
from app.utils.frame_commands import (
    ASSET_TTL_SECONDS,
    COMMAND_TTL_SECONDS,
    REDELIVER_AFTER_SECONDS,
    UPDATE_NOTIFY_TTL_SECONDS,
    ack_frame_command,
    ack_pull_backed_commands,
    cancel_frame_command,
    command_ttl_for_frame,
    deploy_commands_settled,
    deploy_snapshot_for,
    drain_frame_commands,
    enqueue_frame_command,
    frame_command_public,
    frame_command_wire,
    frame_is_asleep,
    list_pending_frame_commands,
    pending_command_count,
    pending_command_types,
    pending_command_types_by_frame,
)

NOW = datetime(2026, 10, 11, 12, 0, 0)


async def _frame(db, redis) -> Frame:
    frame = await new_frame(db, redis, "Queue frame", "localhost", "localhost")
    frame.mode = "embedded"
    db.commit()
    return frame


@pytest.mark.asyncio
async def test_ttl_follows_the_type_and_the_sleep_forecast(db, redis):
    frame = await _frame(db, redis)
    # Awake, or no forecast: the base TTL.
    assert command_ttl_for_frame(frame, COMMAND_TTL_SECONDS, NOW) == NOW + timedelta(seconds=COMMAND_TTL_SECONDS)
    # A deploy never expires.
    assert command_ttl_for_frame(frame, None, NOW) is None
    # Asleep for 15 minutes: the deadline reaches past the wake by the base
    # TTL, so a 5-minute command is not dead before the frame can see it.
    frame.next_wake_at = NOW + timedelta(minutes=15)
    assert frame_is_asleep(frame, NOW)
    assert command_ttl_for_frame(frame, COMMAND_TTL_SECONDS, NOW) == NOW + timedelta(minutes=15, seconds=COMMAND_TTL_SECONDS)
    # A wake in the past is no forecast at all.
    frame.next_wake_at = NOW - timedelta(minutes=1)
    assert not frame_is_asleep(frame, NOW)
    assert command_ttl_for_frame(frame, COMMAND_TTL_SECONDS, NOW) == NOW + timedelta(seconds=COMMAND_TTL_SECONDS)


@pytest.mark.asyncio
async def test_enqueue_sizes_the_ttl_per_type(db, redis):
    frame = await _frame(db, redis)
    render = enqueue_frame_command(db, frame, "render", now=NOW)
    notify = enqueue_frame_command(db, frame, "notify_update_available", now=NOW)
    deploy = enqueue_frame_command(db, frame, "set_scenes", {"_deploy": {"id": "d1"}}, now=NOW)
    assert render.expires_at == NOW + timedelta(seconds=COMMAND_TTL_SECONDS)
    assert notify.expires_at == NOW + timedelta(seconds=UPDATE_NOTIFY_TTL_SECONDS)
    assert deploy.expires_at is None
    assert render.status == notify.status == deploy.status == "pending"
    # A provider frame takes every contract verb; a file transfer or a query
    # keeps only while someone waits for it.
    asset = enqueue_frame_command(db, frame, "asset_get", {"path": "a.png"}, now=NOW)
    assert asset.expires_at == NOW + timedelta(seconds=ASSET_TTL_SECONDS)
    schedule = enqueue_frame_command(db, frame, "set_schedule", {"schedule": {"events": []}}, now=NOW)
    assert schedule.expires_at is None
    with pytest.raises(ValueError):
        enqueue_frame_command(db, frame, "shell", now=NOW)


@pytest.mark.asyncio
async def test_a_newer_command_supersedes_the_older_one_of_its_type(db, redis):
    frame = await _frame(db, redis)
    first = enqueue_frame_command(db, frame, "set_current_scene", {"scene_id": "a"}, now=NOW)
    second = enqueue_frame_command(db, frame, "set_current_scene", {"scene_id": "b"}, now=NOW + timedelta(seconds=1))
    db.refresh(first)
    assert first.status == "expired" and first.error == "superseded"
    assert second.status == "pending"
    # Two presses are two presses: scene events are never superseded.
    press_a = enqueue_frame_command(db, frame, "scene_event", {"name": "button"}, now=NOW)
    press_b = enqueue_frame_command(db, frame, "scene_event", {"name": "button"}, now=NOW + timedelta(seconds=1))
    db.refresh(press_a)
    assert press_a.status == press_b.status == "pending"


@pytest.mark.asyncio
async def test_drain_hands_over_pending_commands_oldest_first_and_marks_them_sent(db, redis):
    frame = await _frame(db, redis)
    enqueue_frame_command(db, frame, "render", now=NOW)
    enqueue_frame_command(db, frame, "scene_event", {"name": "button", "payload": {"label": "next"}}, now=NOW + timedelta(seconds=1))
    # A deploy row is pull-backed: never handed to the device.
    enqueue_frame_command(db, frame, "set_scenes", {"_deploy": {"id": "d1"}}, now=NOW + timedelta(seconds=2))
    handed = drain_frame_commands(db, frame, NOW + timedelta(seconds=3))
    db.commit()
    assert [row.type for row in handed] == ["render", "scene_event"]
    assert all(row.status == "sent" and row.sent_at == NOW + timedelta(seconds=3) for row in handed)
    wire = frame_command_wire(handed[1])
    assert wire == {"id": handed[1].id, "type": "scene_event", "name": "button", "payload": {"label": "next"}}
    # A second drain right away hands over nothing: the device is still
    # inside its answer window.
    assert drain_frame_commands(db, frame, NOW + timedelta(seconds=4)) == []


@pytest.mark.asyncio
async def test_drain_redelivers_what_went_unacked_and_retires_at_most_once_verbs(db, redis):
    frame = await _frame(db, redis)
    render = enqueue_frame_command(db, frame, "render", now=NOW)
    reboot = enqueue_frame_command(db, frame, "reboot", now=NOW)
    event = enqueue_frame_command(db, frame, "scene_event", {"name": "button"}, now=NOW)
    drain_frame_commands(db, frame, NOW)
    db.commit()
    later = NOW + timedelta(seconds=REDELIVER_AFTER_SECONDS + 1)
    handed = drain_frame_commands(db, frame, later)
    db.commit()
    db.refresh(render)
    db.refresh(reboot)
    db.refresh(event)
    # The idempotent verb goes again; the reboot and the press do not.
    assert [row.id for row in handed] == [render.id]
    assert render.status == "sent" and render.sent_at == later
    assert reboot.status == "expired" and reboot.error == "delivered_once"
    assert event.status == "expired" and event.error == "delivered_once"


@pytest.mark.asyncio
async def test_drain_expires_commands_past_their_ttl(db, redis):
    frame = await _frame(db, redis)
    render = enqueue_frame_command(db, frame, "render", now=NOW)
    handed = drain_frame_commands(db, frame, NOW + timedelta(seconds=COMMAND_TTL_SECONDS + 1))
    db.commit()
    db.refresh(render)
    assert handed == []
    assert render.status == "expired" and render.error == "ttl"


@pytest.mark.asyncio
async def test_ack_by_id_once(db, redis):
    frame = await _frame(db, redis)
    render = enqueue_frame_command(db, frame, "render", now=NOW)
    drain_frame_commands(db, frame, NOW)
    db.commit()
    acked = ack_frame_command(db, frame, render.id, ok=True, now=NOW + timedelta(seconds=1))
    db.commit()
    assert acked is render and render.status == "acked" and render.acked_at == NOW + timedelta(seconds=1)
    # A repeat answer (at-least-once delivery) changes nothing.
    ack_frame_command(db, frame, render.id, ok=False, error="busy", now=NOW + timedelta(seconds=2))
    db.commit()
    db.refresh(render)
    assert render.status == "acked" and render.error is None
    # A refusal keeps the device's reason.
    event = enqueue_frame_command(db, frame, "scene_event", {"name": "button"}, now=NOW)
    ack_frame_command(db, frame, event.id, ok=False, error="busy", now=NOW)
    db.commit()
    assert event.status == "failed" and event.error == "busy"
    # Another frame's command is not this frame's to ack.
    other = await new_frame(db, redis, "Other", "localhost", "localhost")
    assert ack_frame_command(db, other, render.id, ok=True) is None
    assert ack_frame_command(db, frame, "nope", ok=True) is None


@pytest.mark.asyncio
async def test_pull_backed_rows_ack_on_the_checksum_the_device_reports(db, redis):
    frame = await _frame(db, redis)
    scenes = enqueue_frame_command(db, frame, "set_scenes", {"_deploy": {"id": "d1", "snapshot": {"name": "x"}}}, now=NOW)
    settings = enqueue_frame_command(db, frame, "set_settings", {"_deploy": {"id": "d1"}}, now=NOW)
    # The device said nothing about its settings pull: those rows wait.
    acked = ack_pull_backed_commands(db, frame, scenes_current=True, settings_current=None, now=NOW)
    db.commit()
    assert [row.id for row in acked] == [scenes.id]
    assert scenes.status == "acked" and settings.status == "pending"
    assert not deploy_commands_settled(db, frame, "d1")
    assert deploy_snapshot_for(db, frame, "d1") == {"name": "x"}
    # A stale settings pull does not ack either.
    assert ack_pull_backed_commands(db, frame, scenes_current=True, settings_current=False, now=NOW) == []
    acked = ack_pull_backed_commands(db, frame, scenes_current=False, settings_current=True, now=NOW)
    db.commit()
    assert [row.id for row in acked] == [settings.id]
    assert deploy_commands_settled(db, frame, "d1")
    # The snapshot is still there after the rows are done: it is what gets
    # recorded as the deploy baseline.
    assert deploy_snapshot_for(db, frame, "d1") == {"name": "x"}


@pytest.mark.asyncio
async def test_listing_and_cancel(db, redis):
    frame = await _frame(db, redis)
    switch = enqueue_frame_command(db, frame, "set_current_scene", {"scene_id": "clock", "state": {"a": 1}}, detail="Clock", now=NOW)
    deploy = enqueue_frame_command(db, frame, "set_scenes", {"_deploy": {"id": "d1", "snapshot": {}}}, detail="3 scenes", now=NOW + timedelta(seconds=1))
    old = enqueue_frame_command(db, frame, "render", now=NOW - timedelta(hours=1))
    listed = list_pending_frame_commands(db, frame, NOW + timedelta(seconds=2))
    # Expired rows are filtered, not swept.
    assert [row["type"] for row in listed] == ["set_current_scene", "set_scenes"]
    db.refresh(old)
    assert old.status == "pending"
    public = listed[0]
    assert public["scene_id"] == "clock" and public["detail"] == "Clock" and "state" not in public
    assert public["status"] == "pending" and public["sent_at"] is None
    assert public["expires_at"] is not None and public["created_at"].endswith("+00:00")
    assert "payload" not in listed[1] and listed[1]["detail"] == "3 scenes"
    assert pending_command_count(db, frame, NOW + timedelta(seconds=2)) == 2

    assert cancel_frame_command(db, frame, switch.id, NOW + timedelta(seconds=2))
    db.refresh(switch)
    assert switch.status == "expired" and switch.error == "cancelled"
    # Already cancelled, expired, or not this frame's: nothing to cancel.
    assert not cancel_frame_command(db, frame, switch.id, NOW + timedelta(seconds=2))
    assert not cancel_frame_command(db, frame, old.id, NOW + timedelta(seconds=2))
    other = await new_frame(db, redis, "Other", "localhost", "localhost")
    assert not cancel_frame_command(db, other, deploy.id, NOW)
    assert frame_command_public(deploy)["status"] == "pending"
    assert db.query(FrameCommand).count() == 3


@pytest.mark.asyncio
async def test_pending_command_types_names_the_live_verbs_once(db, redis):
    """What the frames list and the update_frame broadcast carry as
    `pending_command_types`: the workspace says "update queued" from it."""
    frame = await _frame(db, redis)
    other = await _frame(db, redis)
    assert pending_command_types(db, frame, NOW) == []
    assert pending_command_types_by_frame(db, int(frame.project_id), NOW) == {}

    enqueue_frame_command(db, frame, "notify_update_available", detail="2026.10.6", now=NOW)
    enqueue_frame_command(db, frame, "render", now=NOW)
    enqueue_frame_command(db, frame, "render", now=NOW + timedelta(seconds=1))
    enqueue_frame_command(db, other, "reboot", now=NOW)
    assert pending_command_types(db, frame, NOW) == ["notify_update_available", "render"]
    assert pending_command_types_by_frame(db, int(frame.project_id), NOW) == {
        int(frame.id): ["notify_update_available", "render"],
        int(other.id): ["reboot"],
    }

    # A row past its TTL is not pending, even before the sweep retires it;
    # a sent-but-unacked one still is.
    drained = drain_frame_commands(db, frame, NOW + timedelta(seconds=2))
    assert [command.status for command in drained] == ["sent", "sent"]
    assert pending_command_types(db, frame, NOW + timedelta(seconds=2)) == ["notify_update_available", "render"]
    late = NOW + timedelta(seconds=UPDATE_NOTIFY_TTL_SECONDS + 10)
    assert "notify_update_available" not in pending_command_types(db, frame, late)
