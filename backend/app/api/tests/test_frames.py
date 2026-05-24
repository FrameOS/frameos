import asyncio
import json
import pytest
import time
from unittest.mock import AsyncMock, patch
import httpx
from datetime import datetime, timedelta, timezone

from app.api import frames as frames_api
from app.api.auth import get_current_user
from app.fastapi import app
from app.models import new_frame
from app.models.frame import Frame
from app.models.log import Log
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
async def test_api_frame_uses_latest_activity_log_timestamp(async_client, db, redis):
    frame = await new_frame(db, redis, 'LatestLogFrame', 'localhost', 'localhost')
    frame.last_log_at = datetime(2026, 1, 1, 0, 0, 0)
    latest_timestamp = datetime(2026, 6, 1, 12, 0, 0)
    ignored_timestamp = datetime(2026, 6, 1, 12, 5, 0)
    db.add(
        Log(
            frame_id=frame.id,
            type='webhook',
            line='{"event":"metrics"}',
            timestamp=latest_timestamp,
        )
    )
    db.add(
        Log(
            frame_id=frame.id,
            type='info',
            line=f'Error fetching image from frame {frame.id}: 502: All connection attempts failed',
            timestamp=ignored_timestamp,
        )
    )
    db.add(
        Log(
            frame_id=frame.id,
            type='stdinfo',
            line='Connecting via SSH to pi@10.8.0.62 (keypair: Default)',
            timestamp=datetime(2026, 6, 1, 12, 6, 0),
        )
    )
    db.add(
        Log(
            frame_id=frame.id,
            type='stderr',
            line="Unable to connect to 10.8.0.62:22 via SSH: [Errno 51] Connect call failed ('10.8.0.62', 22)",
            timestamp=datetime(2026, 6, 1, 12, 7, 0),
        )
    )
    db.commit()

    detail_response = await async_client.get(f'/api/frames/{frame.id}')
    list_response = await async_client.get('/api/frames')

    expected_timestamp = latest_timestamp.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    assert detail_response.json()['frame']['last_log_at'] == expected_timestamp
    latest_frame = next(item for item in list_response.json()['frames'] if item['id'] == frame.id)
    assert latest_frame['last_log_at'] == expected_timestamp


@pytest.mark.asyncio
async def test_api_frame_clears_last_log_at_without_frame_activity_logs(async_client, db, redis):
    frame = await new_frame(db, redis, 'NoActivityFrame', 'localhost', 'localhost')
    frame.last_log_at = datetime(2026, 1, 1, 0, 0, 0)
    db.add(
        Log(
            frame_id=frame.id,
            type='stdinfo',
            line='Connecting via SSH to pi@10.8.0.62 (keypair: Default)',
            timestamp=datetime(2026, 6, 1, 12, 0, 0),
        )
    )
    db.commit()

    detail_response = await async_client.get(f'/api/frames/{frame.id}')
    list_response = await async_client.get('/api/frames')

    assert detail_response.json()['frame']['last_log_at'] is None
    latest_frame = next(item for item in list_response.json()['frames'] if item['id'] == frame.id)
    assert latest_frame['last_log_at'] is None


@pytest.mark.asyncio
async def test_api_frame_get_not_found(async_client):
    # Large ID that doesn't exist
    response = await async_client.get('/api/frames/999999')
    assert response.status_code == 404
    assert response.json()['detail'] == 'Frame not found'


