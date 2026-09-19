import json
import struct

import httpx
import pytest
from unittest.mock import AsyncMock, patch

from app.api import firmware_release
from app.models.frame import Frame, normalize_frame_admin_auth
from app.models.settings import Settings
from app.tasks.embedded_firmware import (
    FOS_PIXEL_1BPP,
    FOS_PIXEL_2BPP_BWYR,
    FOS_PIXEL_2BPP_GRAY,
    FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_GRAY,
    FOS_PIXEL_4BPP_SPECTRA6,
    FOS_PIXEL_DUAL_1BPP_RED,
    ensure_embedded_frame_defaults,
)


@pytest.fixture(autouse=True)
def _clear_release_cache():
    """The OTA routes read the same in-process release cache as the flasher
    listing; a release mocked in one test must not leak into the next."""
    firmware_release.clear_release_cache()
    yield
    firmware_release.clear_release_cache()


RELEASE_TAG = 'v2026.9.2'


def release_asset(name: str, size: int) -> dict:
    return {
        'name': name,
        'size': size,
        'browser_download_url': (
            f'https://github.com/FrameOS/frameos/releases/download/{RELEASE_TAG}/{name}'
        ),
    }


def release_with(*platforms: str, minisig: bool = True, tag: str = RELEASE_TAG) -> dict:
    """A GitHub release listing carrying the merged provisioning image, the
    bare OTA app image and its minisign signature for each platform."""
    version = tag[1:]
    assets = []
    for index, platform in enumerate(platforms):
        assets.append(release_asset(f'frameos-{version}-{platform}.bin', 900 + index))
        assets.append(release_asset(f'frameos-{version}-{platform}-app.bin', 700 + index))
        if minisig:
            assets.append(release_asset(f'frameos-{version}-{platform}-app.bin.minisig', 120))
    return {'tag_name': tag, 'assets': assets}


MINISIG_TEXT = (
    'untrusted comment: signature from minisign secret key\n'
    'RUQf6LRCGA9i559r3g5aCzCVKMRZ9F4qpZ6E1234567890abcdefghijklmnopqrstuvwxyz==\n'
)


def mocked_httpx(handler):
    """Answer every outbound httpx request from ``handler`` — the release
    asset pipe builds its own client, so there is nothing else to patch."""
    real_async_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop('timeout', None)
        kwargs.pop('follow_redirects', None)
        return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

    return patch.object(httpx, 'AsyncClient', factory)


def patch_release(release):
    """Both halves of a release lookup: the listing and the small text asset
    fetch that carries the .minisig body."""
    return (
        patch('app.api.firmware_release._fetch_latest_release', new_callable=AsyncMock,
              return_value=release),
        patch('app.api.firmware_release.fetch_release_asset_text', new_callable=AsyncMock,
              return_value=MINISIG_TEXT),
    )


async def create_embedded_frame(async_client) -> dict:
    response = await async_client.post('/api/frames/new', json={
        'name': 'ESP32 Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'esp32-s3',
    })
    assert response.status_code == 200, response.text
    return response.json()['frame']


async def device_frame(async_client, db) -> Frame:
    frame_json = await create_embedded_frame(async_client)
    frame = db.get(Frame, frame_json['id'])
    ensure_embedded_frame_defaults(frame)
    db.add(frame)
    db.commit()
    assert frame.server_api_key
    return frame


def auth(frame: Frame) -> dict:
    return {'Authorization': f'Bearer {frame.server_api_key}'}


async def pico_spectra_frame(async_client, db) -> Frame:
    """A Pimoroni Inky Frame 7.3" Spectra: Pico 2 W, thin client only."""
    response = await async_client.post('/api/frames/new', json={
        'name': 'Inky Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'pico-2w',
        'device_config': {'hardwarePreset': 'pimoroni_inky_frame_7_3_spectra'},
    })
    assert response.status_code == 200, response.text
    frame = db.get(Frame, response.json()['frame']['id'])
    assert frame.device == 'waveshare.EPD_7in3e'
    assert frame.embedded['platform'] == 'pico-2w'
    assert frame.server_api_key
    return frame


def scene_renderer(calls: list, rgba_pixel=(0, 0, 0, 255), state=None):
    """Stands in for the node + wasm render: records what the route passed
    and answers one flat-colour frame plus the state the scene ended with."""
    async def fake_render(frame_arg, width, height, **kwargs):
        calls.append(kwargs)
        return bytes(rgba_pixel) * (width * height), state, None

    return fake_render


