import json
from unittest.mock import AsyncMock, patch

import pytest

from app.models import new_frame
from app.models.frame import Frame, apply_device_frame_json, device_frame_json_changes


@pytest.mark.asyncio
async def test_adoption_code_and_claim(async_client, no_auth_client, db, redis):
    response = await async_client.post('/api/frames/adoption_code')
    assert response.status_code == 200
    code = response.json()['code']
    assert code

    claim = await no_auth_client.post('/api/frame_device/adopt', json={
        'code': code,
        'name': 'Standalone hallway frame',
        'mode': 'rpios',
        'device': 'web_only',
        'width': 800,
        'height': 480,
        'framePort': 8787,
        'frameAccess': 'private',
        'frameosVersion': '2026.6.15',
    })
    assert claim.status_code == 200
    data = claim.json()
    assert data['serverApiKey']
    assert data['agentSharedSecret']

    frame = db.get(Frame, data['frameId'])
    assert frame is not None
    assert frame.name == 'Standalone hallway frame'
    assert frame.server_api_key == data['serverApiKey']
    assert frame.agent['agentEnabled'] is True
    assert frame.agent['agentRunCommands'] is True
    assert frame.agent['agentSharedSecret'] == data['agentSharedSecret']
    assert frame.version == '2026.6.15'

    # The code is single use.
    second = await no_auth_client.post('/api/frame_device/adopt', json={'code': code})
    assert second.status_code == 401


@pytest.mark.asyncio
async def test_adoption_with_bad_code(no_auth_client):
    response = await no_auth_client.post('/api/frame_device/adopt', json={'code': 'NOPE-NOPE'})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_request_update_requires_api_key(no_auth_client):
    response = await no_auth_client.post('/api/frame_device/request_update', json={'target': 'frameos'})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_request_update_queues_deploy(no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'UpdateFrame', 'localhost', 'localhost')
    frame.server_api_key = 'test-update-key'
    db.commit()

    with patch('app.tasks.deploy_frame', new=AsyncMock()) as deploy_frame_mock:
        response = await no_auth_client.post(
            '/api/frame_device/request_update',
            json={'target': 'frameos'},
            headers={'Authorization': 'Bearer test-update-key'},
        )
    assert response.status_code == 200
    assert response.json()['status'] == 'queued'
    deploy_frame_mock.assert_awaited_once()

    with patch('app.tasks.deploy_agent', new=AsyncMock()) as deploy_agent_mock:
        response = await no_auth_client.post(
            '/api/frame_device/request_update',
            json={'target': 'agent'},
            headers={'Authorization': 'Bearer test-update-key'},
        )
    assert response.status_code == 200
    deploy_agent_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_device_frame_json_changes_and_apply(db, redis):
    frame = await new_frame(db, redis, 'DriftFrame', 'localhost', 'localhost')
    frame.last_successful_deploy = frame.to_dict()
    db.commit()

    device_json = {
        'name': 'Renamed on device',
        'rotate': 90,
        'frameAdminAuth': {'enabled': True, 'user': 'admin', 'pass': 'hunter2'},
        'schedule': {'events': [{'id': 'e1', 'hour': 8, 'minute': 0, 'event': 'setCurrentScene', 'payload': {}}]},
        'metricsInterval': 120,
    }
    changes = device_frame_json_changes(frame, device_json)
    assert set(changes.keys()) == {'name', 'rotate', 'frame_admin_auth', 'schedule', 'metrics_interval'}

    changed = apply_device_frame_json(frame, device_json)
    assert changed == sorted(changes.keys())
    assert frame.name == 'Renamed on device'
    assert frame.rotate == 90
    assert frame.metrics_interval == 120
    assert frame.frame_admin_auth['user'] == 'admin'
    # The deployed snapshot follows so pulled changes don't show as undeployed.
    assert frame.last_successful_deploy['name'] == 'Renamed on device'

    # Pulling the same config again is a no-op.
    assert device_frame_json_changes(frame, device_json) == {}


@pytest.mark.asyncio
async def test_pull_config_endpoint(async_client, db, redis):
    frame = await new_frame(db, redis, 'PullFrame', 'localhost', 'localhost')
    device_json = json.dumps({'name': 'Edited on device', 'rotate': 180})

    with patch('app.api.frames.run_command', new=AsyncMock(return_value=(0, device_json, ''))):
        drift = await async_client.get(f'/api/frames/{frame.id}/config_drift')
        assert drift.status_code == 200
        assert set(drift.json()['fields']) == {'name', 'rotate'}

        response = await async_client.post(f'/api/frames/{frame.id}/pull_config')
        assert response.status_code == 200
        assert set(response.json()['fields']) == {'name', 'rotate'}

    db.refresh(frame)
    assert frame.name == 'Edited on device'
    assert frame.rotate == 180

    with patch('app.api.frames.run_command', new=AsyncMock(return_value=(0, device_json, ''))):
        drift = await async_client.get(f'/api/frames/{frame.id}/config_drift')
        assert drift.json()['fields'] == []


@pytest.mark.asyncio
async def test_pull_config_includes_device_edited_scenes(async_client, db, redis):
    frame = await new_frame(db, redis, 'SceneDriftFrame', 'localhost', 'localhost')
    frame.last_successful_deploy = frame.to_dict()
    db.commit()

    device_scenes = [{'id': 'scene-1', 'name': 'Edited on device', 'nodes': [], 'edges': [],
                      'settings': {'execution': 'interpreted'}}]

    async def fake_run_command(db_, redis_, frame_, command, **kwargs):
        if 'all_scenes' in command:
            return (0, json.dumps(device_scenes), '')
        return (0, json.dumps({'name': frame.name}), '')

    with patch('app.api.frames.run_command', new=AsyncMock(side_effect=fake_run_command)):
        drift = await async_client.get(f'/api/frames/{frame.id}/config_drift')
        assert drift.status_code == 200
        assert drift.json()['fields'] == ['scenes']

        response = await async_client.post(f'/api/frames/{frame.id}/pull_config')
        assert response.status_code == 200
        assert response.json()['fields'] == ['scenes']

    db.refresh(frame)
    assert frame.scenes == device_scenes
    # Pulled scenes count as deployed: the device is already running them.
    assert frame.last_successful_deploy['scenes'] == device_scenes

    with patch('app.api.frames.run_command', new=AsyncMock(side_effect=fake_run_command)):
        drift = await async_client.get(f'/api/frames/{frame.id}/config_drift')
        assert drift.json()['fields'] == []
