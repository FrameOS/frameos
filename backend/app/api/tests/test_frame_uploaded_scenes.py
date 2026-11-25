"""GET /api/frames/{id}/uploaded_scenes: the scenes a frame was handed that
its row may not hold, which the scene drawer names and offers to install. A
Pi's /getUploadedScenes is a list of scenes; an ESP32's is its scene status
(fos_http.c uploaded_scenes_get_handler), which the route used to hand on as
it was and failed its own response model on (frame 76, 2026-11-25)."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from .test_embedded_firmware import create_embedded_frame

SHOWN = '64a15e71-3c2a-4f0e-9b7d-5e1f2a8c9d40'

# What a reTerminal Sticky answered, its ten scenes as it lists them.
ESP32_STATUS = {
    'scenes': {
        'loaded': 2,
        'available': 10,
        'hasScene': True,
        'currentSceneId': SHOWN,
        'currentSceneName': 'Pixel toys',
        'defaultSceneId': 'scene-store',
        'renderRequested': False,
        'scenes': [
            {'id': 'scene-store', 'name': 'Scene store', 'refreshInterval': 0.0},
            {'id': 'clock', 'name': 'Clock', 'refreshInterval': 1.0},
            {'id': 'flip-clock', 'name': 'Flip clock', 'refreshInterval': 1.0},
            {'id': 'big-typographic-clock', 'name': 'Big typographic clock', 'refreshInterval': 60.0},
            {'id': 'analog-clock-face', 'name': 'Analog clock face', 'refreshInterval': 1.0},
            {'id': 'countdown', 'name': 'Countdown', 'refreshInterval': 1.0},
            {'id': 'asset-browser', 'name': 'Files', 'refreshInterval': 0.0},
            {'id': 'terminal-app', 'name': 'Terminal', 'refreshInterval': 0.0},
            {'id': SHOWN, 'name': 'Pixel toys', 'refreshInterval': 0.05},
            {'id': 'layout-reterminal-sticky', 'name': 'reTerminal Sticky', 'refreshInterval': 0.0},
        ],
    },
}
PIXEL_TOYS = {
    'id': SHOWN,
    'name': 'Pixel toys',
    'nodes': [{'id': 'render', 'type': 'event', 'data': {'keyword': 'render'}}],
    'edges': [],
    'settings': {'execution': 'interpreted'},
}


def _board(answers):
    calls = []

    async def fetch(frame, redis, *, path, **kwargs):
        calls.append(path.split('?', 1)[0])
        status, body = answers[path.split('?', 1)[0]]
        return status, json.dumps(body).encode(), {'content-type': 'application/json'}

    return calls, patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=fetch))


@pytest.mark.asyncio
async def test_an_esp32s_scene_status_lists_the_scene_it_shows_whole(async_client, redis):
    frame = await create_embedded_frame(async_client)
    calls, patched = _board({
        '/getUploadedScenes': (200, ESP32_STATUS),
        f"/api/frames/{frame['id']}/scenes/{SHOWN}": (200, PIXEL_TOYS),
    })
    with patched:
        response = await async_client.get(f"/api/frames/{frame['id']}/uploaded_scenes")
    assert response.status_code == 200, response.text
    # Whole, so the drawer names it and installs the scene, never a name without nodes.
    assert response.json() == {'scenes': [PIXEL_TOYS]}
    assert calls == ['/getUploadedScenes', f"/api/frames/{frame['id']}/scenes/{SHOWN}"]
    assert (await redis.get(f"frame:{frame['id']}:active_scene")).decode() == SHOWN


@pytest.mark.asyncio
async def test_an_esp32_that_cannot_hand_over_the_scene_lists_none(async_client, redis):
    frame = await create_embedded_frame(async_client)
    _calls, patched = _board({
        '/getUploadedScenes': (200, ESP32_STATUS),
        f"/api/frames/{frame['id']}/scenes/{SHOWN}": (404, 'not found'),
    })
    with patched:
        response = await async_client.get(f"/api/frames/{frame['id']}/uploaded_scenes")
    assert response.status_code == 200, response.text
    assert response.json() == {'scenes': []}


@pytest.mark.asyncio
async def test_a_pis_list_is_served_as_it_is(async_client, redis):
    created = await async_client.post('/api/frames/new', json={
        'name': 'Pi', 'frame_host': '10.0.0.7', 'server_host': '10.0.0.5', 'device': 'web_only',
    })
    assert created.status_code == 200, created.text
    frame = created.json()['frame']
    calls, patched = _board({'/getUploadedScenes': (200, {'scenes': [PIXEL_TOYS, 'not a scene']})})
    with patched:
        response = await async_client.get(f"/api/frames/{frame['id']}/uploaded_scenes")
    assert response.status_code == 200, response.text
    assert response.json() == {'scenes': [PIXEL_TOYS]}
    assert calls == ['/getUploadedScenes']
