import pytest
from unittest.mock import AsyncMock, patch

from app.models.frame import Frame
from app.models.settings import Settings
from app.tasks.embedded_firmware import (
    EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES,
    EMBEDDED_FIRMWARE_VERSION,
    EMBEDDED_PICO2_PLATFORM,
    EMBEDDED_PICO2W_PLATFORM,
    EMBEDDED_RENDER_REMOTE,
    EMBEDDED_SUPPORTED_PANELS,
    FOS_PIXEL_2BPP_GRAY,
    FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_SPECTRA6,
    FOS_PIXEL_DUAL_1BPP_RED,
    embedded_buffer_size,
    _generated_config_header,
    check_embedded_panel_fits_memory,
    embedded_default_pins_for_frame,
    embedded_firmware_config_hash,
    embedded_gpio_buttons_for_frame,
    embedded_hostname_for_frame,
    embedded_max_http_response_bytes_for_frame,
    embedded_module_psram_bytes,
    embedded_panel_for_frame,
    embedded_pins_for_frame,
    embedded_platform_for_frame,
    embedded_pixel_format_for_panel,
    embedded_render_psram_bytes,
    embedded_render_mode_for_frame,
    ensure_embedded_frame_defaults,
    request_pending_embedded_firmware_ota,
    _reset_stale_embedded_sdkconfig,
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


async def create_pico2_frame(async_client) -> dict:
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pico 2 Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'pico2',
    })
    assert response.status_code == 200, response.text
    return response.json()['frame']


async def create_pico2w_frame(async_client) -> dict:
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pico 2 W Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'pico2w',
        'network': {'wifiSSID': 'Test WiFi', 'wifiPassword': 'secret1234'},
    })
    assert response.status_code == 200, response.text
    return response.json()['frame']


