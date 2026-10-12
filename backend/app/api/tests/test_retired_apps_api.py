"""The retired Nim Immich app (app/utils/retired_apps.py) at the routes that
store scenes and the routes that send them to a device."""

from unittest.mock import AsyncMock, patch

import pytest

from app.api.tests.test_embedded_device import auth, device_frame
from app.models.settings import Settings
from app.utils.retired_apps import frame_runtime_version, replacement_app_entry


def immich_js_scene() -> dict:
    """A scene as the backend stores it once data/immich is retired."""
    return {
        'id': 'photos',
        'name': 'Photos',
        'nodes': [{'id': 'n1', 'type': 'app', 'data': {'keyword': 'immich', 'config': {'mode': 'favorites'}}}],
        'edges': [],
        'apps': {'immich': replacement_app_entry('repo/apps/code/immich')},
    }


def immich_nim_scene() -> dict:
    return {
        'id': 'photos',
        'name': 'Photos',
        'nodes': [{'id': 'n1', 'type': 'app', 'data': {'keyword': 'data/immich', 'config': {'mode': 'favorites'}}}],
        'edges': [],
    }


@pytest.mark.asyncio
async def test_esp32_without_the_capability_gets_the_retired_keyword(async_client, no_auth_client, db):
    """Firmware from before the Nim Immich app was retired still has it and
    lacks frameos.fetchImage: it gets `data/immich`. Firmware that sends the
    capabilities header gets the JS app — and a different ETag, which is what
    moves a board over on its first pull after the OTA."""
    frame = await device_frame(async_client, db)
    frame.scenes = [immich_js_scene()]
    db.add(frame)
    db.commit()
    url = f'/api/frames/{frame.id}/embedded/scenes'

    older = await no_auth_client.get(url, headers=auth(frame))
    assert older.status_code == 200, older.text
    assert older.json()[0]['nodes'][0]['data'] == {'keyword': 'data/immich', 'config': {'mode': 'favorites'}}
    assert 'apps' not in older.json()[0]
    db.refresh(frame)
    assert 'capabilities' not in (frame.embedded or {})

    current = await no_auth_client.get(url, headers={**auth(frame), 'X-FrameOS-Capabilities': 'fetchImage'})
    assert current.status_code == 200, current.text
    assert current.json()[0]['nodes'][0]['data']['keyword'] == 'immich'
    assert current.json()[0]['apps']['immich']['origin'] == 'repo/apps/code/immich'
    assert current.headers['etag'] != older.headers['etag']

    # Remembered for the paths that send it scenes unasked; the stored scenes
    # are untouched.
    db.refresh(frame)
    assert frame.embedded['capabilities'] == 'fetchImage'
    assert frame_runtime_version(frame) is None
    assert frame.scenes[0]['nodes'][0]['data']['keyword'] == 'immich'


@pytest.mark.asyncio
async def test_commands_pull_compares_the_etag_this_device_pulls(async_client, no_auth_client, db):
    from app.api.embedded_device import embedded_scenes_etag

    frame = await device_frame(async_client, db)
    frame.scenes = [immich_js_scene()]
    db.add(frame)
    db.commit()
    url = f'/api/frames/{frame.id}/embedded/commands'
    headers = {**auth(frame), 'X-FrameOS-Capabilities': 'fetchImage'}
    response = await no_auth_client.post(
        url, headers=headers, json={'scenes_checksum': embedded_scenes_etag(frame, 'fetchImage')}
    )
    assert response.status_code == 200, response.text
    assert embedded_scenes_etag(frame) != embedded_scenes_etag(frame, 'fetchImage')
    db.refresh(frame)
    assert frame.embedded['capabilities'] == 'fetchImage'


@pytest.mark.asyncio
async def test_settings_follow_a_scene_on_the_immich_js_app(async_client, no_auth_client, db):
    """The JS app declares the `immich` settings group in its own config.json,
    so the group still reaches the device once the scene stops naming the Nim
    app."""
    frame = await device_frame(async_client, db)
    frame.scenes = [immich_js_scene()]
    db.add_all([
        frame,
        Settings(project_id=frame.project_id, key='immich', value={'url': 'https://photos.example', 'apiKey': 'k'}),
    ])
    db.commit()

    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    assert response.json()['immich'] == {'url': 'https://photos.example', 'apiKey': 'k'}


@pytest.mark.asyncio
async def test_saving_a_frame_stores_the_js_app(async_client, db):
    """An editor tab (or a saved draft) from before the upgrade still holds
    data/immich: the save stores what it became."""
    frame = await device_frame(async_client, db)
    response = await async_client.post(f'/api/frames/{frame.id}', json={'scenes': [immich_nim_scene()]})
    assert response.status_code == 200, response.text
    db.refresh(frame)
    scene = frame.scenes[0]
    assert scene['nodes'][0]['data']['keyword'] == 'immich'
    assert scene['apps']['immich']['origin'] == 'repo/apps/code/immich'


@pytest.mark.asyncio
async def test_preview_upload_goes_out_as_the_frames_runtime_reads_it(async_client, db):
    frame = await device_frame(async_client, db)
    frame.embedded = {**(frame.embedded or {}), 'lastBoot': {'frameosVersion': '2026.10.10'}}
    db.add(frame)
    db.commit()
    forwarded = AsyncMock(return_value=None)
    with patch('app.api.frames._forward_frame_request', forwarded):
        response = await async_client.post(
            f'/api/frames/{frame.id}/upload_scenes',
            json={'scenes': [immich_js_scene()], 'sceneId': 'photos'},
        )
    assert response.status_code == 200, response.text
    body = forwarded.await_args.kwargs['json_body']
    assert body['scenes'][0]['nodes'][0]['data']['keyword'] == 'data/immich'
    assert 'apps' not in body['scenes'][0]


def test_get_interpreted_scenes_json_follows_the_runtime(db):
    from app.models.frame import Frame, get_interpreted_scenes_json

    frame = Frame(scenes=[{**immich_js_scene(), 'settings': {'execution': 'interpreted'}}])
    assert get_interpreted_scenes_json(frame, '2026.10.10')[0]['nodes'][0]['data']['keyword'] == 'data/immich'
    assert get_interpreted_scenes_json(frame, '2026.10.11')[0]['nodes'][0]['data']['keyword'] == 'immich'
    assert get_interpreted_scenes_json(frame)[0]['nodes'][0]['data']['keyword'] == 'immich'
    # The stored row is never rewritten for a device.
    assert frame.scenes[0]['nodes'][0]['data']['keyword'] == 'immich'
