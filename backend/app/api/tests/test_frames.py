import json
import pytest
from unittest import mock
from app.models import new_frame, new_log, Frame
from app.redis import redis

@pytest.fixture
async def frame(db_session):
    f = await new_frame(db_session, 'Frame', 'localhost', 'localhost')
    return f

class MockResponse:
    def __init__(self, status_code, content=None):
        self.status_code = status_code
        self.content = content

    def json(self):
        return json.loads(self.content) if self.content else {}

@pytest.mark.asyncio
async def test_api_frames(async_client, db_session, frame):
    response = await async_client.get('/api/frames')
    data = response.json()
    assert response.status_code == 200
    assert data == {"frames": [frame.to_dict()]}

@pytest.mark.asyncio
async def test_api_frame_get_found(async_client, db_session, frame):
    response = await async_client.get(f'/api/frames/{frame.id}')
    data = response.json()
    assert response.status_code == 200
    assert data == {"frame": frame.to_dict()}

@pytest.mark.asyncio
async def test_api_frame_get_not_found(async_client):
    response = await async_client.get('/api/frames/99999999')
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_api_frame_get_logs(async_client, db_session, frame):
    log1 = await new_log(db_session, frame.id, 'logtype', "Test log 1")
    log2 = await new_log(db_session, frame.id, 'logtype', "Test log 2")
    response = await async_client.get(f'/api/frames/{frame.id}/logs')
    data = response.json()
    assert response.status_code == 200
    # Filter out 'welcome' logs
    filtered_logs = [ll for ll in data['logs'] if ll['type'] != 'welcome']
    assert filtered_logs == [log1.to_dict(), log2.to_dict()]

@pytest.mark.asyncio
async def test_api_frame_get_logs_limit(async_client, db_session, frame):
    for i in range(0, 1010):
        await new_log(db_session, frame.id, 'logtype', "Test log 2")
    response = await async_client.get(f'/api/frames/{frame.id}/logs')
    data = response.json()
    assert response.status_code == 200
    assert len(data['logs']) == 1000

@pytest.mark.asyncio
async def test_api_frame_get_image_cached(async_client, frame):
    await redis.set(f'frame:{frame.frame_host}:{frame.frame_port}:image', b'cached_image_data')
    response = await async_client.get(f'/api/frames/{frame.id}/image?t=-1')
    assert response.status_code == 200
    assert response.content == b'cached_image_data'

@pytest.mark.asyncio
async def test_api_frame_get_image_no_cache(async_client, frame):
    await redis.delete(f'frame:{frame.frame_host}:{frame.frame_port}:image')
    with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
        response = await async_client.get(f'/api/frames/{frame.id}/image')
        assert response.status_code == 200
        assert response.content == b'image_data'
        cached_image = await redis.get(f'frame:{frame.frame_host}:{frame.frame_port}:image')
        assert cached_image == b'image_data'

@pytest.mark.asyncio
async def test_api_frame_get_image_cache_missing(async_client, frame):
    await redis.delete(f'frame:{frame.frame_host}:{frame.frame_port}:image')
    with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=-1')
        assert response.status_code == 200
        assert response.content == b'image_data'
        cached_image = await redis.get(f'frame:{frame.frame_host}:{frame.frame_port}:image')
        assert cached_image == b'image_data'

@pytest.mark.asyncio
async def test_api_frame_get_image_cache_ignore(async_client, frame):
    await redis.set(f'frame:{frame.frame_host}:{frame.frame_port}:image', b'cached_image_data')
    with mock.patch('requests.get', return_value=MockResponse(status_code=200, content=b'image_data')):
        response = await async_client.get(f'/api/frames/{frame.id}/image')
        assert response.status_code == 200
        assert response.content == b'image_data'
        cached_image = await redis.get(f'frame:{frame.frame_host}:{frame.frame_port}:image')
        assert cached_image == b'image_data'

@pytest.mark.asyncio
async def test_api_frame_get_image_external_service_error(async_client, db_session, frame):
    # Update frame host to something invalid
    await async_client.post(f'/api/frames/{frame.id}', json={'name': "NoName", "frame_host": "999.999.999.999"})
    with mock.patch('requests.get', return_value=MockResponse(status_code=500)):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=-1')
        assert response.status_code == 500
        assert response.json() == {"error": "Unable to fetch image"}

@pytest.mark.asyncio
async def test_api_frame_render_event_success(async_client, frame):
    with mock.patch('requests.post', return_value=MockResponse(status_code=200)):
        response = await async_client.post(f'/api/frames/{frame.id}/event/render')
        assert response.status_code == 200

