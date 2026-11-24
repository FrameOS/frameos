"""The frame setup document (`GET /api/frames/{id}/embedded/setup`,
cloud/docs/flasher.md "The setup document"): the provisioning plan and the
scenes the board's own pull would get, which the backend's flasher, the
flash.frameos.net bridge and "Download setup file" all read."""
from unittest.mock import AsyncMock, patch

import pytest

from app.api import firmware_release
from app.utils.server_render import SERVER_RENDERED_BOARD_SCENE

from .test_embedded_device import device_frame


SCENES_WITH_TESTS = [
    {
        'id': 'clock',
        'name': 'Clock',
        'nodes': [],
        'edges': [],
        'apps': {
            'clockApp': {
                'sources': {
                    'app.ts': 'export function get() { return 1 }',
                    'app.test.ts': 'test("runs in the editor only", () => {})',
                },
            },
        },
    },
]


async def setup_document(async_client, frame_id: int):
    # The plan picks a layout-matched image from the cached release listing;
    # GitHub is not on the test's network.
    firmware_release.clear_release_cache()
    with patch('app.api.firmware_release._fetch_latest_release', new_callable=AsyncMock, return_value=None):
        response = await async_client.get(f'/api/frames/{frame_id}/embedded/setup')
    firmware_release.clear_release_cache()
    return response


@pytest.mark.asyncio
async def test_setup_document_is_the_plan_and_the_scenes_the_board_would_pull(async_client, db):
    frame = await device_frame(async_client, db)
    frame.scenes = SCENES_WITH_TESTS
    frame.name = 'Kitchen'
    db.add(frame)
    db.commit()

    response = await setup_document(async_client, frame.id)

    assert response.status_code == 200, response.text
    document = response.json()
    assert document['format'] == 'frameos-setup'
    assert document['version'] == 1
    assert document['createdAt'].endswith('Z')
    assert document['frame'] == {'id': frame.id, 'name': 'Kitchen'}
    provisioning = document['provisioning']
    settings = {setting['key']: setting['value'] for setting in provisioning['settings']}
    assert document['backend'] == {'url': settings['backend']}
    assert {'backend', 'api_key', 'frame_id'} <= set(settings)
    # The scenes are what the board's own pull gets: no app test files.
    assert [scene['id'] for scene in document['scenes']] == ['clock']
    assert document['scenes'][0]['apps']['clockApp']['sources'] == {
        'app.ts': 'export function get() { return 1 }',
    }


@pytest.mark.asyncio
async def test_setup_document_keeps_a_server_rendered_boards_scenes_here(async_client, db):
    """docs/server-rendering.md "Nothing to keep on the board": a board this
    backend renders for is set up with the one empty scene, never the list."""
    frame = await device_frame(async_client, db)
    frame.device_config = {**(frame.device_config or {}), 'renderMode': 'remote'}
    frame.scenes = SCENES_WITH_TESTS
    db.add(frame)
    db.commit()

    response = await setup_document(async_client, frame.id)

    assert response.status_code == 200, response.text
    assert response.json()['scenes'] == [SERVER_RENDERED_BOARD_SCENE]


@pytest.mark.asyncio
async def test_setup_document_is_only_for_embedded_frames(async_client):
    created = await async_client.post('/api/frames/new', json={
        'name': 'Pi frame',
        'frame_host': 'pi.local',
        'server_host': 'localhost',
    })
    assert created.status_code == 200, created.text

    response = await setup_document(async_client, created.json()['frame']['id'])

    assert response.status_code == 400
