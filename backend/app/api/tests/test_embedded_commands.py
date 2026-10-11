"""The frame command queue end to end: the device's pull and ack routes
(app/api/embedded_commands.py), the owner's queue routes, and the producers
that queue instead of pushing for an ESP32 (events, scene switches, OTA)."""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest

from app.api.embedded_device import embedded_scenes_etag, embedded_settings_etag
from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.models.log import process_log
from app.utils.frame_commands import enqueue_frame_command

from .test_embedded_firmware import create_embedded_frame


async def _embedded_frame(async_client, db) -> Frame:
    frame_json = await create_embedded_frame(async_client)
    frame = db.get(Frame, frame_json['id'])
    frame.scenes = [{"id": "clock", "name": "Clock", "nodes": [], "edges": []}]
    frame.last_log_at = datetime(2026, 10, 11, 10, 0, 0)
    db.commit()
    return frame


def _device_headers(frame: Frame) -> dict[str, str]:
    return {'Authorization': f'Bearer {frame.server_api_key}'}


def _no_nudge():
    return patch('app.utils.embedded_commands.nudge_embedded_frame', new_callable=AsyncMock, return_value=False)


# ------------------------------------------------------------ device routes

@pytest.mark.asyncio
async def test_device_routes_require_the_frames_key(async_client, no_auth_client, db):
    frame = await _embedded_frame(async_client, db)
    response = await no_auth_client.post(f'/api/frames/{frame.id}/embedded/commands', json={})
    assert response.status_code == 401
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands', json={}, headers={'Authorization': 'Bearer nope'}
    )
    assert response.status_code == 401
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands/x/ack', json={'ok': True}, headers={'Authorization': 'Bearer nope'}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_pull_hands_over_the_queue_and_the_ack_closes_it(async_client, no_auth_client, db, redis):
    frame = await _embedded_frame(async_client, db)
    switch = enqueue_frame_command(db, frame, 'set_current_scene', {'scene_id': 'clock', 'state': {'size': 3}}, detail='Clock')
    frame.next_wake_at = datetime(2026, 10, 11, 12, 0, 0)
    frame.sleep_reason = 'battery'
    db.commit()

    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands',
        json={'frameos_version': '2026.10.5', 'active_scene': 'clock', 'states': {'size': 1}},
        headers=_device_headers(frame),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['commands'] == [{'id': switch.id, 'type': 'set_current_scene', 'scene_id': 'clock', 'state': {'size': 3}}]
    assert body['pending'] == 1
    assert body['sync'] is False
    db.refresh(switch)
    assert switch.status == 'sent' and switch.sent_at is not None
    # The device is talking: its sleep forecast is spent.
    db.refresh(frame)
    assert frame.next_wake_at is None and frame.sleep_reason is None
    # What it said it shows is what the workspace reads, without a device round trip.
    states = await async_client.get(f'/api/frames/{frame.id}/states')
    assert states.status_code == 200
    assert states.json()['sceneId'] == 'clock'
    assert states.json()['states'] == {'clock': {'size': 1}}

    # The owner's view while it waits.
    listing = await async_client.get(f'/api/frames/{frame.id}/commands')
    assert listing.status_code == 200
    assert [row['status'] for row in listing.json()['commands']] == ['sent']
    assert listing.json()['commands'][0]['scene_id'] == 'clock'
    assert listing.json()['commands'][0]['detail'] == 'Clock'

    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands/{switch.id}/ack',
        json={'ok': True, 'active_scene': 'clock', 'states': {'size': 3}},
        headers=_device_headers(frame),
    )
    assert response.status_code == 200, response.text
    assert response.json() == {'ok': True, 'status': 'acked'}
    db.refresh(switch)
    assert switch.status == 'acked'
    states = await async_client.get(f'/api/frames/{frame.id}/states')
    assert states.json()['states'] == {'clock': {'size': 3}}
    listing = await async_client.get(f'/api/frames/{frame.id}/commands')
    assert listing.json()['commands'] == []
    # Nothing left to cancel.
    cancel = await async_client.delete(f'/api/frames/{frame.id}/commands/{switch.id}')
    assert cancel.status_code == 404


@pytest.mark.asyncio
async def test_ack_records_a_refusal_and_rejects_bad_shapes(async_client, no_auth_client, db):
    frame = await _embedded_frame(async_client, db)
    event = enqueue_frame_command(db, frame, 'scene_event', {'name': 'button'})
    headers = _device_headers(frame)
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands/{event.id}/ack', json={'ok': 'yes'}, headers=headers
    )
    assert response.status_code == 400
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands/unknown/ack', json={'ok': True}, headers=headers
    )
    assert response.status_code == 404
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands/{event.id}/ack', json={'ok': False, 'error': 'busy'}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()['status'] == 'failed'
    db.refresh(event)
    assert event.status == 'failed' and event.error == 'busy'