@pytest.mark.asyncio
async def test_api_frame_render_event_failure(async_client, frame):
    with mock.patch('requests.post', return_value=MockResponse(status_code=500)):
        response = await async_client.post(f'/api/frames/{frame.id}/event/render')
        assert response.status_code == 500

@pytest.mark.asyncio
async def test_api_frame_reset_event(async_client, frame):
    with mock.patch('app.tasks.reset_frame', return_value=True):
        response = await async_client.post(f'/api/frames/{frame.id}/reset')
        assert response.status_code == 200
        assert response.content == b'Success'

@pytest.mark.asyncio
async def test_api_frame_restart_event(async_client, frame):
    with mock.patch('app.tasks.restart_frame', return_value=True):
        response = await async_client.post(f'/api/frames/{frame.id}/restart')
        assert response.status_code == 200
        assert response.content == b'Success'

@pytest.mark.asyncio
async def test_api_frame_deploy_event(async_client, frame):
    with mock.patch('app.tasks.deploy_frame', return_value=True):
        response = await async_client.post(f'/api/frames/{frame.id}/deploy')
        assert response.status_code == 200
        assert response.content == b'Success'

@pytest.mark.asyncio
async def test_api_frame_update_name(async_client, db_session, frame):
    response = await async_client.post(f'/api/frames/{frame.id}', json={'name': 'Updated Name'})
    assert response.status_code == 200
    updated_frame = db_session.query(Frame).get(frame.id)
    assert updated_frame.name == 'Updated Name'

@pytest.mark.asyncio
async def test_api_frame_update_a_lot(async_client, db_session, frame):
    response = await async_client.post(f'/api/frames/{frame.id}', json={
        'name': 'Updated Name',
        'frame_host': 'penguin',
        'ssh_user': 'tux',
        'ssh_pass': 'herring',
        'ssh_port': '2222',
        'server_host': 'walrus',
        'server_port': '89898',
        'device': 'framebuffer',
        'scaling_mode': 'contain',
        'rotate': '90',
        'scenes': json.dumps([{"sceneName": "Scene1"}, {"sceneName": "Scene2"}]),
    })
    assert response.status_code == 200
    updated_frame = db_session.query(Frame).get(frame.id)
    assert updated_frame.name == 'Updated Name'
    assert updated_frame.frame_host == 'penguin'
    assert updated_frame.ssh_user == 'tux'
    assert updated_frame.ssh_pass == 'herring'
    assert updated_frame.ssh_port == 2222
    assert updated_frame.server_host == 'walrus'
    assert updated_frame.server_port == 89898
    assert updated_frame.device == 'framebuffer'
    assert updated_frame.scaling_mode == 'contain'
    assert updated_frame.rotate == 90
    assert updated_frame.scenes == [{"sceneName": "Scene1"}, {"sceneName": "Scene2"}]

@pytest.mark.asyncio
async def test_api_frame_update_scenes_json_format(async_client, db_session):
    frame = await new_frame(db_session, 'Frame', 'localhost', 'localhost')

    valid_scenes_json = json.dumps([{"sceneName": "Scene1"}, {"sceneName": "Scene2"}])
    response = await async_client.post(f'/api/frames/{frame.id}', json={'scenes': valid_scenes_json})
    assert response.status_code == 200
    updated_frame = db_session.query(Frame).get(frame.id)
    assert updated_frame.scenes == json.loads(valid_scenes_json)

    invalid_scenes_json = "Not a valid JSON"
    response = await async_client.post(f'/api/frames/{frame.id}', json={'scenes': invalid_scenes_json})
    assert response.status_code == 400
    error_data = response.json()
    assert 'error' in error_data
    assert 'Invalid input' in error_data['message']

@pytest.mark.asyncio
async def test_api_frame_update_invalid_data(async_client, frame):
    response = await async_client.post(f'/api/frames/{frame.id}', json={'width': 'invalid'})
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_api_frame_update_next_action_restart(async_client, frame):
    with mock.patch('app.tasks.restart_frame') as mock_restart:
        response = await async_client.post(f'/api/frames/{frame.id}', json={'next_action': 'restart'})
        mock_restart.assert_called_once_with(frame.id)
        assert response.status_code == 200

@pytest.mark.asyncio
async def test_api_frame_update_next_action_deploy(async_client, frame):
    with mock.patch('app.tasks.deploy_frame') as mock_deploy:
        response = await async_client.post(f'/api/frames/{frame.id}', json={'next_action': 'deploy'})
        mock_deploy.assert_called_once_with(frame.id)
        assert response.status_code == 200