@pytest.mark.asyncio
async def test_render_requires_device_auth(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/render')
    assert response.status_code == 401
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render',
        headers={'Authorization': 'Bearer wrong-key'})
    assert response.status_code == 401
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render',
        headers={'Authorization': f'Token {frame.server_api_key}'})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_render_rejects_other_frames_key(async_client, no_auth_client, db):
    frame_a = await device_frame(async_client, db)
    frame_b = await device_frame(async_client, db)
    response = await no_auth_client.get(
        f'/api/frames/{frame_a.id}/embedded/render', headers=auth(frame_b))
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_render_returns_fosb_bitmap(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    assert frame.device == 'waveshare.EPD_7in5_V2'

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    version, pixel_format, width, height, _ = struct.unpack('<BBHHH', body[4:12])
    assert version == 1
    assert pixel_format == 1
    assert (width, height) == (800, 480)
    assert len(body) == 12 + (width // 8) * height


@pytest.mark.asyncio
async def test_render_returns_spectra6_fosb_bitmap(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    frame.device = 'waveshare.EPD_7in3e'
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    version, pixel_format, width, height, _ = struct.unpack('<BBHHH', body[4:12])
    assert version == 1
    assert pixel_format == FOS_PIXEL_4BPP_SPECTRA6
    assert (width, height) == (800, 480)
    assert len(body) == 12 + ((width + 1) // 2) * height


@pytest.mark.asyncio
async def test_render_uses_wasm_scene_render_when_available(async_client, no_auth_client, db, monkeypatch):
    frame = await device_frame(async_client, db)
    frame.scenes = [{'id': 'scene-1', 'name': 'Black', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    # Solid black RGBA → the 1bpp packing must come out all zeros, which the
    # (mostly white) diagnostic card never does.
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', scene_renderer([]))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    payload = body[12:]
    assert payload == b'\x00' * len(payload)


class _FakeRedis:
    def __init__(self, value):
        self._value = value

    async def get(self, key):
        return self._value


@pytest.mark.asyncio
async def test_active_scene_id_ignores_a_cached_scene_the_frame_no_longer_has():
    """A stale frame:{id}:active_scene (the scene was deleted or scenes.json
    was replaced) made the wasm harness fail "scene not found" on every poll,
    so the thin client showed the diagnostic card until another activation."""
    from app.api.embedded_device import _active_scene_id

    frame = Frame(id=66, scenes=[{'id': 'oled-hello', 'name': 'x', 'nodes': [], 'edges': []}])
    assert await _active_scene_id(_FakeRedis(b'oled-hello'), frame) == 'oled-hello'
    assert await _active_scene_id(_FakeRedis('oled-hello'), frame) == 'oled-hello'
    assert await _active_scene_id(_FakeRedis(b'aa342667-gone'), frame) is None
    assert await _active_scene_id(_FakeRedis(None), frame) is None
    assert await _active_scene_id(None, frame) is None
    assert await _active_scene_id(_FakeRedis(b'oled-hello'), Frame(id=67, scenes=None)) is None


@pytest.mark.asyncio
async def test_render_falls_back_to_diagnostic_when_scene_render_fails(
    async_client, no_auth_client, db, monkeypatch
):
    frame = await device_frame(async_client, db)
    frame.scenes = [{'id': 'scene-1', 'name': 'Broken', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    async def failing_render(frame_arg, width, height, **kwargs):
        return None, None, None

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', failing_render)

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    # The diagnostic card has a white background: 1bpp packing is mostly 0xFF.
    payload = body[12:]
    assert payload.count(0xFF) > len(payload) // 2


@pytest.mark.asyncio
async def test_render_for_a_pico_inky_frame_is_a_spectra6_fosb(async_client, no_auth_client, db, monkeypatch):
    """What embedded/pico pulls: a 12-byte FOSB header and the 800x480
    Spectra 6 payload, two pixels per byte."""
    frame = await pico_spectra_frame(async_client, db)
    frame.scenes = [{'id': 'scene-1', 'name': 'White', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    calls: list = []
    monkeypatch.setattr(
        'app.api.embedded_device.render_scene_rgba_and_state',
        scene_renderer(calls, rgba_pixel=(255, 255, 255, 255)))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))

    assert response.status_code == 200, response.text
    assert response.headers['content-type'] == 'application/octet-stream'
    body = response.content
    assert body[:4] == b'FOSB'
    assert struct.unpack('<BBHHH', body[4:12]) == (1, FOS_PIXEL_4BPP_SPECTRA6, 800, 480, 0)
    assert FOS_PIXEL_4BPP_SPECTRA6 == 7
    assert len(body) == 12 + 192000
    # Flat white is Spectra palette index 1 in both nibbles, all the way down.
    assert body[12:] == b'\x11' * 192000
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_render_for_a_portrait_thin_client_is_rendered_upright_and_turned(
    async_client, no_auth_client, db, monkeypatch
):
    """A thin client cannot rotate anything itself: a frame hung in portrait
    gets its scene rendered on the swapped canvas and turned clockwise to the
    panel's native 800x480, the way runner.nim + rotateDegrees do on a frame
    with its own renderer."""
    frame = await pico_spectra_frame(async_client, db)
    frame.scenes = [{'id': 'scene-1', 'name': 'Corner', 'nodes': [], 'edges': []}]
    frame.rotate = 90
    db.add(frame)
    db.commit()

    sizes: list = []

    async def corner_render(frame_arg, width, height, **kwargs):
        sizes.append((width, height))
        # Black top-left quadrant on white, in the scene's own orientation.
        rows = []
        for y in range(height):
            black = b'\x00\x00\x00\xff' * (width // 2) if y < height // 2 else b''
            rows.append(black + b'\xff\xff\xff\xff' * (width - len(black) // 4))
        return b''.join(rows), None, None

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', corner_render)

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))

    assert response.status_code == 200, response.text
    assert sizes == [(480, 800)]
    body = response.content
    # The payload is still the panel's native shape.
    assert struct.unpack('<BBHHH', body[4:12]) == (1, FOS_PIXEL_4BPP_SPECTRA6, 800, 480, 0)
    assert len(body) == 12 + 192000
    payload = body[12:]

    def index_at(x: int, y: int) -> int:
        byte = payload[y * 400 + x // 2]
        return byte >> 4 if x % 2 == 0 else byte & 0x0F

    # Clockwise by 90: the scene's top-left lands in the panel's top-right.
    assert index_at(799, 0) == 0
    assert index_at(0, 0) == 1
    assert index_at(799, 479) == 1
    assert index_at(0, 479) == 1
    assert index_at(401, 239) == 0
    assert index_at(399, 239) == 1


def _slideshow_scene() -> dict:
    return {
        'id': 'slides',
        'name': 'Slides',
        'nodes': [],
        'edges': [],
        'fields': [
            {'name': 'index', 'type': 'integer', 'access': 'public', 'value': '0'},
            {'name': 'cursor', 'type': 'string', 'access': 'private', 'persist': 'disk'},
            {'name': 'scratch', 'type': 'string', 'access': 'private'},
        ],
    }


def _states_key(frame: Frame) -> str:
    # The store virtual frames use; thin clients share it, key and all.
    return f'frame:{frame.id}:virtual:scene_states'


@pytest.mark.asyncio
async def test_render_seeds_the_stored_scene_state_and_keeps_what_comes_back(
    async_client, no_auth_client, db, redis, monkeypatch
):
    """A thin client's renderer is a fresh wasm process every poll, so the
    backend is the scene's memory — without it a slideshow never advances."""
    frame = await pico_spectra_frame(async_client, db)
    frame.scenes = [_slideshow_scene()]
    db.add(frame)
    db.commit()
    await redis.set(_states_key(frame), json.dumps({'slides': {'index': 2}}))

    calls: list = []
    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', scene_renderer(calls, state={
        'sceneId': 'slides',
        'state': {'index': 3, 'cursor': 'page-2', 'scratch': 'gone', 'undeclared': 'gone'},
    }))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))

    assert response.status_code == 200, response.text
    assert calls[0]['scene_states'] == {'slides': {'index': 2}}
    # Stored under the scene the renderer showed: public fields and the
    # persist=disk ones, the same contract as a virtual frame.
    assert json.loads(await redis.get(_states_key(frame))) == {'slides': {'index': 3, 'cursor': 'page-2'}}

    # The next poll starts where this one ended.
    await no_auth_client.get(f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert calls[1]['scene_states'] == {'slides': {'index': 3, 'cursor': 'page-2'}}


@pytest.mark.asyncio
async def test_render_keeps_the_stored_state_when_seeding_failed(
    async_client, no_auth_client, db, redis, monkeypatch
):
    # An old wasm bundle without the set_scene_state export reads back bare
    # scene defaults; they must not replace what the store holds.
    frame = await pico_spectra_frame(async_client, db)
    frame.scenes = [_slideshow_scene()]
    db.add(frame)
    db.commit()
    await redis.set(_states_key(frame), json.dumps({'slides': {'index': 2}}))

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', scene_renderer([], state={
        'sceneId': 'slides', 'seeded': False, 'state': {'index': 0},
    }))

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))

    assert response.status_code == 200, response.text
    assert json.loads(await redis.get(_states_key(frame))) == {'slides': {'index': 2}}


@pytest.mark.asyncio
async def test_scene_state_event_reaches_the_store_before_the_thin_client(async_client, db, redis):
    """The device re-renders on any /event/*; the render it pulls must
    already carry the state that event posted."""
    frame = await pico_spectra_frame(async_client, db)
    frame.scenes = [_slideshow_scene()]
    db.add(frame)
    db.commit()

    stored_when_forwarded: list = []

    async def forward(frame_arg, redis_arg, **kwargs):
        stored_when_forwarded.append((kwargs['path'], await redis.get(_states_key(frame))))
        return 'OK'

    with patch('app.api.frames._forward_frame_request', side_effect=forward):
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setSceneState',
            json={'sceneId': 'slides', 'render': True, 'state': {'index': 5, 'scratch': 'nope'}},
            headers={'content-type': 'application/json'})

    assert response.status_code == 200, response.text
    assert [path for path, _ in stored_when_forwarded] == ['/event/setSceneState']
    assert json.loads(stored_when_forwarded[0][1]) == {'slides': {'index': 5}}


