"""Scene state for deep-sleeping embedded frames (utils/embedded_scene_state).

The ESP32 keeps no scene state across a deep-sleep reset and is usually
asleep when the workspace applies a change, so the backend holds the state
and serves it as field defaults in the /embedded/scenes payload the device
pulls on every wake.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.tests.test_embedded_device import auth, device_frame
from app.models.frame import Frame
from app.utils.embedded_scene_state import (
    SCENE_REQUEST_FIRMWARE_VERSION,
    SCENE_REQUEST_ID_HEADER,
    SCENE_REQUEST_SCENE_HEADER,
)

SCENE_ID = 'immich-scene'
OTHER_SCENE_ID = 'clock-scene'


@pytest.fixture(autouse=True)
def _fresh_redis(redis):
    """The active scene lives in Redis, which only the `redis` fixture flushes."""
    yield


def immich_scene() -> dict:
    return {
        'id': SCENE_ID,
        'name': 'Immich',
        'nodes': [],
        'edges': [],
        'fields': [
            {'name': 'mode', 'type': 'select', 'value': 'random', 'access': 'public', 'persist': 'disk',
             'options': ['random', 'album']},
            {'name': 'albumId', 'type': 'string', 'value': '', 'access': 'public', 'persist': 'disk'},
            {'name': 'secret', 'type': 'string', 'value': 'keep', 'access': 'private'},
            {'name': 'enabled', 'type': 'boolean', 'value': 'false', 'access': 'public'},
        ],
    }


async def immich_frame(async_client, db, firmware: str | None = None) -> Frame:
    frame = await device_frame(async_client, db)
    frame.scenes = [immich_scene(), {'id': OTHER_SCENE_ID, 'name': 'Clock', 'nodes': [], 'edges': []}]
    if firmware:
        frame.embedded = {**(frame.embedded or {}), 'lastBoot': {'frameosVersion': firmware}}
    db.add(frame)
    db.commit()
    return frame


def asleep():
    """The frame does not answer: what a deep-sleeping ESP32 looks like."""
    return patch(
        'app.api.frames._forward_frame_request',
        new=AsyncMock(side_effect=HTTPException(status_code=400, detail='Unable to reach frame')),
    )


def field_values(scenes: list) -> dict:
    return {field['name']: field['value'] for field in scenes[0]['fields']}


@pytest.mark.asyncio
async def test_apply_state_while_asleep_is_queued_and_served_on_wake(async_client, no_auth_client, db):
    frame = await immich_frame(async_client, db)
    before = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=auth(frame))
    etag = before.headers['etag']

    with asleep():
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album', 'albumId': 'abc-123', 'secret': 'nope',
                                                 'enabled': True}},
        )
    assert response.status_code == 200, response.text
    assert response.json()['queued'] is True

    # The wake's pull sees a changed payload, with the state as field defaults
    # (private fields untouched, values spelled the way scene JSON spells them).
    after = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/scenes', headers={**auth(frame), 'If-None-Match': etag})
    assert after.status_code == 200
    assert field_values(after.json()) == {
        'mode': 'album', 'albumId': 'abc-123', 'secret': 'keep', 'enabled': 'true'}

    # The stored scene itself is not rewritten.
    db.refresh(frame)
    assert field_values(frame.scenes) == field_values([immich_scene()])


@pytest.mark.asyncio
async def test_state_applied_to_an_awake_frame_also_survives_its_next_reset(async_client, no_auth_client, db):
    frame = await immich_frame(async_client, db)
    with patch('app.api.frames._forward_frame_request', new=AsyncMock(return_value='OK')) as forward:
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album', 'albumId': 'abc-123'}},
        )
    assert response.status_code == 200, response.text
    forward.assert_awaited_once()

    scenes = (await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=auth(frame))).json()
    assert field_values(scenes)['mode'] == 'album'


@pytest.mark.asyncio
async def test_set_scene_state_merges_into_the_active_scene(async_client, no_auth_client, db, redis):
    frame = await immich_frame(async_client, db)
    await redis.set(f'frame:{frame.id}:active_scene', SCENE_ID)
    with asleep():
        await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album', 'albumId': 'first'}},
        )
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setSceneState', json={'state': {'albumId': 'second'}})
    assert response.status_code == 200, response.text
    scenes = (await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=auth(frame))).json()
    assert field_values(scenes)['mode'] == 'album'
    assert field_values(scenes)['albumId'] == 'second'


@pytest.mark.asyncio
async def test_states_endpoint_shows_the_held_state_after_a_page_reload(async_client, db, redis):
    frame = await immich_frame(async_client, db)
    with asleep():
        await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album', 'albumId': 'abc-123'}},
        )
    with patch('app.api.frames._schedule_frame_states_cache_refresh', new=AsyncMock(return_value=True)):
        response = await async_client.get(f'/api/frames/{frame.id}/states')
    assert response.status_code == 200, response.text
    assert response.json()['states'][SCENE_ID] == {'mode': 'album', 'albumId': 'abc-123'}


@pytest.mark.asyncio
async def test_event_without_state_still_fails_when_asleep(async_client, db):
    frame = await immich_frame(async_client, db)
    with asleep():
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': SCENE_ID})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_set_next_scene_on_a_sleeping_frame_is_queued(async_client, no_auth_client, db):
    frame = await immich_frame(async_client, db, firmware=SCENE_REQUEST_FIRMWARE_VERSION)
    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=OSError('timed out'))), \
            patch('app.tasks.fast_deploy_frame.enqueue_unique_job', new=AsyncMock()) as enqueue:
        response = await async_client.post(
            f'/api/frames/{frame.id}/set_next_scene',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album', 'albumId': 'abc-123'}, 'fastDeploy': True},
        )
    assert response.status_code == 200, response.text
    assert response.json()['queued'] is True
    enqueue.assert_not_awaited()
    scenes = (await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=auth(frame))).json()
    assert field_values(scenes)['albumId'] == 'abc-123'


@pytest.mark.asyncio
async def test_set_next_scene_on_an_awake_frame_deploys(async_client, db):
    frame = await immich_frame(async_client, db)
    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(return_value=(200, b'pong', {}))), \
            patch('app.tasks.fast_deploy_frame.enqueue_unique_job', new=AsyncMock()) as enqueue:
        response = await async_client.post(
            f'/api/frames/{frame.id}/set_next_scene',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album'}, 'fastDeploy': True},
        )
    assert response.status_code == 200, response.text
    assert 'queued' not in response.json()
    enqueue.assert_awaited_once()


async def scenes_pull(no_auth_client, frame, etag=None):
    headers = {**auth(frame), **({'If-None-Match': etag} if etag else {})}
    return await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes', headers=headers)


@pytest.mark.asyncio
async def test_switch_while_asleep_rides_on_every_scenes_answer(async_client, no_auth_client, db, redis):
    frame = await immich_frame(async_client, db, firmware=SCENE_REQUEST_FIRMWARE_VERSION)
    await redis.set(f'frame:{frame.id}:active_scene', SCENE_ID)
    etag = (await scenes_pull(no_auth_client, frame)).headers['etag']

    with asleep():
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': OTHER_SCENE_ID})
    assert response.status_code == 200, response.text
    assert response.json()['queued'] is True

    # The switch does not change the payload: the 304 carries it too.
    unchanged = await scenes_pull(no_auth_client, frame, etag)
    assert unchanged.status_code == 304
    assert unchanged.headers[SCENE_REQUEST_SCENE_HEADER] == OTHER_SCENE_ID
    request_id = unchanged.headers[SCENE_REQUEST_ID_HEADER]
    assert request_id

    # Each activation is a new request, so the device applies it again.
    with asleep():
        await async_client.post(f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': SCENE_ID})
    again = await scenes_pull(no_auth_client, frame, etag)
    assert again.headers[SCENE_REQUEST_SCENE_HEADER] == SCENE_ID
    assert again.headers[SCENE_REQUEST_ID_HEADER] != request_id


@pytest.mark.asyncio
async def test_a_live_switch_clears_a_held_one(async_client, no_auth_client, db, redis):
    frame = await immich_frame(async_client, db, firmware=SCENE_REQUEST_FIRMWARE_VERSION)
    with asleep():
        await async_client.post(f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': OTHER_SCENE_ID})
    assert SCENE_REQUEST_ID_HEADER in (await scenes_pull(no_auth_client, frame)).headers

    with patch('app.api.frames._forward_frame_request', new=AsyncMock(return_value='OK')):
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': SCENE_ID})
    assert response.status_code == 200, response.text
    # Otherwise the next wake would switch back to the older request's scene.
    assert SCENE_REQUEST_ID_HEADER not in (await scenes_pull(no_auth_client, frame)).headers


@pytest.mark.asyncio
async def test_switch_while_asleep_fails_on_firmware_without_requests(async_client, db, redis):
    frame = await immich_frame(async_client, db, firmware='2026.10.3')
    await redis.set(f'frame:{frame.id}:active_scene', SCENE_ID)
    with asleep():
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setCurrentScene', json={'sceneId': OTHER_SCENE_ID})
    assert response.status_code == 400

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=OSError('timed out'))):
        response = await async_client.post(
            f'/api/frames/{frame.id}/set_next_scene', json={'sceneId': OTHER_SCENE_ID, 'state': {}})
    assert response.status_code == 400
    assert 'firmware' in response.json()['detail']


@pytest.mark.asyncio
async def test_set_next_scene_queues_the_switch_for_the_next_pull(async_client, no_auth_client, db):
    frame = await immich_frame(async_client, db, firmware=SCENE_REQUEST_FIRMWARE_VERSION)
    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(return_value=(200, b'pong', {}))), \
            patch('app.tasks.fast_deploy_frame.enqueue_unique_job', new=AsyncMock()):
        response = await async_client.post(
            f'/api/frames/{frame.id}/set_next_scene', json={'sceneId': OTHER_SCENE_ID, 'state': {}})
    assert response.status_code == 200, response.text
    # Awake: the deploy's /reload forces the pull that carries the switch.
    assert (await scenes_pull(no_auth_client, frame)).headers[SCENE_REQUEST_SCENE_HEADER] == OTHER_SCENE_ID


@pytest.mark.asyncio
async def test_save_holds_state_without_contacting_the_frame(async_client, no_auth_client, db):
    frame = await immich_frame(async_client, db)
    with patch('app.api.frames._forward_frame_request', new=AsyncMock()) as forward, \
            patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock()) as fetch:
        response = await async_client.post(
            f'/api/frames/{frame.id}/scene_state',
            json={'sceneId': SCENE_ID, 'state': {'mode': 'album', 'albumId': 'abc-123'}},
        )
    assert response.status_code == 200, response.text
    assert response.json()['queued'] is True
    forward.assert_not_awaited()
    fetch.assert_not_awaited()
    assert field_values((await scenes_pull(no_auth_client, frame)).json())['albumId'] == 'abc-123'

    # And the panel shows it after a reload.
    with patch('app.api.frames._schedule_frame_states_cache_refresh', new=AsyncMock(return_value=True)):
        states = (await async_client.get(f'/api/frames/{frame.id}/states')).json()
    assert states['states'][SCENE_ID] == {'mode': 'album', 'albumId': 'abc-123'}


@pytest.mark.asyncio
async def test_save_is_for_embedded_frames_and_known_scenes(async_client, db, redis):
    from app.models.frame import new_frame

    frame = await immich_frame(async_client, db)
    response = await async_client.post(
        f'/api/frames/{frame.id}/scene_state', json={'sceneId': 'nope', 'state': {'mode': 'album'}})
    assert response.status_code == 400

    pi = await new_frame(db, redis, 'Pi', 'example.com', 'localhost')
    response = await async_client.post(
        f'/api/frames/{pi.id}/scene_state', json={'sceneId': SCENE_ID, 'state': {'mode': 'album'}})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_a_queued_deploy_counts_once_the_frame_pulls(async_client, no_auth_client, db, redis):
    from app.utils.embedded_scene_state import queue_embedded_deploy, queued_deploy_key

    frame = await immich_frame(async_client, db)
    await queue_embedded_deploy(redis, frame.id, {'id': frame.id, 'name': 'reTerminal', 'scenes': []})

    response = await scenes_pull(no_auth_client, frame)
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.last_successful_deploy_at is not None
    assert frame.last_successful_deploy['name'] == 'reTerminal'
    assert await redis.get(queued_deploy_key(frame.id)) is None