@pytest.mark.asyncio
async def test_new_embedded_frame(async_client):
    frame = await create_embedded_frame(async_client)
    assert frame['mode'] == 'embedded'
    assert frame['embedded']['platform'] == 'esp32-s3'
    assert frame['agent']['agentEnabled'] is False
    assert frame['https_proxy']['enable'] is True
    assert frame['https_proxy']['port'] == 8443
    assert 'BEGIN CERTIFICATE' in frame['https_proxy']['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in frame['https_proxy']['certs']['server_key']
    assert 'BEGIN CERTIFICATE' in frame['https_proxy']['certs']['client_ca']
    assert frame['max_http_response_bytes'] == EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert frame['device_config']['pins']['cs'] == 3
    assert frame['device_config']['pins']['cs2'] == -1


@pytest.mark.asyncio
async def test_new_pico2_frame(async_client):
    frame = await create_pico2_frame(async_client)
    assert frame['mode'] == 'embedded'
    assert frame['embedded']['platform'] == 'pico2'
    assert frame['agent']['agentEnabled'] is False
    assert frame['https_proxy']['enable'] is False
    assert frame['device'] == 'waveshare.EPD_2in13_V4'
    assert frame['device_config']['pins'] == {
        'rst': 21,
        'dc': 20,
        'cs': 17,
        'cs2': -1,
        'busy': 16,
        'sck': 18,
        'mosi': 19,
        'pwr': -1,
    }


@pytest.mark.asyncio
async def test_new_pico2w_frame(async_client):
    frame = await create_pico2w_frame(async_client)
    assert frame['mode'] == 'embedded'
    assert frame['embedded']['platform'] == 'pico2w'
    assert frame['agent']['agentEnabled'] is False
    assert frame['https_proxy']['enable'] is False
    assert frame['device'] == 'waveshare.EPD_2in13_V4'
    assert frame['network']['wifiSSID'] == 'Test WiFi'
    assert frame['network']['wifiPassword'] == 'secret1234'
    assert frame['device_config']['pins']['sck'] == 18
    assert frame['device_config']['pins']['mosi'] == 19


@pytest.mark.asyncio
async def test_new_embedded_frame_rejects_unknown_platform(async_client):
    response = await async_client.post('/api/frames/new', json={
        'name': 'ESP32 Frame',
        'frame_host': '',
        'server_host': 'localhost',
        'mode': 'embedded',
        'platform': 'arduino-uno',
    })
    assert response.status_code == 400
    assert 'Unsupported embedded platform' in response.json()['detail']


@pytest.mark.asyncio
async def test_update_frame_to_embedded_applies_defaults(async_client, db):
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pi Frame',
        'frame_host': 'pi.local',
        'server_host': 'localhost',
    })
    assert response.status_code == 200, response.text
    frame_id = response.json()['frame']['id']

    response = await async_client.post(f'/api/frames/{frame_id}', json={
        'mode': 'embedded',
        'network': {'wifiSSID': 'Test WiFi', 'wifiPassword': 'secret1234'},
    })
    assert response.status_code == 200, response.text

    db.expire_all()
    stored = db.get(Frame, frame_id)
    assert stored.mode == 'embedded'
    assert stored.embedded['platform'] == 'esp32-s3'
    assert stored.agent['agentEnabled'] is False
    assert stored.https_proxy['enable'] is True
    assert stored.https_proxy['port'] == 8443
    assert 'BEGIN CERTIFICATE' in stored.https_proxy['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in stored.https_proxy['certs']['server_key']
    assert stored.log_to_file is None
    assert stored.network['wifiSSID'] == 'Test WiFi'
    assert stored.network['wifiPassword'] == 'secret1234'
    assert stored.device.startswith('waveshare.')
    assert stored.max_http_response_bytes == EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert stored.device_config['pins']['rst'] == 5


@pytest.mark.asyncio
async def test_firmware_status_idle(async_client):
    frame = await create_embedded_frame(async_client)
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json() == {'firmware': {'status': 'idle', 'platform': 'esp32-s3'}}


@pytest.mark.asyncio
async def test_pico2_firmware_status_idle(async_client):
    frame = await create_pico2_frame(async_client)
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json() == {'firmware': {'status': 'idle', 'platform': 'pico2'}}


@pytest.mark.asyncio
async def test_pico2w_firmware_status_idle(async_client):
    frame = await create_pico2w_frame(async_client)
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json() == {'firmware': {'status': 'idle', 'platform': 'pico2w'}}


@pytest.mark.asyncio
async def test_firmware_endpoints_reject_non_embedded_frames(async_client):
    response = await async_client.post('/api/frames/new', json={
        'name': 'Pi Frame',
        'frame_host': 'pi@localhost',
        'server_host': 'localhost',
    })
    assert response.status_code == 200
    frame_id = response.json()['frame']['id']

    for method, url in [
        ('GET', f'/api/frames/{frame_id}/embedded/firmware'),
        ('POST', f'/api/frames/{frame_id}/embedded/firmware'),
        ('GET', f'/api/frames/{frame_id}/embedded/firmware/download'),
        ('POST', f'/api/frames/{frame_id}/embedded/firmware/ota'),
    ]:
        response = await async_client.request(method, url)
        assert response.status_code == 400, url


@pytest.mark.asyncio
async def test_firmware_build_requires_toolchain(async_client):
    frame = await create_embedded_frame(async_client)
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=False):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 400
    assert 'ESP-IDF toolchain not found' in response.json()['detail']


@pytest.mark.asyncio
async def test_pico2_firmware_build_queues_job_with_docker_fallback(async_client, db, redis):
    frame = await create_pico2_frame(async_client)
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=False):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['message'] == 'Firmware build started'
    assert data['firmware']['status'] == 'queued'
    assert data['firmware']['platform'] == 'pico2'
    assert data['firmware']['queueJobId'].startswith(f"embedded_firmware:{frame['id']}:")


@pytest.mark.asyncio
async def test_pico2_firmware_build_requires_pico_sdk_when_build_environment_disabled(async_client, db):
    frame = await create_pico2_frame(async_client)
    stored = db.get(Frame, frame['id'])
    db.add(Settings(project_id=stored.project_id, key='buildEnvironment', value={'provider': 'none'}))
    db.commit()
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=False):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 400
    assert 'Pico SDK toolchain not found' in response.json()['detail']
    assert "selected build environment is 'none'" in response.json()['detail']