@pytest.mark.asyncio
async def test_scene_state_event_for_a_local_render_frame_is_only_forwarded(async_client, db, redis):
    # An ESP32-S3 rendering on-device holds its own state; the backend store
    # is not its memory.
    frame = await device_frame(async_client, db)
    frame.scenes = [_slideshow_scene()]
    db.add(frame)
    db.commit()

    with patch('app.api.frames._forward_frame_request', new_callable=AsyncMock, return_value='OK') as forward:
        response = await async_client.post(
            f'/api/frames/{frame.id}/event/setSceneState',
            json={'sceneId': 'slides', 'state': {'index': 5}},
            headers={'content-type': 'application/json'})

    assert response.status_code == 200, response.text
    forward.assert_awaited_once()
    assert await redis.get(_states_key(frame)) is None


@pytest.mark.asyncio
async def test_ota_manifest_404_for_a_pico_frame(async_client, no_auth_client, db):
    """The pico UF2 is provisioning-only. Listing it as the frame's release
    image must not make an OTA image appear — whatever platform is named."""
    frame = await pico_spectra_frame(async_client, db)
    release = release_with('esp32-s3-generic')
    release['assets'].append(release_asset('frameos-2026.9.2-pico-2w.uf2', 800_000))
    listing, text = patch_release(release)

    with listing, text:
        for query in ('', '?platform=pico-2w', '?platform=esp32-s3-generic'):
            response = await no_auth_client.get(
                f'/api/frames/{frame.id}/embedded/ota/manifest{query}', headers=auth(frame))
            assert response.status_code == 404, response.text
            assert response.json()['detail'] == 'ota_image_not_published'
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/download', headers=auth(frame))
        assert response.status_code == 404
        assert response.json()['detail'] == 'ota_image_not_published'


