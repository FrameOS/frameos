import json
from urllib.parse import parse_qs, urlsplit
import pytest
from unittest.mock import AsyncMock, patch
import httpx

from app.models import new_frame
from app.models.frame import Frame
from app.models.user import User

@pytest.mark.asyncio
async def test_api_frames(async_client, db, redis):
    # Create a frame:
    await new_frame(db, redis, 'TestFrame', 'localhost', 'localhost')

    # GET /api/frames
    response = await async_client.get('/api/frames')
    assert response.status_code == 200
    data = response.json()
    assert 'frames' in data
    assert len(data['frames']) == 1
    assert data['frames'][0]['name'] == 'TestFrame'

@pytest.mark.asyncio
async def test_api_frame_get_found(async_client, db, redis):
    frame = await new_frame(db, redis, 'FoundFrame', 'localhost', 'localhost')
    response = await async_client.get(f'/api/frames/{frame.id}')
    assert response.status_code == 200
    data = response.json()
    assert 'frame' in data
    assert data['frame']['name'] == 'FoundFrame'

@pytest.mark.asyncio
async def test_api_frame_get_not_found(async_client):
    # Large ID that doesn't exist
    response = await async_client.get('/api/frames/999999')
    assert response.status_code == 404
    assert response.json()['detail'] == 'Frame not found'


@pytest.mark.asyncio
async def test_api_frame_get_image_cached(async_client, db, redis):
    # Create the frame
    frame = await new_frame(db, redis, 'CachedImageFrame', 'localhost', 'localhost')
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    await redis.set(cache_key, b'cached_image_data')

    # First, get the image link (which gives us the token)
    image_token_resp = await async_client.get(f'/api/frames/{frame.id}/image_token')
    assert image_token_resp.status_code == 200
    link_info = image_token_resp.json()
    token = link_info['token']
    image_url = f'/api/frames/{frame.id}/image?token={token}'

    # Append t=-1 to force returning the cached data
    image_url += "&t=-1"
    response = await async_client.get(image_url)
    assert response.status_code == 200
    assert response.content == b'cached_image_data'

@pytest.mark.asyncio
async def test_api_frame_event_render(async_client, db, redis):
    """
    Patch post to return 200. The route then returns "OK", which we check via response.text.
    """
    frame = await new_frame(db, redis, 'RenderFrame', 'example.com', 'localhost')

    class MockResponse:
        status_code = 200
        def json(self):
            return {}
        @property
        def text(self):
            return 'OK'

    async def mock_httpx_post(url, **kwargs):
        return MockResponse()

    with patch.object(httpx.AsyncClient, 'post', side_effect=mock_httpx_post):
        response = await async_client.post(f'/api/frames/{frame.id}/event/render')
        assert response.status_code == 200
        assert response.text == 'OK'


@pytest.mark.asyncio
async def test_api_frame_reset_event(async_client, db, redis):
    frame = await new_frame(db, redis, 'ResetFrame', 'example.com', 'localhost')
    response = await async_client.post(f'/api/frames/{frame.id}/reset')
    assert response.status_code == 200
    assert response.text == '"Success"'


@pytest.mark.asyncio
async def test_api_frame_not_found_for_reset(async_client):
    """
    Currently the route does NOT check if the frame exists.
    So it always returns 200 "Success".
    """
    response = await async_client.post('/api/frames/999999/reset')
    assert response.status_code == 200
    assert response.text == '"Success"'


@pytest.mark.asyncio
async def test_api_frame_update_name(async_client, db, redis):
    frame = await new_frame(db, redis, 'InitialName', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"name": "Updated Name"})
    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.name == "Updated Name"


@pytest.mark.asyncio
async def test_api_frame_update_scenes_json_format(async_client, db, redis):
    frame = await new_frame(db, redis, 'SceneTest', 'localhost', 'localhost')
    resp = await async_client.post(
        f'/api/frames/{frame.id}',
        json={"scenes": [{"sceneName":"Scene1"},{"sceneName":"Scene2"}]}
    )
    assert resp.status_code == 200
    db.expire_all()
    updated = db.get(Frame, frame.id)
    assert updated.scenes == [{"sceneName": "Scene1"}, {"sceneName": "Scene2"}]


@pytest.mark.asyncio
async def test_api_frame_update_scenes_invalid(async_client, db, redis):
    frame = await new_frame(db, redis, 'SceneTest2', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"scenes": "not valid JSON"})
    assert resp.status_code == 422
    assert "Input should be a valid list" in json.dumps(resp.json()['detail'])


