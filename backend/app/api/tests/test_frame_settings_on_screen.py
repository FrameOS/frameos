"""The frame page on the frame's own screen: frame_settings_on_screen on the
backend row, in frame.json, in the ESP32 settings document, in the USB
provisioning plan and in the device sync compare."""
import pytest

from app.api import frame_sync
from app.api.embedded_device import embedded_frame_settings
from app.models.frame import Frame, get_frame_json
from app.tasks.embedded_firmware import embedded_provisioning_plan

from .test_embedded_firmware import create_embedded_frame


@pytest.mark.asyncio
async def test_on_by_default_and_turned_off_through_the_update_route(async_client, db):
    response = await async_client.post('/api/frames/new', json={
        'name': 'Hall', 'frame_host': 'hall.local', 'server_host': 'localhost', 'device': 'web_only',
    })
    assert response.status_code == 200
    frame_id = response.json()['frame']['id']
    frame = db.get(Frame, frame_id)
    assert frame.frame_settings_on_screen is True
    assert get_frame_json(db, frame)['frameSettingsOnScreen'] is True
    assert response.json()['frame']['frame_settings_on_screen'] is True

    response = await async_client.post(f'/api/frames/{frame_id}', json={'frame_settings_on_screen': False})
    assert response.status_code == 200
    db.expire_all()
    frame = db.get(Frame, frame_id)
    assert frame.frame_settings_on_screen is False
    assert get_frame_json(db, frame)['frameSettingsOnScreen'] is False

    # An explicit null is the default, on: the column is not nullable.
    response = await async_client.post(f'/api/frames/{frame_id}', json={'frame_settings_on_screen': None})
    assert response.status_code == 200
    db.expire_all()
    assert db.get(Frame, frame_id).frame_settings_on_screen is True


@pytest.mark.asyncio
async def test_the_esp32_hears_it_in_its_settings_and_its_provisioning(async_client, db):
    frame = db.get(Frame, (await create_embedded_frame(async_client))['id'])
    assert embedded_frame_settings(frame)['frameSettingsOnScreen'] is True
    keys = [setting['key'] for setting in embedded_provisioning_plan(frame)['settings']]
    # On is the firmware's default: an older release image would refuse the key.
    assert 'frame_settings_on_screen' not in keys

    frame.frame_settings_on_screen = False
    db.commit()
    assert embedded_frame_settings(frame)['frameSettingsOnScreen'] is False
    settings = {setting['key']: setting for setting in embedded_provisioning_plan(frame)['settings']}
    assert settings['frame_settings_on_screen']['value'] == '0'


def test_the_device_sync_compare_reads_a_missing_key_as_on():
    assert frame_sync._sync_frame_value('frame_settings_on_screen', None) is True
    assert frame_sync._sync_frame_value('frame_settings_on_screen', False) is False
    assert frame_sync._sync_label('frame_settings_on_screen') == 'Frame settings on the screen'
    assert 'frame_settings_on_screen' in frame_sync.FRAME_SYNC_FRAME_KEYS
    backend = {'frame_settings_on_screen': True}
    assert frame_sync._build_frame_sync_section(backend, {}, backend)['changes'] == []