@pytest.mark.asyncio
async def test_render_end_to_end_wasm_scene(async_client, no_auth_client, db):
    """Full path: real Node subprocess hosting the wasm scene runtime.

    Runs only where the toolchain exists (node on PATH + the emscripten
    bundle built by frameos/tools/build_wasm.sh) — CI's docker images and
    dev checkouts that ran build_wasm.sh.
    """
    import json as jsonlib
    from pathlib import Path

    from app.utils.embedded_render import thin_client_renderer_available

    if not thin_client_renderer_available():
        pytest.skip('node + wasm bundle not available')
    fixture = Path(__file__).resolve().parents[4] / 'e2e' / 'generated' / 'scenes.json'
    if not fixture.is_file():
        pytest.skip('e2e scenes fixture not available')

    scenes = jsonlib.loads(fixture.read_text())
    gradient = [scene for scene in scenes if scene.get('id') == 'dataGradient_interpreted']
    assert gradient, 'expected dataGradient_interpreted in the e2e fixture'

    frame = await device_frame(async_client, db)
    frame.scenes = gradient
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    version, pixel_format, width, height, _ = struct.unpack('<BBHHH', body[4:12])
    assert (width, height) == (800, 480)
    payload = body[12:]
    assert len(payload) == (width // 8) * height
    # A gradient dithers to a genuine mix of black and white — nothing like
    # the diagnostic card's near-uniform white field.
    ones = sum(bin(byte).count('1') for byte in payload[:4800])
    total_bits = 4800 * 8
    assert 0.05 < ones / total_bits < 0.95


@pytest.mark.asyncio
async def test_scenes_requires_device_auth(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/scenes')
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_scenes_returns_payload_with_etag(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    frame.scenes = [{
        'id': 'scene-1',
        'name': 'Clock',
        'nodes': [],
        'edges': [],
        'settings': {'refreshInterval': 60},
    }]
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/scenes', headers=auth(frame))
    assert response.status_code == 200, response.text
    etag = response.headers['etag']
    assert etag.startswith('"') and etag.endswith('"')
    scenes = response.json()
    assert len(scenes) == 1
    assert scenes[0]['id'] == 'scene-1'

    # Unchanged payload + If-None-Match → 304 (device polls every render)
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/scenes',
        headers={**auth(frame), 'If-None-Match': etag})
    assert response.status_code == 304

    # Changed scenes → new ETag + fresh payload
    frame.scenes = [{**frame.scenes[0], 'name': 'Clock v2'}]
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/scenes',
        headers={**auth(frame), 'If-None-Match': etag})
    assert response.status_code == 200
    assert response.headers['etag'] != etag
    assert response.json()[0]['name'] == 'Clock v2'


@pytest.mark.asyncio
async def test_settings_returns_scene_required_service_settings(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    frame.scenes = [{
        'id': 'scene-1',
        'name': 'Service Scene',
        'nodes': [
            {'type': 'app', 'data': {'keyword': 'data/openaiImage'}},
            {'type': 'app', 'data': {'keyword': 'data/unsplash'}},
            {'type': 'app', 'data': {'keyword': 'data/haSensor'}},
        ],
        'edges': [],
        'settings': {'refreshInterval': 60},
    }]
    db.add_all([
        frame,
        Settings(project_id=frame.project_id, key='openAI', value={'apiKey': 'sk-frame', 'backendApiKey': 'sk-backend'}),
        Settings(project_id=frame.project_id, key='unsplash', value={'accessKey': 'unsplash-key'}),
        Settings(project_id=frame.project_id, key='homeAssistant', value={'accessToken': 'not-for-esp'}),
    ])
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))

    assert response.status_code == 200, response.text
    payload = response.json()
    frame_object = payload.pop('frame')
    payload.pop('schedule')  # covered by test_settings_includes_schedule_and_utc_offset
    assert payload == {
        'homeAssistant': {'accessToken': 'not-for-esp'},
        'openAI': {'apiKey': 'sk-frame', 'backendApiKey': 'sk-backend'},
        'unsplash': {'accessKey': 'unsplash-key'},
    }
    assert frame_object['name'] == 'ESP32 Frame'


