import asyncio
import gzip
import json
import pytest
import time
from unittest.mock import AsyncMock, patch
import httpx
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from app.api import frames as frames_api
from app.api.auth import get_current_user
from app.fastapi import app
from app.models import new_frame
from app.models.frame import Frame
from app.models.log import Log
from app.models.user import User
from app.tasks.buildroot_image import buildroot_sd_image_config_fingerprint
from app.codegen.drivers_nim import frame_compilation_mode


def set_buildroot_sd_image_config_fingerprint(frame: Frame) -> None:
    buildroot = dict(frame.buildroot or {})
    sd_image = dict(buildroot.get('sdImage') or {})
    sd_image['compilationMode'] = frame_compilation_mode(frame)
    sd_image['configFingerprint'] = buildroot_sd_image_config_fingerprint(frame)
    buildroot['sdImage'] = sd_image
    frame.buildroot = buildroot


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
async def test_api_frame_agent_bootstrap_command_enables_agent_and_returns_script(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')

    command_response = await async_client.post(f'/api/frames/{frame.id}/agent_bootstrap')

    assert command_response.status_code == 200
    command_payload = command_response.json()
    assert command_payload['script_url'].startswith(f'http://backend.local:8989/api/agent-bootstrap/{frame.id}/')
    assert command_payload['command'] == f"curl -fsSL {command_payload['script_url']} | sudo sh"

    db.refresh(frame)
    assert frame.agent['agentEnabled'] is True
    assert frame.agent['agentRunCommands'] is True
    assert frame.agent['deployWithAgent'] is True

    script_path = urlparse(command_payload['script_url']).path
    script_response = await no_auth_client.get(script_path)

    assert script_response.status_code == 200
    assert script_response.headers['content-type'].startswith('text/x-shellscript')
    script = script_response.text
    assert 'frameos_agent' in script
    assert 'compile_frameos_agent' not in script
    assert 'sh compile' not in script

    config_json = script.split("<<'FRAMEOS_AGENT_CONFIG_JSON'\n", 1)[1].split(
        '\nFRAMEOS_AGENT_CONFIG_JSON',
        1,
    )[0]
    config = json.loads(config_json)
    assert config['serverHost'] == 'backend.local'
    assert config['serverApiKey'] == frame.server_api_key
    assert config['agent']['agentEnabled'] is True
    assert config['agent']['agentRunCommands'] is True
    assert config['agent']['agentSharedSecret'] == frame.agent['agentSharedSecret']

    bad_response = await no_auth_client.get(f'/api/agent-bootstrap/{frame.id}/not-the-token')
    assert bad_response.status_code == 404


@pytest.mark.asyncio
async def test_api_frame_agent_bootstrap_command_can_preserve_deploy_transport(async_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')
    frame.agent = {'deployWithAgent': False}
    db.add(frame)
    db.commit()

    response = await async_client.post(f'/api/frames/{frame.id}/agent_bootstrap?select_agent=0')

    assert response.status_code == 200
    db.refresh(frame)
    assert frame.agent['agentEnabled'] is True
    assert frame.agent['agentRunCommands'] is True
    assert frame.agent['deployWithAgent'] is False


@pytest.mark.asyncio
async def test_api_frame_agent_tasks_default_to_auto_transport(async_client, monkeypatch):
    import app.tasks as tasks_package

    captured: list[tuple[str, int, dict]] = []

    async def fake_deploy_agent(id, _redis, **kwargs):
        captured.append(("deploy", id, kwargs))

    async def fake_restart_agent(id, _redis, **kwargs):
        captured.append(("restart", id, kwargs))

    monkeypatch.setattr(tasks_package, "deploy_agent", fake_deploy_agent)
    monkeypatch.setattr(tasks_package, "restart_agent", fake_restart_agent)

    deploy_response = await async_client.post('/api/frames/123/deploy_agent?recompile=1')
    restart_response = await async_client.post('/api/frames/123/restart_agent')

    assert deploy_response.status_code == 200
    assert restart_response.status_code == 200
    assert captured == [
        ("deploy", 123, {"recompile": True, "transport": "auto"}),
        ("restart", 123, {"transport": "auto"}),
    ]


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
async def test_api_frame_states_returns_fresh_cache_without_reloading(async_client, db, redis):
    frame = await new_frame(db, redis, 'CachedStatesFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_states_cache_key(frame.id)
    lock_key = frames_api._frame_states_cache_lock_key(frame.id)
    cached_state = {"sceneId": "scene-1", "states": {"scene-1": {"temperature": 21}}}
    await redis.delete(cache_key, lock_key)
    await frames_api._write_frame_states_cache(redis, cache_key, cached_state, fetched_at=time.time())

    with patch("app.api.frames._load_frame_states", new=AsyncMock()) as load_states:
        response = await async_client.get(f'/api/frames/{frame.id}/states')

    assert response.status_code == 200
    payload = response.json()
    assert payload["sceneId"] == "scene-1"
    assert payload["states"] == cached_state["states"]
    assert payload["cache"]["cached"] is True
    assert payload["cache"]["refreshing"] is False
    load_states.assert_not_awaited()


@pytest.mark.asyncio
async def test_api_frame_states_returns_empty_shell_and_refreshes(async_client, db, redis):
    frame = await new_frame(db, redis, 'EmptyStatesFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_states_cache_key(frame.id)
    lock_key = frames_api._frame_states_cache_lock_key(frame.id)
    fresh_state = {"sceneId": "fresh-scene", "states": {"fresh-scene": {"count": 2}}}
    await redis.delete(cache_key, lock_key)
    await redis.set(f"frame:{frame.id}:active_scene", "last-scene")

    with patch("app.api.frames._load_frame_states", new=AsyncMock(return_value=fresh_state)) as load_states:
        response = await async_client.get(f'/api/frames/{frame.id}/states')

    assert response.status_code == 200
    payload = response.json()
    assert payload["sceneId"] == "last-scene"
    assert payload["states"] == {}
    assert payload["cache"]["cached"] is False
    assert payload["cache"]["refreshing"] is True

    for _ in range(10):
        refreshed = await frames_api._read_frame_states_cache(redis, cache_key)
        if refreshed and refreshed["states"] == fresh_state["states"]:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail("states cache was not refreshed in the background")

    load_states.assert_awaited_once()


@pytest.mark.asyncio
async def test_api_frame_states_response_does_not_wait_for_refresh(async_client, db, redis):
    frame = await new_frame(db, redis, 'SlowStatesFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_states_cache_key(frame.id)
    lock_key = frames_api._frame_states_cache_lock_key(frame.id)
    fresh_state = {"sceneId": "fresh-scene", "states": {"fresh-scene": {"count": 3}}}
    await redis.delete(cache_key, lock_key)
    await redis.set(f"frame:{frame.id}:active_scene", "last-scene")

    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_load_states(_redis, _frame):
        started.set()
        await release.wait()
        return fresh_state

    with patch("app.api.frames._load_frame_states", new=AsyncMock(side_effect=slow_load_states)) as load_states:
        response = await asyncio.wait_for(async_client.get(f'/api/frames/{frame.id}/states'), timeout=0.5)

        assert response.status_code == 200
        payload = response.json()
        assert payload["sceneId"] == "last-scene"
        assert payload["states"] == {}
        assert payload["cache"]["cached"] is False
        assert payload["cache"]["refreshing"] is True

        await asyncio.wait_for(started.wait(), timeout=0.5)
        load_states.assert_awaited_once()
        release.set()

        for _ in range(10):
            refreshed = await frames_api._read_frame_states_cache(redis, cache_key)
            if refreshed and refreshed["states"] == fresh_state["states"]:
                break
            await asyncio.sleep(0.05)
        else:
            pytest.fail("states cache was not refreshed after the response returned")


@pytest.mark.asyncio
async def test_api_frame_states_returns_stale_cache_and_refreshes(async_client, db, redis):
    frame = await new_frame(db, redis, 'StaleStatesFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_states_cache_key(frame.id)
    lock_key = frames_api._frame_states_cache_lock_key(frame.id)
    cached_state = {"sceneId": "old-scene", "states": {"old-scene": {"count": 1}}}
    fresh_state = {"sceneId": "new-scene", "states": {"new-scene": {"count": 2}}}
    await redis.delete(cache_key, lock_key)
    await frames_api._write_frame_states_cache(
        redis,
        cache_key,
        cached_state,
        fetched_at=time.time() - frames_api.FRAME_STATES_CACHE_REFRESH_AFTER_SECONDS - 1,
    )

    with patch("app.api.frames._load_frame_states", new=AsyncMock(return_value=fresh_state)) as load_states:
        response = await async_client.get(f'/api/frames/{frame.id}/states')

    assert response.status_code == 200
    payload = response.json()
    assert payload["sceneId"] == "old-scene"
    assert payload["states"] == cached_state["states"]
    assert payload["cache"]["cached"] is True
    assert payload["cache"]["refreshing"] is True

    for _ in range(10):
        refreshed = await frames_api._read_frame_states_cache(redis, cache_key)
        if refreshed and refreshed["states"] == fresh_state["states"]:
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail("states cache was not refreshed in the background")

    load_states.assert_awaited_once()


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
async def test_api_frame_new_buildroot_defaults(async_client):
    payload = {
        "mode": "buildroot",
        "name": "BuildrootFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "raspberry-pi-zero-2-w",
        "network": {"wifiSSID": "Test WiFi", "wifiPassword": "secret1234"},
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    frame = response.json()['frame']
    assert frame['mode'] == 'buildroot'
    assert frame['frame_host'] == f"frame{frame['id']}.local"
    assert frame['ssh_user'] == 'root'
    assert frame['assets_path'] == '/srv/assets'
    assert frame['https_proxy']['enable'] is False
    assert frame['buildroot']['platform'] == 'raspberry-pi-zero-2-w'
    assert frame['network']['wifiSSID'] == 'Test WiFi'
    assert frame['network']['wifiPassword'] == 'secret1234'
    assert frame['agent']['agentEnabled'] is True
    assert frame['agent']['agentRunCommands'] is True
    assert frame['agent']['deployWithAgent'] is True
    assert frame['agent']['agentSharedSecret']
    assert frame['network']['wifiHotspot'] == 'bootOnly'


@pytest.mark.asyncio
async def test_api_frame_new_buildroot_rejects_unsupported_platform(async_client):
    payload = {
        "mode": "buildroot",
        "name": "BuildrootFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "luckfox-pico",
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 400
    assert 'Unsupported Buildroot platform' in response.json()['detail']
    frames_response = await async_client.get('/api/frames')
    assert frames_response.json()['frames'] == []


@pytest.mark.asyncio
async def test_api_frame_new_buildroot_rejects_missing_wifi(async_client):
    payload = {
        "mode": "buildroot",
        "name": "BuildrootFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "raspberry-pi-zero-2-w",
        "network": {"wifiSSID": "", "wifiPassword": ""},
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 400
    assert 'WiFi network is required' in response.json()['detail']
    frames_response = await async_client.get('/api/frames')
    assert frames_response.json()['frames'] == []


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_enqueue(async_client, db, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    create_response = await async_client.post(
        '/api/frames/new',
        json={
            "mode": "buildroot",
            "name": "BuildrootFrame",
            "frame_host": "",
            "server_host": "backend.local",
            "platform": "raspberry-pi-zero-2-w",
            "network": {"wifiSSID": "Test WiFi", "wifiPassword": "secret1234"},
        },
    )
    frame_id = create_response.json()['frame']['id']
    captured: list[tuple[int, str | None, str | None]] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append((id, request_id, queue_job_id))

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame_id}/buildroot/sd_image')

    assert response.status_code == 200
    assert captured[0][0] == frame_id
    assert captured[0][1]
    assert captured[0][2] == f"buildroot_sd_image:{frame_id}:{captured[0][1]}"
    db.expire_all()
    frame = db.get(Frame, frame_id)
    assert frame.buildroot['platform'] == 'raspberry-pi-zero-2-w'
    assert frame.buildroot['sdImage']['status'] == 'queued'
    assert frame.buildroot['sdImage']['queueJobId'] == captured[0][2]
    assert frame.agent['agentEnabled'] is True
    assert frame.agent['agentRunCommands'] is True
    assert frame.agent['deployWithAgent'] is True


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_does_not_publish_previous_error(async_client, db, redis, monkeypatch):
    import app.api.frames as frames_api_module
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'error',
            'error': "name 'systemd_dir' is not defined",
        },
    }
    db.add(frame)
    db.commit()
    pre_start_update_frame_calls: list[str | None] = []

    async def fail_if_endpoint_publishes_before_start(_db, _redis, frame):
        pre_start_update_frame_calls.append((frame.buildroot or {}).get('sdImage', {}).get('status'))
        raise AssertionError('api_frame_buildroot_sd_image should not publish stale sdImage before queuing')

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        pass

    monkeypatch.setattr(frames_api_module, "update_frame", fail_if_endpoint_publishes_before_start)
    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['sdImage']['status'] == 'queued'
    assert pre_start_update_frame_calls == []
    db.expire_all()
    assert db.get(Frame, frame.id).buildroot['sdImage']['status'] == 'queued'


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_recovers_legacy_building_state(async_client, db, redis, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'building',
            'startedAt': datetime.now(timezone.utc).isoformat(),
        },
    }
    db.add(frame)
    db.commit()
    captured: list[tuple[int, str | None, str | None]] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append((id, request_id, queue_job_id))

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured[0][0] == frame.id
    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert frame.buildroot['sdImage']['status'] == 'queued'
    assert frame.buildroot['sdImage']['requestId'] == captured[0][1]
    assert frame.buildroot['sdImage']['queueJobId'] == captured[0][2]


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_keeps_active_build(async_client, db, redis, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'building',
            'requestId': 'request123',
            'queueJobId': 'buildroot_sd_image:1:request123',
            'startedAt': datetime.now(timezone.utc).isoformat(),
        },
    }
    db.add(frame)
    db.commit()
    captured: list[int] = []

    async def fake_queue_job_active(_redis, _sd_image):
        return True

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append(id)

    monkeypatch.setattr(buildroot_image_module, "_buildroot_sd_image_queue_job_active", fake_queue_job_active)
    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation already running'
    assert captured == []


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_post_returns_ready_image(async_client, db, redis, tmp_path, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img'
    image_path.write_bytes(b'frameos image')
    frame.mode = 'buildroot'
    current_base_entry = {
        'object_key': 'buildroot-images/current.img.gz',
        'sha256': 'current-sha256',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img',
            'path': str(image_path),
            'downloadUrl': f'/api/frames/{frame.id}/buildroot/sd_image/download',
            'customizationVersion': 6,
            'baseImage': {
                'objectKey': current_base_entry['object_key'],
                'sha256': current_base_entry['sha256'],
            },
        },
    }
    set_buildroot_sd_image_config_fingerprint(frame)
    db.add(frame)
    db.commit()
    captured: list[int] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append(id)

    async def fake_resolve_buildroot_base_entry(_platform, frameos_version=None):
        return current_base_entry

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)
    monkeypatch.setattr(buildroot_image_module, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image already ready'
    assert response.json()['sdImage']['status'] == 'ready'
    assert captured == []


@pytest.mark.asyncio
async def test_api_frame_update_clears_ready_buildroot_sd_image_on_config_change(async_client, db, redis, tmp_path):
    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img'
    image_path.write_bytes(b'frameos image')
    frame.mode = 'buildroot'
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': 2,
        },
    }
    db.add(frame)
    db.commit()

    response = await async_client.post(f'/api/frames/{frame.id}', json={'name': 'RenamedBuildrootFrame'})

    assert response.status_code == 200
    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert frame.name == 'RenamedBuildrootFrame'
    assert 'sdImage' not in frame.buildroot


@pytest.mark.asyncio
async def test_api_frame_update_keeps_buildroot_sd_image_for_unrelated_metadata(async_client, db, redis, tmp_path):
    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img'
    image_path.write_bytes(b'frameos image')
    frame.mode = 'buildroot'
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': 2,
        },
    }
    db.add(frame)
    db.commit()

    response = await async_client.post(f'/api/frames/{frame.id}', json={'terminal_history': ['ls']})

    assert response.status_code == 200
    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert frame.buildroot['sdImage']['status'] == 'ready'


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_force_regenerates_ready_image(async_client, db, redis, tmp_path, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img'
    image_path.write_bytes(b'frameos image')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img',
            'path': str(image_path),
            'downloadUrl': f'/api/frames/{frame.id}/buildroot/sd_image/download',
        },
    }
    db.add(frame)
    db.commit()
    captured: list[tuple[int, str | None, str | None]] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append((id, request_id, queue_job_id))

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image?force=1')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured[0][0] == frame.id
    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert frame.buildroot['sdImage']['status'] == 'queued'
    assert frame.buildroot['sdImage']['requestId'] == captured[0][1]


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_regenerates_stale_customization_version(
    async_client,
    db,
    redis,
    tmp_path,
    monkeypatch,
):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img.gz'
    image_path.write_bytes(b'old image')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': 3,
        },
    }
    set_buildroot_sd_image_config_fingerprint(frame)
    db.add(frame)
    db.commit()
    captured: list[tuple[int, str | None, str | None]] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append((id, request_id, queue_job_id))

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    status_response = await async_client.get(f'/api/frames/{frame.id}/buildroot/sd_image')
    assert status_response.status_code == 200
    assert status_response.json()['sdImage']['status'] == 'stale'

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured[0][0] == frame.id


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_regenerates_stale_base_image(
    async_client,
    db,
    redis,
    tmp_path,
    monkeypatch,
):
    import app.api.frames as frames_api_module
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img.gz'
    image_path.write_bytes(b'old image')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': 6,
            'baseImage': {
                'objectKey': 'buildroot-images/old.img.gz',
                'sha256': 'old-sha256',
            },
        },
    }
    set_buildroot_sd_image_config_fingerprint(frame)
    db.add(frame)
    db.commit()
    current_base_entry = {
        'object_key': 'buildroot-images/current.img.gz',
        'sha256': 'current-sha256',
    }
    captured: list[tuple[int, str | None, str | None]] = []

    async def fake_resolve_buildroot_base_entry(_platform, frameos_version=None):
        return current_base_entry

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append((id, request_id, queue_job_id))

    monkeypatch.setattr(frames_api_module, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)
    monkeypatch.setattr(buildroot_image_module, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)
    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    status_response = await async_client.get(f'/api/frames/{frame.id}/buildroot/sd_image')
    assert status_response.status_code == 200
    assert status_response.json()['sdImage']['status'] == 'stale'
    assert status_response.json()['sdImage']['error'] == 'The generated image was built with an older Buildroot base image'

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured[0][0] == frame.id


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_regenerates_stale_config_fingerprint(
    async_client,
    db,
    redis,
    tmp_path,
    monkeypatch,
):
    import app.api.frames as frames_api_module
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img.gz'
    image_path.write_bytes(b'old image')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    current_base_entry = {
        'object_key': 'buildroot-images/current.img.gz',
        'sha256': 'current-sha256',
    }
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'compilationMode': 'precompiled',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': 6,
            'baseImage': {
                'objectKey': current_base_entry['object_key'],
                'sha256': current_base_entry['sha256'],
            },
        },
    }
    set_buildroot_sd_image_config_fingerprint(frame)
    frame.buildroot = {
        **frame.buildroot,
        'compilationMode': 'static',
    }
    db.add(frame)
    db.commit()
    captured: list[tuple[int, str | None, str | None]] = []

    async def fake_resolve_buildroot_base_entry(_platform, frameos_version=None):
        return current_base_entry

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append((id, request_id, queue_job_id))

    monkeypatch.setattr(frames_api_module, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)
    monkeypatch.setattr(buildroot_image_module, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)
    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    status_response = await async_client.get(f'/api/frames/{frame.id}/buildroot/sd_image')
    assert status_response.status_code == 200
    assert status_response.json()['sdImage']['status'] == 'stale'
    assert status_response.json()['sdImage']['error'] == 'The generated image was built with a different compilation mode'

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured[0][0] == frame.id


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_download(async_client, db, redis, tmp_path):
    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    image_path = tmp_path / 'frameos-test.img'
    image_path.write_bytes(b'frameos image')
    frame.mode = 'buildroot'
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'setupJsonResetFilePath': '/boot/frameos-setup.json',
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img',
            'path': str(image_path),
            'customizationVersion': 6,
        },
    }
    set_buildroot_sd_image_config_fingerprint(frame)
    db.add(frame)
    db.commit()

    response = await async_client.get(f'/api/frames/{frame.id}/buildroot/sd_image/download')

    assert response.status_code == 200
    assert gzip.decompress(response.content) == b'frameos image'
    assert image_path.with_suffix('.img.gz').is_file()
    assert response.headers['content-type'].startswith('application/gzip')
    assert 'frameos-test.img.gz' in response.headers['content-disposition']


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
    await redis.delete(f"frame:{frame.id}:active_scene")

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
