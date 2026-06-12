import pytest
from unittest.mock import patch

from app.models.frame import Frame
from app.tasks.embedded_firmware import EMBEDDED_FIRMWARE_VERSION


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


@pytest.mark.asyncio
async def test_new_embedded_frame(async_client):
    frame = await create_embedded_frame(async_client)
    assert frame['mode'] == 'embedded'
    assert frame['embedded']['platform'] == 'esp32-s3'
    assert frame['agent']['agentEnabled'] is False
    assert frame['https_proxy']['enable'] is False


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
async def test_firmware_status_idle(async_client):
    frame = await create_embedded_frame(async_client)
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json() == {'firmware': {'status': 'idle', 'platform': 'esp32-s3'}}


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
    ]:
        response = await async_client.request(method, url)
        assert response.status_code == 400, url


@pytest.mark.asyncio
async def test_firmware_build_requires_toolchain(async_client):
    frame = await create_embedded_frame(async_client)
    with patch('app.api.frames.embedded_toolchain_available', return_value=False):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 400
    assert 'ESP-IDF toolchain not found' in response.json()['detail']


@pytest.mark.asyncio
async def test_firmware_build_queues_job(async_client, db, redis):
    frame = await create_embedded_frame(async_client)
    with patch('app.api.frames.embedded_toolchain_available', return_value=True), \
         patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
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
        },
    }
    db.add(stored)
    db.commit()

    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 200
    assert response.content == b'firmware-bytes'
    assert 'frameos-esp32-s3.bin' in response.headers.get('content-disposition', '')


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

    with patch('app.api.frames.embedded_toolchain_available', return_value=True), \
         patch('app.tasks.embedded_firmware.embedded_toolchain_available', return_value=True):
        response = await async_client.post(f"/api/frames/{frame['id']}/embedded/firmware")
    assert response.status_code == 200
    assert response.json()['firmware']['status'] == 'queued'


@pytest.mark.asyncio
async def test_firmware_download_missing_artifact(async_client, db):
    frame = await create_embedded_frame(async_client)
    response = await async_client.get(f"/api/frames/{frame['id']}/embedded/firmware/download")
    assert response.status_code == 404