@pytest.mark.asyncio
async def test_settings_pull_follows_the_granted_set(async_client, no_auth_client, db):
    """The pull used to hard-code four groups. It is the granted set now (the
    same walk frame.json ships): a group outside the old four that the
    owner's scene declares flows through; a group a store-origin scene
    declares reaches the device only once the owner granted it."""
    frame = await device_frame(async_client, db)
    frame.scenes = [
        {
            'id': 'own-gallery',
            'name': 'Own scene',
            'nodes': [{'type': 'app', 'data': {'keyword': 'data/frameOSGallery'}}],
            'edges': [],
        },
        {
            'id': 'store-unsplash',
            'name': 'Store scene',
            'origin': {'storeSceneId': 'abc', 'href': 'https://store/x', 'version': 1},
            'nodes': [{'type': 'app', 'data': {'keyword': 'data/unsplash'}}],
            'edges': [],
        },
    ]
    frame.service_setting_groups = []
    db.add_all([
        frame,
        Settings(project_id=frame.project_id, key='frameOS', value={'apiKey': 'gallery-key'}),
        Settings(project_id=frame.project_id, key='unsplash', value={'accessKey': 'unsplash-key'}),
        Settings(project_id=frame.project_id, key='openAI', value={'apiKey': 'never-declared'}),
    ])
    db.commit()

    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    payload = response.json()
    payload.pop('frame')
    payload.pop('schedule')
    assert payload == {'frameOS': {'apiKey': 'gallery-key'}}

    frame.service_setting_groups = ['unsplash']
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    payload = response.json()
    payload.pop('frame')
    payload.pop('schedule')
    assert payload == {'frameOS': {'apiKey': 'gallery-key'}, 'unsplash': {'accessKey': 'unsplash-key'}}