@pytest.mark.asyncio
async def test_api_frame_new(async_client):
    response = await async_client.post('/api/frames/new', json={'name': 'Frame', 'frame_host': 'localhost', 'server_host': 'localhost'})
    data = response.json()
    assert response.status_code == 200
    assert data['frame']['name'] == 'Frame'
    assert data['frame']['frame_host'] == 'localhost'
    assert data['frame']['frame_port'] == 8787
    assert data['frame']['ssh_port'] == 22
    assert data['frame']['server_host'] == 'localhost'
    assert data['frame']['server_port'] == 8989
    assert data['frame']['device'] == 'web_only'

@pytest.mark.asyncio
async def test_api_frame_new_parsed(async_client):
    response = await async_client.post('/api/frames/new', json={'name': 'Frame', 'frame_host': 'user:pass@localhost', 'server_host': 'localhost', 'device': 'framebuffer'})
    data = response.json()
    assert response.status_code == 200
    assert data['frame']['name'] == 'Frame'
    assert data['frame']['frame_host'] == 'localhost'
    assert data['frame']['frame_port'] == 8787
    assert data['frame']['ssh_port'] == 22
    assert data['frame']['ssh_user'] == 'user'
    assert data['frame']['ssh_pass'] == 'pass'
    assert data['frame']['server_host'] == 'localhost'
    assert data['frame']['server_port'] == 8989
    assert data['frame']['device'] == 'framebuffer'

@pytest.mark.asyncio
async def test_api_frame_delete(async_client, db_session, frame):
    async def api_length():
        resp = await async_client.get('/api/frames')
        d = resp.json()
        return len(d['frames'])

    assert await api_length() == 1
    f2 = await new_frame(db_session, 'Frame', 'localhost', 'localhost')
    assert await api_length() == 2
    response = await async_client.delete(f'/api/frames/{f2.id}')
    data = response.json()
    assert response.status_code == 200
    assert data['message'] == 'Frame deleted successfully'
    assert await api_length() == 1

@pytest.mark.asyncio
async def test_api_frame_delete_not_found(async_client):
    response = await async_client.delete('/api/frames/99999999')
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_unauthorized_access(async_client):
    # Assuming async_client is logged in, we need to simulate logout if implemented
    # If not implemented, we can consider adding a logout endpoint or mocking the auth
    # For now, assume no auth means all protected endpoints return 401
    # You may need a new client fixture without login to test unauthorized access
    # Example:
    from httpx import AsyncClient
    from httpx._transports.asgi import ASGITransport
    from app.fastapi import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as no_auth_client:
        endpoints = [
            ('/api/frames', 'GET'),
            ('/api/frames/1', 'GET'),
            ('/api/frames/1/logs', 'GET'),
            ('/api/frames/1/image', 'GET'),
            ('/api/frames/1/event/render', 'POST'),
            ('/api/frames/1/reset', 'POST'),
            ('/api/frames/1/restart', 'POST'),
            ('/api/frames/1/deploy', 'POST'),
            ('/api/frames/1', 'POST'),
            ('/api/frames/new', 'POST'),
            ('/api/frames/1', 'DELETE')
        ]
        for endpoint, method in endpoints:
            response = await no_auth_client.request(method, endpoint)
            assert response.status_code == 401, (endpoint, method, response.status_code)

@pytest.mark.asyncio
async def test_frame_update_invalid_json_scenes(async_client, frame):
    response = await async_client.post(f'/api/frames/{frame.id}', json={'scenes': 'invalid json'})
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_frame_update_incorrect_data_types(async_client, frame):
    response = await async_client.post(f'/api/frames/{frame.id}', json={'width': 'non-integer'})
    assert response.status_code == 400
    response = await async_client.post(f'/api/frames/{frame.id}', json={'interval': 'non-float'})
    assert response.status_code == 400

@pytest.mark.asyncio
async def test_frame_deploy_reset_restart_failure(async_client, frame):
    with mock.patch('app.tasks.deploy_frame', side_effect=Exception("Deploy error")):
        response = await async_client.post(f'/api/frames/{frame.id}/deploy')
        assert response.status_code == 500
    with mock.patch('app.tasks.reset_frame', side_effect=Exception("Reset error")):
        response = await async_client.post(f'/api/frames/{frame.id}/reset')
        assert response.status_code == 500
    with mock.patch('app.tasks.restart_frame', side_effect=Exception("Restart error")):
        response = await async_client.post(f'/api/frames/{frame.id}/restart')
        assert response.status_code == 500

@pytest.mark.asyncio
async def test_frame_creation_missing_required_fields(async_client):
    response = await async_client.post('/api/frames/new', json={'name': 'Frame'})
    assert response.status_code == 500
