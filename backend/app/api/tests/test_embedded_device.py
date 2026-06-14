import io
import struct

import pytest
from PIL import Image

from app.api import embedded_device
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


def image_bytes(width: int = 1200, height: int = 800) -> bytes:
    image = Image.new("RGB", (width, height), (64, 128, 192))
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


@pytest.mark.asyncio
async def test_render_requires_device_auth(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/render')
    assert response.status_code == 401
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/render',
        headers={'Authorization': 'Bearer wrong-key'})
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
    assert response.json() == {
        'embedded': {'imageProxyFallback': False},
        'openAI': {'apiKey': 'sk-frame', 'backendApiKey': 'sk-backend'},
        'unsplash': {'accessKey': 'unsplash-key'},
    }


@pytest.mark.asyncio
async def test_settings_returns_image_proxy_fallback_toggle(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    frame.image_proxy_fallback = True
    db.add(frame)
    db.commit()

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))

    assert response.status_code == 200, response.text
    assert response.json()['embedded'] == {'imageProxyFallback': True}


@pytest.mark.asyncio
async def test_media_proxy_requires_device_auth(async_client, no_auth_client, db):
    frame = await device_frame(async_client, db)
    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/media?url=https://example.com/image.png')
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_media_proxy_resizes_gallery_image(async_client, no_auth_client, db, monkeypatch):
    frame = await device_frame(async_client, db)
    frame.device = 'waveshare.EPD_7in3e'
    db.add(frame)
    db.commit()
    seen_urls = []

    async def fake_fetch(url: str) -> bytes:
        seen_urls.append(url)
        return image_bytes()

    monkeypatch.setattr(embedded_device, "_fetch_embedded_media_source", fake_fetch)

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/media?gallery_category=cute', headers=auth(frame))
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/bmp"
    assert response.headers["x-frameos-output-format"] == "BMP"
    assert response.headers["x-frameos-output-width"] == "400"
    assert response.headers["x-frameos-output-height"] == "240"
    assert response.headers["x-frameos-frame-width"] == "800"
    assert response.headers["x-frameos-frame-height"] == "480"
    assert seen_urls == ["https://gallery.frameos.net/image?category=cute"]
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (400, 240)
        assert image.format == "BMP"


@pytest.mark.asyncio
async def test_media_proxy_honors_bounded_output_size(async_client, no_auth_client, db, monkeypatch):
    frame = await device_frame(async_client, db)
    frame.device = 'waveshare.EPD_7in3e'
    db.add(frame)
    db.commit()

    async def fake_fetch(url: str) -> bytes:
        return image_bytes()

    monkeypatch.setattr(embedded_device, "_fetch_embedded_media_source", fake_fetch)

    response = await no_auth_client.get(
        (
            f'/api/frames/{frame.id}/embedded/media?url=https://example.com/image.png'
            '&output_width=300&output_height=200'
        ),
        headers=auth(frame),
    )
    assert response.status_code == 200, response.text
    assert response.headers["x-frameos-output-width"] == "300"
    assert response.headers["x-frameos-output-height"] == "200"
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (300, 200)
        assert image.format == "BMP"


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
    assert manifest['size'] == ota_file.stat().st_size

    response = await no_auth_client.get(
        f'/api/frames/{frame.id}/embedded/ota/download', headers=auth(frame))
    assert response.status_code == 200
    assert response.content == b'\xe9firmware-bytes'


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