@pytest.mark.asyncio
async def test_api_frame_new(async_client):
    # Valid creation
    payload = {
        "name": "NewFrame",
        "frame_host": "myhost",
        "server_host": "myserver"
    }
    response = await async_client.post('/api/frames/new', json=payload)
    assert response.status_code == 200
    data = response.json()
    assert 'frame' in data
    assert data['frame']['name'] == "NewFrame"
    assert data['frame']['enable_tls'] is True
    assert data['frame']['expose_only_tls_port'] is True
    assert 'BEGIN CERTIFICATE' in data['frame']['tls_server_cert']
    assert 'BEGIN RSA PRIVATE KEY' in data['frame']['tls_server_key']
    assert 'BEGIN CERTIFICATE' in data['frame']['tls_client_ca_cert']


@pytest.mark.asyncio
async def test_api_frame_new_missing_fields(async_client):
    # Missing frame_host
    payload = {
        "name": "BadFrame"
    }
    response = await async_client.post('/api/frames/new', json=payload)
    assert response.status_code == 422
    assert "Field required" in json.dumps(response.json()['detail'])


@pytest.mark.asyncio
async def test_api_frame_import(async_client, db, redis):
    payload = {
        "name": "ImportedFrame",
        "frame_host": "importhost",
        "server_host": "importserver"
    }
    resp = await async_client.post('/api/frames/import', json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data['frame']['name'] == "ImportedFrame"


@pytest.mark.asyncio
async def test_api_frame_delete(async_client, db, redis):
    frame = await new_frame(db, redis, 'DeleteMe', 'localhost', 'localhost')
    resp = await async_client.delete(f'/api/frames/{frame.id}')
    assert resp.status_code == 200
    assert resp.json()['message'] == "Frame deleted successfully"


@pytest.mark.asyncio
async def test_api_frame_delete_not_found(async_client):
    resp = await async_client.delete('/api/frames/999999')
    assert resp.status_code == 404
    assert resp.json()['detail'] == 'Frame not found'

@pytest.mark.asyncio
async def test_api_frame_proxy_get_forwards_query_and_headers(async_client, db, redis):
    frame = await new_frame(db, redis, 'ProxyFrameGet', 'localhost', 'localhost')

    request_captured = {}

    async def mock_request(method, url, **kwargs):
        request_captured['method'] = method
        request_captured['url'] = url
        request_captured['headers'] = kwargs.get('headers') or {}

        return httpx.Response(
            200,
            content=b'proxy-ok',
            headers={'content-type': 'text/plain', 'x-frame-proxy': 'yes'},
        )

    with patch('app.api.frames.httpx.AsyncClient') as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.request.side_effect = mock_request
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client_cls.return_value.__aexit__.return_value = False
        response = await async_client.get(
            f'/api/frames/{frame.id}/proxy/state?foo=bar',
            headers={'X-Test-Header': 'value'},
        )

    assert response.status_code == 200
    assert response.content == b'proxy-ok'
    assert response.headers['x-frame-proxy'] == 'yes'
    assert request_captured['method'] == 'GET'
    parsed_url = urlsplit(request_captured['url'])
    query = parse_qs(parsed_url.query)
    assert parsed_url.scheme == 'https'
    assert parsed_url.netloc == f'localhost:{frame.tls_port}'
    assert parsed_url.path == '/state'
    assert query.get('foo') == ['bar']
    assert query.get('k') == [frame.frame_access_key]
    assert request_captured['headers'].get('X-Test-Header') == 'value'


@pytest.mark.asyncio
async def test_api_frame_proxy_post_forwards_body(async_client, db, redis):
    frame = await new_frame(db, redis, 'ProxyFramePost', 'localhost', 'localhost')

    request_captured = {}

    async def mock_request(method, url, **kwargs):
        request_captured['method'] = method
        request_captured['url'] = url
        request_captured['content'] = kwargs.get('content')
        return httpx.Response(
            201,
            content=b'{"created":true}',
            headers={'content-type': 'application/json'},
        )

    with patch('app.api.frames.httpx.AsyncClient') as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.request.side_effect = mock_request
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client_cls.return_value.__aexit__.return_value = False
        response = await async_client.post(
            f'/api/frames/{frame.id}/proxy/upload',
            content=b'binary-body',
            headers={'Content-Type': 'application/octet-stream'},
        )

    assert response.status_code == 201
    assert response.content == b'{"created":true}'
    assert request_captured['method'] == 'POST'
    assert request_captured['url'] == f'https://localhost:{frame.tls_port}/upload'
    assert request_captured['content'] == b'binary-body'

@pytest.mark.asyncio
async def test_api_frame_get_image_with_cookie_no_token(no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'CookieImageFrame', 'localhost', 'localhost')
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    await redis.set(cache_key, b'cookie_cached_image_data')

    user = User(email='cookieframe@example.com')
    user.set_password('testpassword')
    db.add(user)
    db.commit()

    login_resp = await no_auth_client.post('/api/login', data={'username': 'cookieframe@example.com', 'password': 'testpassword'})
    assert login_resp.status_code == 200

    response = await no_auth_client.get(f'/api/frames/{frame.id}/image?t=-1')
    assert response.status_code == 200
    assert response.content == b'cookie_cached_image_data'