@pytest.mark.asyncio
async def test_pull_acks_a_deploy_when_the_device_holds_the_current_pulls(async_client, no_auth_client, db):
    frame = await _embedded_frame(async_client, db)
    snapshot = {'id': frame.id, 'name': 'ESP32 Frame', 'mode': 'embedded'}
    enqueue_frame_command(db, frame, 'set_scenes', {'_deploy': {'id': 'd1', 'snapshot': snapshot}}, detail='1 scene')
    enqueue_frame_command(db, frame, 'set_settings', {'_deploy': {'id': 'd1'}}, detail='live settings')
    headers = _device_headers(frame)

    # Stale ETags: the rows wait, and they are never handed over as verbs.
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands',
        json={'scenes_etag': '"old"', 'settings_etag': '"old"'},
        headers=headers,
    )
    assert response.status_code == 200
    # ...and the device is told to pull now, whatever its own sync rules say.
    assert response.json() == {'commands': [], 'pending': 2, 'sync': True}
    db.refresh(frame)
    assert frame.last_successful_deploy is None

    # The scenes pull landed, the settings pull did not yet.
    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands',
        json={'scenes_etag': embedded_scenes_etag(frame), 'settings_etag': '"old"'},
        headers=headers,
    )
    assert response.json()['pending'] == 1
    db.refresh(frame)
    assert frame.last_successful_deploy is None

    response = await no_auth_client.post(
        f'/api/frames/{frame.id}/embedded/commands',
        json={'scenes_etag': embedded_scenes_etag(frame), 'settings_etag': embedded_settings_etag(db, frame)},
        headers=headers,
    )
    assert response.json()['pending'] == 0
    assert response.json()['sync'] is False
    db.refresh(frame)
    assert frame.last_successful_deploy is not None
    assert frame.last_successful_deploy['name'] == 'ESP32 Frame'
    assert frame.last_successful_deploy_at is not None
    rows = db.query(FrameCommand).filter_by(frame_id=frame.id).all()
    assert {row.status for row in rows} == {'acked'}


# ------------------------------------------------------------- owner routes

@pytest.mark.asyncio
async def test_owner_lists_and_cancels_queued_commands(async_client, db):
    frame = await _embedded_frame(async_client, db)
    render = enqueue_frame_command(db, frame, 'render')
    listing = await async_client.get(f'/api/frames/{frame.id}/commands')
    assert listing.status_code == 200
    (row,) = listing.json()['commands']
    assert row['id'] == render.id and row['type'] == 'render' and row['status'] == 'pending'
    assert row['expires_at'] is not None and row['sent_at'] is None
    cancel = await async_client.delete(f'/api/frames/{frame.id}/commands/{render.id}')
    assert cancel.status_code == 200
    db.refresh(render)
    assert render.status == 'expired' and render.error == 'cancelled'
    assert (await async_client.get(f'/api/frames/{frame.id}/commands')).json()['commands'] == []
    assert (await async_client.delete(f'/api/frames/{frame.id}/commands/{render.id}')).status_code == 404


# ---------------------------------------------------------------- producers

@pytest.mark.asyncio
async def test_event_route_queues_for_an_embedded_frame(async_client, db):
    frame = await _embedded_frame(async_client, db)
    with _no_nudge() as nudge, patch('app.api.frames._forward_frame_request', new_callable=AsyncMock) as forward:
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': 'clock', 'state': {'size': 2}}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body['status'] == 'queued' and body['applied'] is False
        assert body['command']['type'] == 'set_current_scene'
        assert body['command']['scene_id'] == 'clock'
        assert body['command']['detail'] == 'Clock'

        # A state change for the showing scene: the contract's scene_event.
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setSceneState', json={'state': {'size': 4}, 'render': True}
        )
        assert response.status_code == 200, response.text
        assert response.json()['command']['type'] == 'scene_event'

        # A custom scene event rides the same verb.
        response = await async_client.post(f'/api/frames/{frame.id}/event/nextPage', json={})
        assert response.status_code == 200, response.text
        assert response.json()['command']['type'] == 'scene_event'

        response = await async_client.post(f'/api/frames/{frame.id}/event/render', json={})
        assert response.status_code == 200, response.text
        assert response.json()['command']['type'] == 'render'

        assert nudge.await_count == 4
        forward.assert_not_awaited()

        # A preview on the frame is still a push: it must reach the device now
        # or fail now, and the queue does not carry a scene bundle.
        forward.return_value = 'OK'
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/uploadScenes', json={'scenes': [{'id': 'p', 'nodes': [], 'edges': []}]}
        )
        assert response.status_code == 200, response.text
        forward.assert_awaited_once()

    rows = db.query(FrameCommand).filter_by(frame_id=frame.id).order_by(FrameCommand.created_at).all()
    assert [row.type for row in rows] == ['set_current_scene', 'scene_event', 'scene_event', 'render']
    assert rows[0].payload == {'scene_id': 'clock', 'state': {'size': 2}}
    assert rows[1].payload == {'name': 'setSceneState', 'payload': {'state': {'size': 4}, 'render': True}}
    assert rows[2].payload == {'name': 'nextPage', 'payload': {}}