@pytest.mark.asyncio
async def test_api_frame_logs_full_download_includes_all_persisted_logs(no_auth_client, db):
    frame = Frame(
        name="LogFrame",
        mode="rpios",
        frame_host="localhost",
        frame_port=8787,
        frame_access_key="key",
        frame_access="private",
        ssh_user="pi",
        ssh_port=22,
        server_host="localhost",
        server_port=8989,
        server_api_key="server-key",
        server_send_logs=True,
        status="uninitialized",
        interval=300,
        metrics_interval=60,
        scenes=[],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        assets_path="/srv/assets",
        save_assets=True,
        upload_fonts="",
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    base_timestamp = datetime(2026, 5, 8, 8, 0, 0)
    db.add_all(
        Log(
            frame_id=frame.id,
            type='stdout',
            line=f'line {index}',
            timestamp=base_timestamp + timedelta(seconds=index),
        )
        for index in range(1002)
    )
    db.commit()

    app.dependency_overrides[get_current_user] = lambda: object()
    try:
        capped_response = await no_auth_client.get(f'/api/frames/{frame.id}/logs')
        assert capped_response.status_code == 200
        capped_logs = capped_response.json()['logs']
        assert len(capped_logs) == 1000
        assert capped_logs[0]['line'] == 'line 2'
        assert capped_logs[-1]['line'] == 'line 1001'

        full_response = await no_auth_client.get(f'/api/frames/{frame.id}/logs/full')
        assert full_response.status_code == 200
        assert full_response.headers['content-type'].startswith('text/plain')
        assert 'attachment;' in full_response.headers['content-disposition']
        assert f'frame-{frame.id}-full-logs-' in full_response.headers['content-disposition']
        full_lines = full_response.text.splitlines()
        assert len(full_lines) == 1002
        assert full_lines[0].endswith('(stdout) line 0')
        assert full_lines[-1].endswith('(stdout) line 1001')
    finally:
        app.dependency_overrides.clear()

@pytest.mark.asyncio
async def test_api_frame_get_image_cached(async_client, db, redis):
    # Create the frame
    frame = await new_frame(db, redis, 'CachedImageFrame', 'localhost', 'localhost')
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    await redis.set(cache_key, b'cached_image_data')

    image_url = f'/api/frames/{frame.id}/image?t=-1'
    response = await async_client.get(image_url)
    assert response.status_code == 200
    assert response.content == b'cached_image_data'


@pytest.mark.asyncio
async def test_api_frame_assets_returns_fresh_cache_without_reloading(async_client, db, redis):
    frame = await new_frame(db, redis, 'CachedAssetsFrame', 'localhost', 'localhost')
    assets_path = frame.assets_path or "/srv/assets"
    cache_key = frames_api._frame_assets_cache_key(frame.id, assets_path)
    lock_key = frames_api._frame_assets_cache_lock_key(frame.id, assets_path)
    cached_assets = [
        {"path": "/srv/assets/photo.png", "size": 123, "mtime": 1000, "is_dir": False},
    ]
    await redis.delete(cache_key, lock_key)
    await frames_api._write_frame_assets_cache(redis, cache_key, cached_assets, fetched_at=time.time())

    with patch("app.api.frames._load_frame_assets", new=AsyncMock()) as load_assets:
        response = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert response.status_code == 200
    payload = response.json()
    assert payload["assets"] == cached_assets
    assert payload["cache"]["cached"] is True
    assert payload["cache"]["refreshing"] is False
    load_assets.assert_not_awaited()


@pytest.mark.asyncio
async def test_api_frame_assets_refresh_bypasses_cache(async_client, db, redis):
    frame = await new_frame(db, redis, 'RefreshAssetsFrame', 'localhost', 'localhost')
    assets_path = frame.assets_path or "/srv/assets"
    cache_key = frames_api._frame_assets_cache_key(frame.id, assets_path)
    lock_key = frames_api._frame_assets_cache_lock_key(frame.id, assets_path)
    cached_assets = [
        {"path": "/srv/assets/old.png", "size": 123, "mtime": 1000, "is_dir": False},
    ]
    fresh_assets = [
        {"path": "/srv/assets/fresh.png", "size": 456, "mtime": 2000, "is_dir": False},
    ]
    await redis.delete(cache_key, lock_key)
    await frames_api._write_frame_assets_cache(redis, cache_key, cached_assets, fetched_at=time.time())

    with patch("app.api.frames._load_frame_assets", new=AsyncMock(return_value=fresh_assets)) as load_assets:
        response = await async_client.get(f'/api/frames/{frame.id}/assets?refresh=1')

    assert response.status_code == 200
    payload = response.json()
    assert payload["assets"] == fresh_assets
    assert payload["cache"]["cached"] is False
    load_assets.assert_awaited_once()


@pytest.mark.asyncio
async def test_api_frame_assets_returns_stale_cache_and_refreshes(async_client, db, redis):
    frame = await new_frame(db, redis, 'StaleAssetsFrame', 'localhost', 'localhost')
    assets_path = frame.assets_path or "/srv/assets"
    cache_key = frames_api._frame_assets_cache_key(frame.id, assets_path)
    lock_key = frames_api._frame_assets_cache_lock_key(frame.id, assets_path)
    cached_assets = [
        {"path": "/srv/assets/old.png", "size": 123, "mtime": 1000, "is_dir": False},
    ]
    fresh_assets = [
        {"path": "/srv/assets/new.png", "size": 456, "mtime": 2000, "is_dir": False},
    ]
    await redis.delete(cache_key, lock_key)
    await frames_api._write_frame_assets_cache(
        redis,
        cache_key,
        cached_assets,
        fetched_at=time.time() - frames_api.FRAME_ASSETS_CACHE_REFRESH_AFTER_SECONDS - 1,
    )

    with patch("app.api.frames._load_frame_assets", new=AsyncMock(return_value=fresh_assets)) as load_assets:
        response = await async_client.get(f'/api/frames/{frame.id}/assets')

    assert response.status_code == 200
    payload = response.json()
    assert payload["assets"] == cached_assets
    assert payload["cache"]["cached"] is True
    assert payload["cache"]["refreshing"] is True

    for _ in range(10):
        refreshed = await frames_api._read_frame_assets_cache(redis, cache_key)
        if refreshed and refreshed["assets"] == fresh_assets:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail("assets cache was not refreshed in the background")

    load_assets.assert_awaited_once()

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
async def test_api_frame_update_archived(async_client, db, redis):
    frame = await new_frame(db, redis, 'ArchiveMe', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"archived": True})
    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.archived is True

    frames_response = await async_client.get('/api/frames')
    assert frames_response.status_code == 200
    assert frames_response.json()['frames'][0]['archived'] is True