@pytest.mark.asyncio
async def test_render_answers_503_with_retry_after_when_the_queue_is_full(
    async_client, no_auth_client, db, monkeypatch
):
    from app.utils.embedded_render import RenderQueueFull

    frame = await device_frame(async_client, db)
    frame.scenes = [{'id': 'scene-1', 'name': 'Busy', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    async def queue_full(frame_arg, width, height, **kwargs):
        raise RenderQueueFull()

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba_and_state', queue_full)

    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 503, response.text
    assert response.headers['Retry-After'] == '5'


@pytest.mark.asyncio
async def test_settings_includes_live_frame_settings(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    frame.name = 'Kitchen'
    frame.interval = 61.5
    frame.scaling_mode = 'contain'
    frame.timezone = None  # deterministic utcOffsetMinutes
    frame.device_config = {
        **(frame.device_config or {}),
        'renderMode': 'remote',
        'deepSleep': True,
        'wakeSchedule': False,
    }
    db.add(frame)
    db.commit()

    admin_auth = normalize_frame_admin_auth(frame.frame_admin_auth)
    # Every embedded frame is created with a generated device login and its
    # own self-signed certificate; both reach a stock release image through
    # this poll, because neither fits on a USB console line.
    expected_admin_auth = {
        'enabled': True,
        'user': admin_auth['user'],
        'pass': admin_auth['pass'],
    }
    expected_tls = {
        'enable': True,
        'port': 8443,
        'cert': frame.https_proxy['certs']['server'],
        'key': frame.https_proxy['certs']['server_key'],
    }

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    assert response.json()['frame'] == {
        'interval': 61.5,
        'name': 'Kitchen',
        'renderMode': 'remote',  # thin client — string form fos_settings.c parses
        'deepSleep': True,
        'wakeSchedule': False,
        # The optional power keys (deepSleepOnBattery, wakeCheckSeconds,
        # batteryPin, batteryDivider) are present-only: absent from
        # device_config means absent from the poll, so the device's own
        # (console-provisioned) values are never clobbered by defaults.
        'utcOffsetMinutes': 0,  # no timezone set on the frame
        'timeZone': '',  # firmware >= 2026.8.34 installs the zone itself
        'timeZoneData': None,
        'rotate': 0,
        'scalingMode': 'contain',
        'maxHttpResponseBytes': 4 * 1024 * 1024,
        'adminAuth': expected_admin_auth,
        'tls': expected_tls,
    }

    # Defaults: local render on PSRAM boards, power flags off, and an unset
    # scaling mode falls back to the embedded default "cover"
    frame.scaling_mode = None
    frame.device_config = {
        key: value
        for key, value in (frame.device_config or {}).items()
        if key not in ('renderMode', 'deepSleep', 'wakeSchedule')
    }
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.json()['frame'] == {
        'interval': 61.5,
        'name': 'Kitchen',
        'renderMode': 'local',
        'deepSleep': False,
        'wakeSchedule': False,
        'utcOffsetMinutes': 0,
        'timeZone': '',
        'timeZoneData': None,
        'rotate': 0,
        'scalingMode': 'cover',
        'maxHttpResponseBytes': 4 * 1024 * 1024,
        'adminAuth': expected_admin_auth,
        'tls': expected_tls,
    }


@pytest.mark.asyncio
async def test_settings_carry_what_a_console_line_cannot(async_client, no_auth_client, db):
    """The three settings a stock release image can only learn from this poll:
    the HTTP response cap (kilobyte-scale integer, but read once at boot), the
    board's own admin login, and its HTTPS listener + PEM material."""
    frame = await device_frame(async_client, db)
    frame.max_http_response_bytes = 512 * 1024
    frame.frame_admin_auth = {'enabled': True, 'user': 'kitchen', 'pass': 's3cret'}
    frame.https_proxy = {
        'enable': True,
        'port': 9443,
        'certs': {
            'server': '-----BEGIN CERTIFICATE-----\nserver\n-----END CERTIFICATE-----\n',
            'server_key': '-----BEGIN EC PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
            'client_ca': '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n',
        },
    }
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    settings = response.json()['frame']
    assert settings['maxHttpResponseBytes'] == 512 * 1024
    assert settings['adminAuth'] == {'enabled': True, 'user': 'kitchen', 'pass': 's3cret'}
    assert settings['tls'] == {
        'enable': True,
        'port': 9443,
        'cert': '-----BEGIN CERTIFICATE-----\nserver\n-----END CERTIFICATE-----\n',
        'key': '-----BEGIN EC PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
        # The client CA is the backend's business, never the device's.
    }

    # The device refuses admin auth enabled without credentials, so the
    # backend must not ask for it either.
    frame.frame_admin_auth = {'enabled': True, 'user': 'kitchen', 'pass': ''}
    frame.https_proxy = {'enable': False, 'certs': {}}
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    settings = response.json()['frame']
    assert settings['adminAuth'] == {'enabled': False, 'user': 'kitchen', 'pass': ''}
    assert settings['tls'] == {'enable': False, 'port': 8443, 'cert': '', 'key': ''}


@pytest.mark.asyncio
async def test_settings_includes_schedule_and_utc_offset(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    frame.schedule = {
        'events': [
            {'id': 'a', 'minute': 0, 'hour': 7, 'weekday': 8,
             'event': 'setCurrentScene', 'payload': {'sceneId': 'morning'}},
        ]
    }
    frame.timezone = 'UTC'
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['schedule'] == frame.schedule
    assert body['frame']['utcOffsetMinutes'] == 0

    # A real zone produces its current offset; UTC+ zones are positive.
    frame.timezone = 'Etc/GMT-2'  # POSIX sign convention: this is UTC+2
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.json()['frame']['utcOffsetMinutes'] == 120

    # No schedule → explicit null, so the device clears a stored one.
    frame.schedule = None
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.json()['schedule'] is None


@pytest.mark.asyncio
async def test_settings_etag_supports_cheap_polling(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    etag = response.headers['etag']
    assert etag.startswith('"') and etag.endswith('"')

    # Unchanged payload + If-None-Match → 304 (device polls between renders)
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings',
        headers={**auth(frame), 'If-None-Match': etag})
    assert response.status_code == 304
    assert response.headers['etag'] == etag

    # A settings change → new ETag + fresh payload
    frame.interval = 999
    db.add(frame)
    db.commit()
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings',
        headers={**auth(frame), 'If-None-Match': etag})
    assert response.status_code == 200
    assert response.headers['etag'] != etag
    assert response.json()['frame']['interval'] == 999.0


@pytest.mark.asyncio
async def test_ota_manifest_relays_the_published_release(async_client, no_auth_client, db):
    """The backend builds nothing: the manifest is the GitHub release's, for
    the flash layout the device names, with the download pointed back here."""
    frame = await device_frame(async_client, db)
    listing, text = patch_release(release_with('esp32-s3-generic'))

    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic',
            headers=auth(frame))

    assert response.status_code == 200, response.text
    manifest = response.json()
    assert manifest['platform'] == 'esp32-s3-generic'
    assert manifest['version'] == '2026.9.2'
    assert manifest['size'] == 700
    assert manifest['minisig'] == MINISIG_TEXT
    assert manifest['downloadUrl'] == (
        f'/api/frames/{frame.id}/embedded/ota/download?platform=esp32-s3-generic'
    )
    # Legacy identifier for firmware from before the signed release OTA: it
    # compares the sha against the image it last applied, so a stable
    # per-release token is what moves those boards onto the release image.
    import hashlib
    assert manifest['sha256'] == hashlib.sha256(b'2026.9.2:esp32-s3-generic').hexdigest()
    assert response.headers['cache-control'] == 'private, max-age=300'


@pytest.mark.asyncio
async def test_ota_manifest_serves_the_layout_the_device_asks_for(async_client, no_auth_client, db):
    """Firmware since the signed release OTA names its own flash layout, and
    that — not the backend's idea of the board — picks the image."""
    frame = await device_frame(async_client, db)
    listing, text = patch_release(release_with('esp32-s3-generic', 'esp32-s3-16mb'))

    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-16mb',
            headers=auth(frame))

    assert response.status_code == 200, response.text
    manifest = response.json()
    assert manifest['platform'] == 'esp32-s3-16mb'
    assert manifest['size'] == 701  # the -16mb app image, not the generic one
    assert manifest['downloadUrl'].endswith('platform=esp32-s3-16mb')


@pytest.mark.asyncio
async def test_ota_manifest_without_a_platform_uses_the_frames_layout(async_client, no_auth_client, db):
    """Older firmware sends no platform. The fallback resolves the frame's
    own release image — and with no listing to consult it is the generic one
    for the chip, which for an 8MB S3 IS its layout."""
    frame = await device_frame(async_client, db)
    frame.embedded = {**(frame.embedded or {}), 'flashSize': '16MB'}
    db.add(frame)
    db.commit()

    listing, text = patch_release(release_with('esp32-s3-generic', 'esp32-s3-16mb'))
    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest', headers=auth(frame))

    assert response.status_code == 200, response.text
    # embedded_release_firmware_for_frame is called without a published-asset
    # listing here, so it can only offer the generic image for the chip.
    assert response.json()['platform'] == 'esp32-s3-generic'


@pytest.mark.asyncio
async def test_ota_manifest_rejects_an_unknown_platform(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    listing, text = patch_release(release_with('esp32-s3-generic'))

    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s9-mega',
            headers=auth(frame))

    assert response.status_code == 400
    assert response.json()['detail'] == 'invalid_platform'


@pytest.mark.asyncio
async def test_ota_manifest_404_when_the_release_has_no_app_image(async_client, no_auth_client, db):
    """A release from before the per-layout OTA images: nothing to install."""
    frame = await device_frame(async_client, db)
    release = {
        'tag_name': RELEASE_TAG,
        'assets': [release_asset('frameos-2026.9.2-esp32-s3-generic.bin', 900)],
    }
    listing, text = patch_release(release)

    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic',
            headers=auth(frame))

    assert response.status_code == 404
    assert response.json()['detail'] == 'ota_image_not_published'


