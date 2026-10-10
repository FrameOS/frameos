"""Deploys that wait for a sleeping ESP32 (utils/embedded_device_requests):
console settings and firmware updates ride the /embedded/settings pull."""

from unittest.mock import AsyncMock, patch

import pytest

from app.api.tests.test_embedded_device import auth, device_frame
from app.models.frame import Frame
from app.models.log import process_log
from app.utils.embedded_device_requests import (
    CONSOLE_REQUEST_KEYS,
    QUEUED_REQUESTS_FIRMWARE_VERSION,
    console_request_for_frame,
    queue_console_request,
    queue_ota_request,
)
from app.utils.embedded_scene_state import queue_embedded_deploy


@pytest.fixture(autouse=True)
def _fresh_redis(redis):
    yield


async def sleeping_frame(async_client, db, firmware: str | None = QUEUED_REQUESTS_FIRMWARE_VERSION) -> Frame:
    frame = await device_frame(async_client, db)
    embedded = dict(frame.embedded or {})
    if firmware:
        embedded['lastBoot'] = {'frameosVersion': firmware}
    frame.embedded = embedded
    from datetime import datetime
    frame.last_log_at = datetime.utcnow()  # stored naive UTC, like the log route writes it
    db.add(frame)
    db.commit()
    return frame


def asleep():
    return patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=OSError('timed out')))


async def settings_pull(no_auth_client, frame):
    response = await no_auth_client.get(f'/api/frames/{frame.id}/embedded/settings', headers=auth(frame))
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_console_request_carries_the_plan_minus_the_connection(async_client, db):
    frame = await sleeping_frame(async_client, db)
    request = console_request_for_frame(frame)
    keys = [key for key, _value in request['settings']]
    assert 'pins' in keys and 'render_mode' in keys
    # What connects the frame to this backend never travels this way.
    assert not {'backend', 'api_key', 'frame_id', 'wifi_ssid', 'wifi_pass'} & set(keys)
    assert set(keys) <= CONSOLE_REQUEST_KEYS
    assert all(isinstance(value, str) for _key, value in request['settings'])


@pytest.mark.asyncio
async def test_console_request_id_only_changes_with_the_settings(async_client, db):
    frame = await sleeping_frame(async_client, db)
    assert queue_console_request(frame) is True
    first = frame.device_requests['console']['id']
    # Deploying again with nothing changed: same id, so no re-apply and no restart.
    assert queue_console_request(frame) is False
    assert frame.device_requests['console']['id'] == first
    frame.rotate = 90
    assert queue_console_request(frame) is True
    assert frame.device_requests['console']['id'] != first


@pytest.mark.asyncio
async def test_settings_pull_carries_the_requests(async_client, no_auth_client, db):
    frame = await sleeping_frame(async_client, db)
    assert 'requests' not in await settings_pull(no_auth_client, frame)

    queue_console_request(frame)
    ota_id = queue_ota_request(frame)
    db.add(frame)
    db.commit()
    payload = await settings_pull(no_auth_client, frame)
    assert payload['requests']['ota'] == {'id': ota_id}
    assert payload['requests']['console']['id'] == frame.device_requests['console']['id']


@pytest.mark.asyncio
async def test_update_button_queues_for_a_sleeping_frame(async_client, no_auth_client, db):
    frame = await sleeping_frame(async_client, db)
    with asleep(), patch('app.api.frames.request_embedded_firmware_update', new=AsyncMock()) as live:
        response = await async_client.post(f'/api/frames/{frame.id}/embedded/firmware/ota')
    assert response.status_code == 200, response.text
    assert response.json()['queued'] is True
    assert 'next check-in' in response.json()['message']
    live.assert_not_awaited()
    assert (await settings_pull(no_auth_client, frame))['requests']['ota']['id']


@pytest.mark.asyncio
async def test_update_button_on_old_firmware_still_needs_the_frame_awake(async_client, db):
    frame = await sleeping_frame(async_client, db, firmware='2026.10.3')
    with asleep(), patch('app.api.frames.request_embedded_firmware_update',
                         new=AsyncMock(side_effect=ValueError('timed out'))):
        response = await async_client.post(f'/api/frames/{frame.id}/embedded/firmware/ota')
    assert response.status_code == 400
    db.refresh(frame)
    assert not (frame.device_requests or {}).get('ota')


@pytest.mark.asyncio
async def test_update_button_on_an_awake_frame_asks_it_directly(async_client, db):
    frame = await sleeping_frame(async_client, db)
    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(return_value=(200, b'pong', {}))), \
            patch('app.api.frames.request_embedded_firmware_update', new=AsyncMock(return_value={'ok': True})) as live:
        response = await async_client.post(f'/api/frames/{frame.id}/embedded/firmware/ota')
    assert response.status_code == 200, response.text
    assert 'queued' not in response.json()
    live.assert_awaited_once()


@pytest.mark.asyncio
async def test_the_device_reporting_the_update_clears_it(async_client, no_auth_client, db, redis):
    frame = await sleeping_frame(async_client, db)
    queue_console_request(frame)
    ota_id = queue_ota_request(frame)
    db.add(frame)
    db.commit()

    # A report for some other request changes nothing.
    await process_log(db, redis, frame, {'event': 'deploy:request', 'kind': 'ota', 'status': 'rebooting',
                                         'id': 'something-else'})
    db.refresh(frame)
    assert frame.device_requests['ota']['id'] == ota_id

    await process_log(db, redis, frame, {'event': 'deploy:request', 'kind': 'ota', 'status': 'rebooting',
                                         'id': ota_id})
    db.refresh(frame)
    # Gone, so a board re-flashed later does not replay it; the settings stay.
    assert 'ota' not in frame.device_requests
    assert 'console' in frame.device_requests
    assert 'ota' not in (await settings_pull(no_auth_client, frame))['requests']


@pytest.mark.asyncio
async def test_a_queued_deploy_counts_once_the_frame_pulls_its_settings(async_client, no_auth_client, db, redis):
    """The C3 thin client pulls no scenes; its settings pull lands the deploy."""
    frame = await sleeping_frame(async_client, db)
    await queue_embedded_deploy(redis, frame.id, {'id': frame.id, 'name': 'thin', 'scenes': []})
    await settings_pull(no_auth_client, frame)
    db.refresh(frame)
    assert frame.last_successful_deploy['name'] == 'thin'


@pytest.mark.asyncio
async def test_update_button_queues_for_a_frame_that_never_checked_in(async_client, no_auth_client, db):
    """No boot report yet, so the firmware is unknown: queue it and say what
    it depends on, instead of trying (and failing) to reach the frame."""
    frame = await device_frame(async_client, db)
    assert frame.last_log_at is None
    with asleep(), patch('app.api.frames.request_embedded_firmware_update', new=AsyncMock()) as live:
        response = await async_client.post(f'/api/frames/{frame.id}/embedded/firmware/ota')
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['queued'] is True
    assert 'first check-in' in body['message'] and QUEUED_REQUESTS_FIRMWARE_VERSION in body['message']
    live.assert_not_awaited()
    assert (await settings_pull(no_auth_client, frame))['requests']['ota']['id']