@pytest.mark.asyncio
async def test_api_frame_update_requires_admin_credentials_when_enabled(async_client, db, redis):
    frame = await new_frame(db, redis, 'AdminFrame', 'localhost', 'localhost')

    resp = await async_client.post(
        f'/api/frames/{frame.id}',
        json={
            'frame_admin_auth': {
                'enabled': True,
                'user': 'admin',
                'pass': '',
            }
        },
    )

    assert resp.status_code == 422
    assert 'Username and password are required when frame admin is enabled' in json.dumps(resp.json()['detail'])


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
    assert data['frame']['https_proxy']['enable'] is True
    assert data['frame']['https_proxy']['expose_only_port'] is True
    assert 'BEGIN CERTIFICATE' in data['frame']['https_proxy']['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in data['frame']['https_proxy']['certs']['server_key']
    assert 'BEGIN CERTIFICATE' in data['frame']['https_proxy']['certs']['client_ca']
    assert data['frame']['https_proxy']['server_cert_not_valid_after'] is not None
    assert data['frame']['https_proxy']['client_ca_cert_not_valid_after'] is not None


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


@pytest.mark.asyncio
async def test_api_frame_get_image_no_scene_id(async_client, db, redis):
    """When the frame returns a 200 image but no x-scene-id header and no
    cached active scene, the endpoint should still return the image without
    crashing (no NameError on `now`/`width`/`height`)."""
    frame = await new_frame(db, redis, 'NoSceneFrame', 'example.com', 'localhost')

    fake_png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 100

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        # Return 200 with image bytes but NO x-scene-id header
        return 200, fake_png, {}

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image')
    assert response.status_code == 200
    assert response.content == fake_png


@pytest.mark.asyncio
async def test_api_frame_generate_tls_material_includes_validity_dates(async_client, db, redis):
    frame = await new_frame(db, redis, 'TlsFrame', 'localhost', 'localhost')

    response = await async_client.post(f'/api/frames/{frame.id}/tls/generate')
    assert response.status_code == 200

    data = response.json()
    assert 'BEGIN CERTIFICATE' in data['certs']['server']
    assert 'BEGIN RSA PRIVATE KEY' in data['certs']['server_key']
    assert 'BEGIN CERTIFICATE' in data['certs']['client_ca']
    assert data['server_cert_not_valid_after'] is not None
    assert data['client_ca_cert_not_valid_after'] is not None
    assert data['server_cert_not_valid_after'].endswith('+00:00')
    assert data['client_ca_cert_not_valid_after'].endswith('+00:00')