@pytest.mark.asyncio
async def test_ota_manifest_409_for_an_unsigned_release(async_client, no_auth_client, db):
    """The device verifies against the release key baked into every image, so
    an app image without its .minisig is one it could never install."""
    frame = await device_frame(async_client, db)
    listing, text = patch_release(release_with('esp32-s3-generic', minisig=False))

    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic',
            headers=auth(frame))

    assert response.status_code == 409
    assert response.json()['detail'] == 'unsigned_release'


@pytest.mark.asyncio
async def test_ota_manifest_502_when_github_is_unreachable(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    listing, text = patch_release(None)

    with listing, text:
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/manifest?platform=esp32-s3-generic',
            headers=auth(frame))

    assert response.status_code == 502
    assert response.json()['detail'] == 'release_lookup_failed'


@pytest.mark.asyncio
async def test_ota_download_streams_the_release_app_image(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    image = b'\xe9' + b'\x5a' * 63
    requested: list[tuple[str, str | None]] = []

    def handler(request):
        requested.append((str(request.url), request.headers.get('range')))
        return httpx.Response(200, content=image,
                              headers={'content-length': str(len(image))})

    listing, text = patch_release(release_with('esp32-s3-generic'))
    with listing, text, mocked_httpx(handler):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/download?platform=esp32-s3-generic',
            headers=auth(frame))

    assert response.status_code == 200, response.text
    assert response.content == image
    assert response.headers['content-type'] == 'application/octet-stream'
    assert response.headers['accept-ranges'] == 'bytes'
    assert response.headers['x-frameos-image-name'] == 'frameos-2026.9.2-esp32-s3-generic-app.bin'
    assert requested == [
        ('https://github.com/FrameOS/frameos/releases/download/v2026.9.2/'
         'frameos-2026.9.2-esp32-s3-generic-app.bin', None),
    ]