@pytest.mark.asyncio
async def test_firmware_build_queues_job(async_client, db, redis):
    frame = await create_embedded_frame(async_client)
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['message'] == 'Firmware build started'
    assert data['firmware']['status'] == 'queued'
    assert data['firmware']['platform'] == 'esp32-s3'
    assert data['firmware']['queueJobId'].startswith(f"embedded_firmware:{frame['id']}:")

    stored = db.get(Frame, frame['id'])
    assert stored.embedded['firmware']['status'] == 'queued'


@pytest.mark.asyncio
async def test_pico2_firmware_build_queues_job(async_client, db, redis):
    frame = await create_pico2_frame(async_client)
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['message'] == 'Firmware build started'
    assert data['firmware']['status'] == 'queued'
    assert data['firmware']['platform'] == 'pico2'
    assert data['firmware']['queueJobId'].startswith(f"embedded_firmware:{frame['id']}:")


@pytest.mark.asyncio
async def test_pico2w_firmware_build_queues_job(async_client, db, redis):
    frame = await create_pico2w_frame(async_client)
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['message'] == 'Firmware build started'
    assert data['firmware']['status'] == 'queued'
    assert data['firmware']['platform'] == 'pico2w'
    assert data['firmware']['queueJobId'].startswith(f"embedded_firmware:{frame['id']}:")


@pytest.mark.asyncio
async def test_firmware_download(async_client, db, tmp_path):
    frame = await create_embedded_frame(async_client)

    artifact = tmp_path / 'frameos-esp32-s3.bin'
    artifact.write_bytes(b'firmware-bytes')
    stored = db.get(Frame, frame['id'])
    stored.embedded = {
        'platform': 'esp32-s3',
        'firmware': {
            'status': 'ready',
            'platform': 'esp32-s3',
            'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,
            'filename': 'frameos-esp32-s3.bin',
            'path': str(artifact),
            'panel': 'EPD_7in5_V2',
            'configHash': embedded_firmware_config_hash(stored),
            'otaPath': str(artifact),
            'otaSha256': 'ab' * 32,
            'otaElfSha256': 'cd' * 32,
            'otaSize': artifact.stat().st_size,
        },
    }
    db.add(stored)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 200
    assert response.content == b'firmware-bytes'
    assert 'frameos-esp32-s3.bin' in response.headers.get('content-disposition', '')


@pytest.mark.asyncio
async def test_pico2_firmware_download(async_client, db, tmp_path):
    frame = await create_pico2_frame(async_client)

    artifact = tmp_path / 'frameos-pico2.uf2'
    artifact.write_bytes(b'uf2-firmware-bytes')
    stored = db.get(Frame, frame['id'])
    stored.embedded = {
        'platform': 'pico2',
        'firmware': {
            'status': 'ready',
            'platform': 'pico2',
            'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,
            'filename': 'frameos-pico2.uf2',
            'path': str(artifact),
            'panel': 'EPD_2in13_V4',
            'configHash': embedded_firmware_config_hash(stored),
        },
    }
    db.add(stored)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 200
    assert response.content == b'uf2-firmware-bytes'
    assert 'frameos-pico2.uf2' in response.headers.get('content-disposition', '')


@pytest.mark.asyncio
async def test_pico2w_firmware_download(async_client, db, tmp_path):
    frame = await create_pico2w_frame(async_client)

    artifact = tmp_path / 'frameos-pico2w.uf2'
    artifact.write_bytes(b'pico2w-uf2-firmware-bytes')
    stored = db.get(Frame, frame['id'])
    stored.embedded = {
        'platform': 'pico2w',
        'firmware': {
            'status': 'ready',
            'platform': 'pico2w',
            'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,
            'filename': 'frameos-pico2w.uf2',
            'path': str(artifact),
            'panel': 'EPD_2in13_V4',
            'configHash': embedded_firmware_config_hash(stored),
        },
    }
    db.add(stored)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 200
    assert response.content == b'pico2w-uf2-firmware-bytes'
    assert 'frameos-pico2w.uf2' in response.headers.get('content-disposition', '')


