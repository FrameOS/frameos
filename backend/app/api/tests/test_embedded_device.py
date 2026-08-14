import struct

import pytest

from app.models.frame import Frame
from app.models.settings import Settings
from app.tasks.embedded_firmware import (
    EMBEDDED_FIRMWARE_VERSION,
    FOS_PIXEL_4BPP_SPECTRA6,
    embedded_firmware_config_hash,
    embedded_panel_for_frame,
    ensure_embedded_frame_defaults,
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

    async def fake_render(frame_arg, width, height, **kwargs):
        # Solid black RGBA → the 1bpp packing must come out all zeros,
        # which the (mostly white) diagnostic card never does.
        return bytes([0, 0, 0, 255]) * (width * height)

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba', fake_render)

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    payload = body[12:]
    assert payload == b'\x00' * len(payload)


@pytest.mark.asyncio
async def test_render_falls_back_to_diagnostic_when_scene_render_fails(
    async_client, no_auth_client, db, monkeypatch
):
    frame = await device_frame(async_client, db)
    frame.scenes = [{'id': 'scene-1', 'name': 'Broken', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    async def failing_render(frame_arg, width, height, **kwargs):
        return None

    monkeypatch.setattr('app.api.embedded_device.render_scene_rgba', failing_render)

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render', headers=auth(frame))
    assert response.status_code == 200, response.text
    body = response.content
    assert body[:4] == b'FOSB'
    # The diagnostic card has a white background: 1bpp packing is mostly 0xFF.
    payload = body[12:]
    assert payload.count(0xFF) > len(payload) // 2


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
        'rotate': 0,
        'scalingMode': 'contain',
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
        'rotate': 0,
        'scalingMode': 'cover',
    }


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
async def test_ota_manifest_404_without_build(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/manifest', headers=auth(frame))
    assert response.status_code == 404
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/download', headers=auth(frame))
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_ota_manifest_serves_ready_artifact(async_client, no_auth_client, db, tmp_path):
    frame = await device_frame(async_client, db)
    ota_file = tmp_path / 'frameos-ota.bin'
    ota_file.write_bytes(b'\xe9firmware-bytes')

    embedded = dict(frame.embedded or {})
    embedded['firmware'] = {
        'status': 'ready',
        'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,  # anything else is rewritten to "stale"
        'path': str(ota_file),
        'otaPath': str(ota_file),
        'otaSha256': 'ab' * 32,
        'otaElfSha256': 'cd' * 32,
        'otaSize': ota_file.stat().st_size,
        'panel': embedded_panel_for_frame(frame),
        'configHash': embedded_firmware_config_hash(frame),
    }
    frame.embedded = embedded
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/manifest', headers=auth(frame))
    assert response.status_code == 200, response.text
    manifest = response.json()
    assert manifest['sha256'] == 'ab' * 32
    assert manifest['elfSha256'] == 'cd' * 32
    assert manifest['size'] == ota_file.stat().st_size

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/download', headers=auth(frame))
    assert response.status_code == 200
    assert response.content == b'\xe9firmware-bytes'
    assert response.headers['cache-control'] == 'no-store'

    response = await no_auth_client.head(
        f'/api/frames/{frame.id}/embedded/ota/download', headers=auth(frame))
    assert response.status_code == 200
    assert response.headers['content-length'] == str(ota_file.stat().st_size)
    assert response.content == b''


@pytest.mark.asyncio
async def test_ota_manifest_404_for_ready_4mb_no_ota_build(async_client, no_auth_client, db, tmp_path):
    frame = await device_frame(async_client, db)
    firmware_file = tmp_path / 'frameos-4mb.bin'
    firmware_file.write_bytes(b'\xe9firmware-bytes')

    embedded = dict(frame.embedded or {})
    embedded['flashSize'] = '4MB'
    embedded['firmware'] = {
        'status': 'ready',
        'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,
        'flashSize': '4MB',
        'otaSupported': False,
        'path': str(firmware_file),
        'panel': embedded_panel_for_frame(frame),
        'configHash': embedded_firmware_config_hash(frame),
    }
    frame.embedded = embedded
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/manifest', headers=auth(frame))
    assert response.status_code == 404
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/download', headers=auth(frame))
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_generated_config_uses_frame_network_wifi(async_client, db):
    from app.tasks.embedded_firmware import _generated_config_header, embedded_wifi_credentials

    frame = await device_frame(async_client, db)
    frame.network = {'wifiSSID': 'MyWifi', 'wifiPassword': 'hunter2'}
    db.add(frame)
    db.commit()

    ssid, password = embedded_wifi_credentials(frame)
    assert (ssid, password) == ('MyWifi', 'hunter2')

    header = _generated_config_header(frame, wifi_ssid=ssid, wifi_password=password)
    assert '#define FRAMEOS_DEFAULT_WIFI_SSID "MyWifi"' in header
    assert '#define FRAMEOS_DEFAULT_WIFI_PASS "hunter2"' in header
    assert f'#define FRAMEOS_DEFAULT_FRAME_ID {frame.id}' in header
    assert '#define FRAMEOS_DEFAULT_PANEL "EPD_7in5_V2"' in header