@pytest.mark.asyncio
async def test_ota_download_forwards_a_range_request(async_client, no_auth_client, db):
    """Firmware from before the signed release OTA resumes its download in
    512 KB ranges; it must keep updating, or it never reaches the release
    image at all."""
    frame = await device_frame(async_client, db)
    forwarded: list[str | None] = []

    def handler(request):
        forwarded.append(request.headers.get('range'))
        return httpx.Response(
            206,
            content=b'\x5a' * 16,
            headers={'content-length': '16', 'content-range': 'bytes 0-15/64'},
        )

    listing, text = patch_release(release_with('esp32-s3-generic'))
    with listing, text, mocked_httpx(handler):
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/ota/download?platform=esp32-s3-generic',
            headers={**auth(frame), 'Range': 'bytes=0-15'})

    assert response.status_code == 206, response.text
    assert response.content == b'\x5a' * 16
    assert response.headers['content-range'] == 'bytes 0-15/64'
    assert forwarded == ['bytes=0-15']


@pytest.mark.asyncio
async def test_ota_routes_require_device_auth(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    for path in ('ota/manifest', 'ota/download'):
        response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/{path}')
        assert response.status_code == 401, path
        response = await no_auth_client.get(
            f'/api/frames/{frame.id}/embedded/{path}',
            headers={'Authorization': 'Bearer wrong-key'})
        assert response.status_code == 401, path


def _unpack_levels(packed: bytes, width: int, height: int, bits: int) -> list[int]:
    """Every pixel's packed index, for the sub-byte formats."""
    per_byte = 8 // bits
    row = (width + per_byte - 1) // per_byte
    mask = (1 << bits) - 1
    return [
        (packed[y * row + (x // per_byte)] >> (8 - bits - (x % per_byte) * bits)) & mask
        for y in range(height) for x in range(width)
    ]


@pytest.mark.parametrize('pixel_format,bits,fill', [
    (FOS_PIXEL_1BPP, 1, (128, 128, 128)),
    # Between the 85 and 170 levels: nearest-colour picks one flat level.
    (FOS_PIXEL_2BPP_GRAY, 2, (128, 128, 128)),
    (FOS_PIXEL_4BPP_GRAY, 4, (128, 128, 128)),
    # Halfway between the palette's white and yellow.
    (FOS_PIXEL_2BPP_BWYR, 2, (232, 222, 163)),
    (FOS_PIXEL_4BPP_7COLOR, 4, (232, 222, 163)),
    (FOS_PIXEL_4BPP_SPECTRA6, 4, (188, 190, 96)),
])
def test_packers_dither_a_flat_field(pixel_format, bits, fill):
    """A flat off-palette field must come out as a mix, not one flat level.

    The thin-client packers used to quantize to the nearest colour, which
    turned gradients and photos into hard bands on the panel — the on-device
    renderers Floyd-Steinberg dither before packing, and these must match.
    """
    from PIL import Image

    from app.api.embedded_device import pack_image_for_panel

    width, height = 64, 16
    packed = pack_image_for_panel(Image.new('RGB', (width, height), fill), pixel_format)
    levels = _unpack_levels(packed, width, height, bits)
    assert len(set(levels)) > 1, 'flat field quantized to a single level — dithering is gone'


def test_dual_1bpp_dithers_a_flat_field():
    from PIL import Image

    from app.api.embedded_device import pack_image_for_panel

    width, height = 64, 16
    # Halfway between black and red: must mix the two planes, not pick one.
    packed = pack_image_for_panel(
        Image.new('RGB', (width, height), (128, 0, 0)), FOS_PIXEL_DUAL_1BPP_RED)
    plane = len(packed) // 2
    black_bits = sum(bin(byte).count('1') for byte in packed[:plane])
    red_bits = sum(bin(byte).count('1') for byte in packed[plane:])
    total = plane * 8
    assert 0 < black_bits < total
    assert 0 < red_bits < total


def test_spectra6_packer_skips_the_missing_palette_index():
    """Index 4 is a hole in the Spectra 6 wire palette — never emit it."""
    from PIL import Image

    from app.api.embedded_device import SPECTRA6_PALETTE, pack_image_for_panel

    width, height = 60, 4
    image = Image.new('RGB', (width, height))
    colors = [rgb for rgb in SPECTRA6_PALETTE if max(rgb) <= 255]
    for x in range(width):
        for y in range(height):
            image.putpixel((x, y), colors[(x * len(colors)) // width])
    levels = _unpack_levels(
        pack_image_for_panel(image, FOS_PIXEL_4BPP_SPECTRA6), width, height, 4)
    assert 4 not in levels
    assert set(levels) == {0, 1, 2, 3, 5, 6}