@pytest.mark.asyncio
async def test_firmware_from_older_project_version_is_stale(async_client, db, tmp_path):
    frame = await create_embedded_frame(async_client)

    artifact = tmp_path / 'frameos-esp32-s3.bin'
    artifact.write_bytes(b'firmware-bytes')
    stored = db.get(Frame, frame['id'])
    stored.embedded = {
        'platform': 'esp32-s3',
        'firmware': {
            'status': 'ready',
            'platform': 'esp32-s3',
            'firmwareVersion': EMBEDDED_FIRMWARE_VERSION - 1,
            'filename': 'frameos-esp32-s3.bin',
            'path': str(artifact),
        },
    }
    db.add(stored)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json()['firmware']['status'] == 'stale'

    # Stale firmware is not downloadable and a new build request rebuilds instead of re-serving
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 404

    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json()['firmware']['status'] == 'queued'


@pytest.mark.asyncio
async def test_firmware_download_missing_artifact(async_client, db):
    frame = await create_embedded_frame(async_client)
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_firmware_ota_queues_build_when_artifact_not_ready(async_client):
    frame = await create_embedded_frame(async_client)
    with patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware/ota")

    assert response.status_code == 200, response.text
    firmware = response.json()['firmware']
    assert response.json()['message'] == 'OTA update queued'
    assert firmware['status'] == 'queued'
    assert firmware['otaUpdate']['status'] == 'queued'


@pytest.mark.asyncio
async def test_pico2_firmware_ota_is_not_supported(async_client):
    frame = await create_pico2_frame(async_client)
    response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware/ota")

    assert response.status_code == 400
    assert 'OTA updates are not supported' in response.json()['detail']


@pytest.mark.asyncio
async def test_pico2w_firmware_ota_is_not_supported(async_client):
    frame = await create_pico2w_frame(async_client)
    response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware/ota")

    assert response.status_code == 400
    assert 'OTA updates are not supported' in response.json()['detail']


@pytest.mark.asyncio
async def test_firmware_ota_requests_device_update(async_client, db, tmp_path):
    frame = await create_embedded_frame(async_client)

    artifact = tmp_path / 'frameos-esp32-s3.bin'
    ota_artifact = tmp_path / 'frameos-esp32-s3-ota.bin'
    artifact.write_bytes(b'flash-image')
    ota_artifact.write_bytes(b'\xe9ota-image')
    stored = db.get(Frame, frame['id'])
    stored.embedded = {
        'platform': 'esp32-s3',
        'firmware': {
            'status': 'ready',
            'platform': 'esp32-s3',
            'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,
            'filename': 'frameos-esp32-s3.bin',
            'path': str(artifact),
            'size': artifact.stat().st_size,
            'sha256': '11' * 32,
            'panel': 'EPD_7in5_V2',
            'configHash': embedded_firmware_config_hash(stored),
            'otaPath': str(ota_artifact),
            'otaSha256': '22' * 32,
            'otaElfSha256': '33' * 32,
            'otaSize': ota_artifact.stat().st_size,
        },
    }
    db.add(stored)
    db.commit()

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch_frame:
        fetch_frame.return_value = (200, b'{"ok":true}', {'content-type': 'application/json'})
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware/ota")

    assert response.status_code == 200, response.text
    assert response.json()['message'] == 'OTA update requested'
    assert response.json()['device'] == {'ok': True}
    assert response.json()['firmware']['otaUpdate']['status'] == 'requested'
    fetch_frame.assert_awaited_once()
    assert fetch_frame.await_args.kwargs['path'] == '/api/action/ota'
    assert fetch_frame.await_args.kwargs['method'] == 'POST'