@pytest.mark.asyncio
async def test_event_route_reports_a_refusal(async_client, db):
    frame = await _embedded_frame(async_client, db)

    async def refuse(_db, _frame, command_id, _timeout):
        command = db.get(FrameCommand, command_id)
        command.status = 'failed'
        command.error = 'unknown_scene'
        db.commit()
        return command

    with patch('app.utils.embedded_commands.nudge_embedded_frame', new_callable=AsyncMock, return_value=True), \
            patch('app.utils.embedded_commands.wait_for_frame_command', side_effect=refuse):
        response = await async_client.post(f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': 'clock'})
    assert response.status_code == 502
    assert 'unknown_scene' in response.json()['detail']


@pytest.mark.asyncio
async def test_set_next_scene_queues_the_switch_behind_the_deploy(async_client, db):
    frame = await _embedded_frame(async_client, db)
    with _no_nudge(), patch('app.tasks.fast_deploy_frame', new_callable=AsyncMock) as deploy:
        response = await async_client.post(
            f'/api/frames/{frame.id}/set_next_scene', json={'sceneId': 'clock', 'state': {'size': 5}}
        )
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'queued'
    assert 'queued' in response.json()['message']
    deploy.assert_awaited_once()
    (row,) = db.query(FrameCommand).filter_by(frame_id=frame.id).all()
    assert row.type == 'set_current_scene' and row.payload == {'scene_id': 'clock', 'state': {'size': 5}}


# ----------------------------------------------------------- sleep forecast

@pytest.mark.asyncio
@patch("app.models.log.publish_message", new_callable=AsyncMock)
async def test_sleep_log_sets_the_forecast_and_a_wake_clears_it(_pub, async_client, db, redis):
    frame = await _embedded_frame(async_client, db)
    at = datetime(2026, 10, 11, 12, 0, 0)
    await process_log(db, redis, frame, [at.timestamp() + 0.0, {
        'event': 'sleep', 'source': 'esp32', 'wakeInSeconds': 540, 'nextRenderAt': 1791892800,
        'reason': 'battery', 'wakeCheck': True,
    }])
    db.refresh(frame)
    assert frame.next_wake_at == datetime.utcfromtimestamp(at.timestamp()) + timedelta(seconds=540)
    assert frame.next_render_at == datetime.utcfromtimestamp(1791892800)
    assert frame.sleep_reason == 'battery'
    payload = (await async_client.get(f'/api/frames/{frame.id}')).json()['frame']
    assert payload['next_wake_at'] is not None and payload['sleep_reason'] == 'battery'

    # A command queued meanwhile outlives the sleep.
    render = enqueue_frame_command(db, frame, 'render')
    assert render.expires_at > frame.next_wake_at

    await process_log(db, redis, frame, {'event': 'wake', 'source': 'esp32', 'cause': 'timer'})
    db.refresh(frame)
    assert frame.next_wake_at is None and frame.next_render_at is None and frame.sleep_reason is None


@pytest.mark.asyncio
async def test_states_refresh_leaves_a_sleeping_frame_alone(async_client, db, redis):
    from app.api import frames as frames_api

    frame = await _embedded_frame(async_client, db)
    frame.next_wake_at = datetime.utcnow() + timedelta(minutes=10)
    db.commit()
    with patch.object(frames_api, '_load_frame_states', new_callable=AsyncMock) as load:
        await frames_api._refresh_frame_states_cache(
            frame.id,
            frames_api._frame_states_cache_key(frame.id),
            frames_api._frame_states_cache_lock_key(frame.id),
            frames_api._frame_states_cache_invalidated_key(frame.id),
            0.0,
        )
    load.assert_not_awaited()


# ---------------------------------------------------------- firmware floor

@pytest.mark.asyncio
async def test_firmware_before_the_queue_is_still_pushed_to(async_client, db):
    """A board that last booted on firmware without fos_commands.c never asks
    for the queue: a queued command would wait until its TTL, a deploy
    forever. Until it takes an update, every action goes to its HTTP server
    as before."""
    from app.utils.embedded_commands import embedded_frame_pulls_commands, is_queued_embedded_frame

    frame = await _embedded_frame(async_client, db)
    assert embedded_frame_pulls_commands(frame)  # no boot reported: the fresh flash is current
    frame.embedded = {**frame.embedded, 'lastBoot': {'frameosVersion': 'v2026.10.4'}}
    db.commit()
    assert not embedded_frame_pulls_commands(frame)
    assert not is_queued_embedded_frame(frame)
    with patch('app.api.frames._forward_frame_request', new_callable=AsyncMock, return_value='OK') as forward:
        response = await async_client.post(f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': 'clock'})
    assert response.status_code == 200
    forward.assert_awaited_once()
    assert db.query(FrameCommand).filter_by(frame_id=frame.id).count() == 0

    frame.embedded = {**frame.embedded, 'lastBoot': {'frameosVersion': 'v2026.10.5+abc'}}
    db.commit()
    assert embedded_frame_pulls_commands(frame)