@pytest.mark.asyncio
async def test_pending_firmware_ota_requests_device_when_build_becomes_ready(db, redis, tmp_path, async_client):
    frame = await create_embedded_frame(async_client)

    artifact = tmp_path / 'frameos-esp32-s3.bin'
    ota_artifact = tmp_path / 'frameos-esp32-s3-ota.bin'
    artifact.write_bytes(b'flash-image')
    ota_artifact.write_bytes(b'\xe9ota-image')
    stored = db.get(Frame, frame['id'])
    stored.embedded = {
        'platform': 'esp32-s3',
        'firmware': {
            'status': 'ready',
            'platform': 'esp32-s3',
            'firmwareVersion': EMBEDDED_FIRMWARE_VERSION,
            'filename': 'frameos-esp32-s3.bin',
            'path': str(artifact),
            'size': artifact.stat().st_size,
            'sha256': '11' * 32,
            'panel': 'EPD_7in5_V2',
            'configHash': embedded_firmware_config_hash(stored),
            'otaPath': str(ota_artifact),
            'otaSha256': '22' * 32,
            'otaElfSha256': '33' * 32,
            'otaSize': ota_artifact.stat().st_size,
            'otaUpdate': {
                'id': 'pending-ota',
                'status': 'queued',
                'requestedAt': '2026-06-15T00:00:00+00:00',
            },
        },
    }
    db.add(stored)
    db.commit()

    with patch('app.tasks.embedded_firmware._fetch_frame_http_bytes', new_callable=AsyncMock) as fetch_frame:
        fetch_frame.return_value = (200, b'{"ok":true}', {'content-type': 'application/json'})
        requested = await request_pending_embedded_firmware_ota(db, redis, stored)

    assert requested is True
    fetch_frame.assert_awaited_once()
    db.expire_all()
    updated = db.get(Frame, frame['id'])
    assert updated.embedded['firmware']['otaUpdate']['status'] == 'requested'


# --- M4: panel matrix, memory guardrails, power-setting baking --------------

def test_embedded_panel_matrix_includes_new_panels():
    # The backend panel set and ESP32 selected-panel generator must stay in sync.
    # This covers representative formats: 1bpp, dual-plane, 4-gray, 7-color,
    # and Spectra 6.
    for panel in ("EPD_7in5_V2", "EPD_7in5", "EPD_5in83", "EPD_4in2_V2",
                  "EPD_2in9_V2", "EPD_2in66", "EPD_2in13_V4", "EPD_1in54_V2",
                  "EPD_7in3e", "EPD_4in0e", "EPD_13in3e", "EPD_7in3f",
                  "EPD_5in65f", "EPD_7in3g", "EPD_10in2b"):
        assert panel in EMBEDDED_SUPPORTED_PANELS
        assert embedded_panel_for_frame(Frame(device=f"waveshare.{panel}")) == panel
    # Unsupported non-generic buses fall back to headless rather than a bad build.
    assert embedded_panel_for_frame(Frame(device="waveshare.EPD_10in3")) == "none"
    assert embedded_panel_for_frame(Frame(device="waveshare.EPD_12in48")) == "none"


def test_embedded_panel_formats_and_buffer_sizes():
    assert embedded_pixel_format_for_panel("EPD_2in9_V2") == FOS_PIXEL_2BPP_GRAY
    assert embedded_pixel_format_for_panel("EPD_4in2_V2") == FOS_PIXEL_2BPP_GRAY
    assert embedded_pixel_format_for_panel("EPD_10in2b") == FOS_PIXEL_DUAL_1BPP_RED
    assert embedded_pixel_format_for_panel("EPD_7in3f") == FOS_PIXEL_4BPP_7COLOR
    assert embedded_pixel_format_for_panel("EPD_7in3e") == FOS_PIXEL_4BPP_SPECTRA6
    assert embedded_buffer_size(128, 296, FOS_PIXEL_2BPP_GRAY) == ((128 + 3) // 4) * 296
    assert embedded_buffer_size(1200, 1600, FOS_PIXEL_4BPP_SPECTRA6) == 600 * 1600


def test_embedded_render_psram_estimate():
    # 800x480 RGBA (1.5MB) + default packed 1bpp + ~1.5MB reserve is ~3MB.
    need = embedded_render_psram_bytes(800, 480)
    assert 2_900_000 < need < 3_200_000


def test_panel_fits_default_8mb_module():
    # Representative large 1bpp panel fits a stock 8MB S3 module.
    frame = Frame(device="waveshare.EPD_7in5_V2")
    assert embedded_module_psram_bytes(frame) == 8 * 1024 * 1024
    check_embedded_panel_fits_memory(frame)  # must not raise


def test_panel_too_large_for_small_psram_is_rejected():
    frame = Frame(device="waveshare.EPD_7in5_V2", device_config={"psramMB": 2})
    assert embedded_module_psram_bytes(frame) == 2 * 1024 * 1024
    with pytest.raises(ValueError) as exc:
        check_embedded_panel_fits_memory(frame)
    assert "PSRAM" in str(exc.value)


def test_large_spectra_panel_requires_16mb_for_local_rendering():
    frame = Frame(device="waveshare.EPD_13in3e")
    with pytest.raises(ValueError) as exc:
        check_embedded_panel_fits_memory(frame)
    assert "13in3e" in str(exc.value)

    frame.device_config = {"psramMB": 16, "pins": {"cs2": 8}}
    check_embedded_panel_fits_memory(frame)


def test_embedded_defaults_choose_response_limit_and_pin_layout():
    frame = Frame(
        id=7,
        device="waveshare.EPD_13in3e",
        max_http_response_bytes=64 * 1024 * 1024,
        device_config={"psramMB": 16},
    )
    ensure_embedded_frame_defaults(frame)
    assert frame.frame_port == 80
    assert frame.max_http_response_bytes == EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    assert frame.device_config["pins"]["cs2"] == 8
    assert embedded_default_pins_for_frame(frame)["cs2"] == 8

    custom_port = Frame(device="waveshare.EPD_7in5_V2", frame_port=8081)
    ensure_embedded_frame_defaults(custom_port)
    assert custom_port.frame_port == 8081

    custom = Frame(
        device="waveshare.EPD_7in5_V2",
        max_http_response_bytes=3 * 1024 * 1024,
        device_config={"pins": {"rst": 12, "sclk": 11}},
    )
    assert embedded_max_http_response_bytes_for_frame(custom) == 3 * 1024 * 1024
    assert embedded_pins_for_frame(custom)["rst"] == 12
    assert embedded_pins_for_frame(custom)["sck"] == 11


def test_pico2_defaults_choose_remote_render_and_pin_layout():
    frame = Frame(id=7, embedded={"platform": "pico2"}, device="web_only")
    ensure_embedded_frame_defaults(frame)
    assert embedded_platform_for_frame(frame) == EMBEDDED_PICO2_PLATFORM
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    assert frame.device == "waveshare.EPD_2in13_V4"
    assert frame.https_proxy["enable"] is False
    assert frame.device_config["pins"]["sck"] == 18
    assert frame.device_config["pins"]["mosi"] == 19

    custom = Frame(
        embedded={"platform": "pico2"},
        device="waveshare.EPD_2in13_V4",
        device_config={"pins": {"rst": 30, "dc": 22, "sclk": 18}},
    )
    assert embedded_pins_for_frame(custom)["rst"] == 21
    assert embedded_pins_for_frame(custom)["dc"] == 22
    assert embedded_pins_for_frame(custom)["sck"] == 18


def test_pico2w_defaults_choose_remote_render_and_pin_layout():
    frame = Frame(id=7, embedded={"platform": "pico2w"}, device="web_only")
    ensure_embedded_frame_defaults(frame)
    assert embedded_platform_for_frame(frame) == EMBEDDED_PICO2W_PLATFORM
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    assert frame.device == "waveshare.EPD_2in13_V4"
    assert frame.https_proxy["enable"] is False
    assert frame.device_config["pins"]["busy"] == 16
    assert frame.device_config["pins"]["cs"] == 17


def test_large_spectra_panel_can_use_thin_client_on_8mb():
    frame = Frame(device="waveshare.EPD_13in3e", device_config={"renderMode": "remote"})
    assert embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE
    check_embedded_panel_fits_memory(frame)


def test_headless_frame_skips_memory_check():
    check_embedded_panel_fits_memory(Frame(device="web_only"))  # must not raise


def test_generated_config_bakes_power_settings():
    frame = Frame(
        id=7,
        server_host="backend.local",
        server_port=8989,
        server_api_key="key",
        device="waveshare.EPD_7in5_V2",
        device_config={
            "deepSleep": True,
            "wakeSchedule": True,
            "batteryPin": 2,
            "batteryDivider": 2.0,
            "pins": {"cs2": 8},
        },
    )
    header = _generated_config_header(frame)
    assert "#define FRAMEOS_DEFAULT_RENDER_MODE 0" in header
    assert "#define FRAMEOS_DEFAULT_DEEP_SLEEP 1" in header
    assert "#define FRAMEOS_DEFAULT_WAKE_SCHEDULE 1" in header
    assert "#define FRAMEOS_DEFAULT_BATTERY_PIN 2" in header
    assert "#define FRAMEOS_DEFAULT_BATTERY_DIVIDER 2.0f" in header
    assert "#define FRAMEOS_DEFAULT_PIN_CS2 8" in header
    assert f"#define FRAMEOS_DEFAULT_MAX_HTTP_RESPONSE_BYTES {EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES}" in header
    assert "#define FRAMEOS_DEFAULT_SERVER_SEND_LOGS 1" in header
    assert "#define FRAMEOS_DEFAULT_TLS_ENABLE 0" in header
    assert "#define FRAMEOS_DEFAULT_TLS_PORT 8443" in header


def test_generated_config_bakes_tls_settings():
    frame = Frame(
        id=7,
        server_host="backend.local",
        server_port=8989,
        server_api_key="key",
        device="waveshare.EPD_7in5_V2",
        https_proxy={
            "enable": True,
            "port": 9443,
            "certs": {
                "server": "-----BEGIN CERTIFICATE-----\nserver\n-----END CERTIFICATE-----\n",
                "server_key": "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
                "client_ca": "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
            },
        },
    )
    header = _generated_config_header(frame)
    assert "#define FRAMEOS_DEFAULT_TLS_ENABLE 1" in header
    assert "#define FRAMEOS_DEFAULT_TLS_PORT 9443" in header
    assert 'FRAMEOS_DEFAULT_TLS_SERVER_CERT "-----BEGIN CERTIFICATE-----\\nserver\\n-----END CERTIFICATE-----\\n"' in header
    assert 'FRAMEOS_DEFAULT_TLS_SERVER_KEY "-----BEGIN RSA PRIVATE KEY-----\\nkey\\n-----END RSA PRIVATE KEY-----\\n"' in header


def test_generated_config_bakes_hostname_from_frame_host():
    frame = Frame(id=7, frame_host="Kitchen Frame.local", server_host="backend.local",
                  server_port=8989, server_api_key="key", device="waveshare.EPD_7in5_V2")
    header = _generated_config_header(frame)
    assert embedded_hostname_for_frame(frame) == "kitchen-frame"
    assert '#define FRAMEOS_DEFAULT_HOSTNAME "kitchen-frame"' in header


def test_generated_config_bakes_gpio_buttons():
    frame = Frame(
        id=7,
        server_host="backend.local",
        server_port=8989,
        server_api_key="key",
        device="waveshare.EPD_7in5_V2",
        gpio_buttons=[{"pin": 5, "label": "A"}, {"pin": 6, "label": "Render: now"}],
    )
    header = _generated_config_header(frame)
    assert embedded_gpio_buttons_for_frame(frame) == [(5, "A"), (6, "Render now")]
    assert '#define FRAMEOS_DEFAULT_GPIO_BUTTONS "5:A\\n6:Render now"' in header


def test_embedded_hostname_falls_back_for_ip_hosts():
    assert embedded_hostname_for_frame(Frame(id=12, frame_host="192.168.1.50")) == "frame12"


def test_generated_config_omits_absent_power_settings():
    frame = Frame(id=7, server_host="backend.local", server_port=8989,
                  server_api_key="key", device="waveshare.EPD_7in5_V2")
    header = _generated_config_header(frame)
    assert "#define FRAMEOS_DEFAULT_RENDER_MODE 0" in header
    assert "FRAMEOS_DEFAULT_DEEP_SLEEP" not in header
    assert "FRAMEOS_DEFAULT_BATTERY_PIN" not in header


def test_generated_config_bakes_remote_render_mode():
    frame = Frame(id=7, server_host="backend.local", server_port=8989,
                  server_api_key="key", device="waveshare.EPD_13in3e",
                  device_config={"renderMode": "remote"})
    header = _generated_config_header(frame)
    assert "#define FRAMEOS_DEFAULT_RENDER_MODE 1" in header


def test_generated_config_bakes_pico2_platform_settings():
    frame = Frame(
        id=7,
        server_host="backend.local",
        server_port=8989,
        server_api_key="key",
        embedded={"platform": "pico2"},
        device="waveshare.EPD_2in13_V4",
    )
    header = _generated_config_header(frame)
    assert '#define FRAMEOS_DEFAULT_PLATFORM "pico2"' in header
    assert "#define FRAMEOS_DEFAULT_RENDER_MODE 1" in header
    assert "#define FRAMEOS_PICO2_FLASH_BYTES 4194304" in header
    assert "#define FRAMEOS_PICO2_SRAM_BYTES 532480" in header


def test_generated_config_bakes_pico2w_platform_settings():
    frame = Frame(
        id=7,
        server_host="backend.local",
        server_port=8989,
        server_api_key="key",
        embedded={"platform": "pico2w"},
        device="waveshare.EPD_2in13_V4",
        network={"wifiSSID": "Test WiFi", "wifiPassword": "secret1234"},
    )
    header = _generated_config_header(frame, wifi_ssid="Test WiFi", wifi_password="secret1234")
    assert '#define FRAMEOS_DEFAULT_PLATFORM "pico2w"' in header
    assert '#define FRAMEOS_DEFAULT_WIFI_SSID "Test WiFi"' in header
    assert '#define FRAMEOS_DEFAULT_WIFI_PASS "secret1234"' in header
    assert "#define FRAMEOS_DEFAULT_RENDER_MODE 1" in header
    assert "#define FRAMEOS_PICO2_FLASH_BYTES 4194304" in header


def test_generated_config_bakes_disabled_backend_logs():
    frame = Frame(id=7, server_host="backend.local", server_port=8989,
                  server_api_key="key", device="waveshare.EPD_7in5_V2",
                  server_send_logs=False)
    header = _generated_config_header(frame)
    assert "#define FRAMEOS_DEFAULT_SERVER_SEND_LOGS 0" in header


def test_ready_firmware_is_stale_when_panel_changes(tmp_path):
    artifact = tmp_path / "frameos-esp32-s3.bin"
    artifact.write_bytes(b"firmware-bytes")
    frame = Frame(
        id=53,
        server_host="backend.local",
        server_port=8989,
        server_api_key="key",
        device="waveshare.EPD_7in3e",
        embedded={
            "platform": "esp32-s3",
            "firmware": {
                "status": "ready",
                "platform": "esp32-s3",
                "firmwareVersion": EMBEDDED_FIRMWARE_VERSION,
                "filename": "frameos-esp32-s3.bin",
                "path": str(artifact),
                "panel": "EPD_7in5_V2",
                "configHash": "old",
            },
        },
    )
    from app.tasks.embedded_firmware import latest_embedded_firmware

    firmware = latest_embedded_firmware(frame)
    assert firmware["status"] == "stale"
    assert "different embedded panel" in firmware["error"]


def test_reset_stale_embedded_sdkconfig_removes_generated_files(tmp_path):
    sdkconfig = tmp_path / "sdkconfig"
    sdkconfig.write_text("CONFIG_ESP_MAIN_TASK_STACK_SIZE=3584\n", encoding="utf-8")
    sdkconfig_old = tmp_path / "sdkconfig.old"
    sdkconfig_old.write_text("CONFIG_ESP_MAIN_TASK_STACK_SIZE=3584\n", encoding="utf-8")
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    (build_dir / "stale.o").write_text("old", encoding="utf-8")

    with patch("app.tasks.embedded_firmware.EMBEDDED_PROJECT_DIR", tmp_path):
        missing = _reset_stale_embedded_sdkconfig(build_dir)

    assert missing == {"CONFIG_ESP_MAIN_TASK_STACK_SIZE": "8192"}
    assert not sdkconfig.exists()
    assert not sdkconfig_old.exists()
    assert not build_dir.exists()


def test_reset_stale_embedded_sdkconfig_keeps_current_config(tmp_path):
    sdkconfig = tmp_path / "sdkconfig"
    sdkconfig.write_text("CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192\n", encoding="utf-8")
    build_dir = tmp_path / "build"
    build_dir.mkdir()

    with patch("app.tasks.embedded_firmware.EMBEDDED_PROJECT_DIR", tmp_path):
        missing = _reset_stale_embedded_sdkconfig(build_dir)

    assert missing == {}
    assert sdkconfig.exists()
    assert build_dir.exists()
