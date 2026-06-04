import asyncio
import gzip
import io
import json
import pytest
import subprocess
import time
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import HTTPException
from datetime import datetime, timedelta, timezone
from PIL import Image
from urllib.parse import urlparse

from app.api import frames as frames_api
from app.models import new_frame
from app.models.frame import Frame
from app.models.log import Log
from app.models.metrics import Metrics
from app.models.user import User
from app.tenancy import ensure_default_project_for_user
from app.tasks.buildroot_image import BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION, buildroot_sd_image_config_fingerprint
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
async def test_api_frame_bootstrap_command_enables_agent_and_returns_script(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')
    frame.scenes = [
        {
            'id': 'scene-1',
            'name': 'Scene 1',
            'settings': {'execution': 'interpreted'},
            'nodes': [],
            'edges': [],
        }
    ]
    db.add(frame)
    db.commit()

    command_response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap')

    assert command_response.status_code == 200
    command_payload = command_response.json()
    assert command_payload['script_url'].startswith(
        f'http://backend.local:8989/api/projects/{frame.project_id}/frame-bootstrap/{frame.id}/'
    )
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
    assert 'frameos.service' in script
    assert 'FRAMEOS_DIR=/srv/frameos' in script
    assert './frameos setup' in script
    assert 'install -m 0644 "$frameos_release_dir/frameos.service" /etc/systemd/system/frameos.service' in script
    assert (
        'install -m 0644 "$agent_release_dir/frameos_agent.service" '
        '/etc/systemd/system/frameos_agent.service'
    ) in script
    assert 'FrameOS and the FrameOS agent are installed and started' in script
    assert 'compile_frameos_agent' not in script
    assert 'sh compile' not in script
    syntax_check = subprocess.run(["sh", "-n"], input=script, text=True, capture_output=True)
    assert syntax_check.returncode == 0, syntax_check.stderr

    config_json = script.split("<<'FRAMEOS_CONFIG_JSON'\n", 1)[1].split(
        '\nFRAMEOS_CONFIG_JSON',
        1,
    )[0]
    config = json.loads(config_json)
    assert config['serverHost'] == 'backend.local'
    assert config['serverApiKey'] == frame.server_api_key
    assert config['agent']['agentEnabled'] is True
    assert config['agent']['agentRunCommands'] is True
    assert config['agent']['agentSharedSecret'] == frame.agent['agentSharedSecret']

    scenes_json = script.split("<<'FRAMEOS_SCENES_JSON'\n", 1)[1].split(
        '\nFRAMEOS_SCENES_JSON',
        1,
    )[0]
    assert json.loads(scenes_json) == frame.scenes

    bad_response = await no_auth_client.get(f'/api/projects/{frame.project_id}/frame-bootstrap/{frame.id}/not-the-token')
    assert bad_response.status_code == 404


@pytest.mark.asyncio
async def test_api_frame_bootstrap_command_can_preserve_deploy_transport(async_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')
    frame.agent = {'deployWithAgent': False}
    db.add(frame)
    db.commit()

    response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap?select_agent=0')

    assert response.status_code == 200
    db.refresh(frame)
    assert frame.agent['agentEnabled'] is True
    assert frame.agent['agentRunCommands'] is True
    assert frame.agent['deployWithAgent'] is False


@pytest.mark.asyncio
async def test_api_frame_bootstrap_command_can_regenerate_token(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')

    first_response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap')
    assert first_response.status_code == 200
    first_payload = first_response.json()
    first_script_path = urlparse(first_payload['script_url']).path
    db.refresh(frame)
    first_agent_secret = frame.agent['agentSharedSecret']

    second_response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap?regenerate=1')
    assert second_response.status_code == 200
    second_payload = second_response.json()
    second_script_path = urlparse(second_payload['script_url']).path
    db.refresh(frame)

    assert second_payload['script_url'] != first_payload['script_url']
    assert frame.agent['agentSharedSecret'] != first_agent_secret
    assert (await no_auth_client.get(first_script_path)).status_code == 404
    assert (await no_auth_client.get(second_script_path)).status_code == 200


@pytest.mark.asyncio
async def test_api_frame_agent_tasks_default_to_auto_transport(async_client, db, redis, monkeypatch):
    import app.tasks as tasks_package

    frame = await new_frame(
        db,
        redis,
        name="AgentTaskFrame",
        frame_host="localhost",
        server_host="localhost",
        project_id=async_client.project_id,
    )

    captured: list[tuple[str, int, dict]] = []

    async def fake_deploy_agent(id, _redis, **kwargs):
        captured.append(("deploy", id, kwargs))

    async def fake_restart_agent(id, _redis, **kwargs):
        captured.append(("restart", id, kwargs))

    monkeypatch.setattr(tasks_package, "deploy_agent", fake_deploy_agent)
    monkeypatch.setattr(tasks_package, "restart_agent", fake_restart_agent)

    deploy_response = await async_client.post(f'/api/frames/{frame.id}/deploy_agent?recompile=1')
    restart_response = await async_client.post(f'/api/frames/{frame.id}/restart_agent')

    assert deploy_response.status_code == 200
    assert restart_response.status_code == 200
    assert captured == [
        ("deploy", frame.id, {"recompile": True, "transport": "auto"}),
        ("restart", frame.id, {"transport": "auto"}),
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
async def test_api_frame_metrics_returns_metrics_without_reboot_markers(async_client, db, redis):
    frame = await new_frame(db, redis, 'MetricsFrame', 'localhost', 'localhost')
    boot_timestamp = datetime(2026, 6, 2, 3, 4, 5)
    metric_timestamp = datetime(2026, 6, 2, 3, 5, 0)
    reboot_metric_timestamp = datetime(2026, 6, 2, 3, 6, 0)
    second_reboot_metric_timestamp = datetime(2026, 6, 2, 3, 7, 0)
    db.add_all(
        [
            Metrics(frame_id=frame.id, timestamp=metric_timestamp, metrics={"load": [0.12], "runtime": {"bootId": "boot-a"}}),
            Metrics(
                frame_id=frame.id,
                timestamp=reboot_metric_timestamp,
                metrics={"load": [0.18], "runtime": {"bootId": "boot-a"}},
            ),
            Metrics(
                frame_id=frame.id,
                timestamp=second_reboot_metric_timestamp,
                metrics={
                    "load": [0.24],
                    "runtime": {"bootId": "boot-b"},
                },
            ),
            Log(frame_id=frame.id, type='webhook', line=json.dumps({"event": "bootup"}), timestamp=boot_timestamp),
            Log(frame_id=frame.id, type='webhook', line=json.dumps({"event": "metrics"}), timestamp=metric_timestamp),
            Log(frame_id=frame.id, type='webhook', line='not json bootup', timestamp=metric_timestamp),
        ]
    )
    db.commit()

    response = await async_client.get(f'/api/frames/{frame.id}/metrics')

    assert response.status_code == 200
    payload = response.json()
    assert payload['metrics'][0]['metrics'] == {"load": [0.12], "runtime": {"bootId": "boot-a"}}


@pytest.mark.asyncio
async def test_api_frame_recent_metrics_limits_metrics(async_client, db, redis):
    frame = await new_frame(db, redis, 'RecentMetricsFrame', 'localhost', 'localhost')
    for index in range(4):
        db.add(
            Metrics(
                frame_id=frame.id,
                timestamp=datetime(2026, 6, 2, 3, index, 0),
                metrics={"load": [index]},
            )
        )
    db.commit()

    response = await async_client.get(f'/api/frames/{frame.id}/metrics/recent?limit=3&since=2026-06-02T03:01:30Z')

    assert response.status_code == 200
    payload = response.json()
    assert [metric['metrics']['load'][0] for metric in payload['metrics']] == [2, 3]


@pytest.mark.asyncio
async def test_api_frame_get_not_found(async_client):
    # Large ID that doesn't exist
    response = await async_client.get('/api/frames/999999')
    assert response.status_code == 404
    assert response.json()['detail'] == 'Frame not found'


@pytest.mark.asyncio
async def test_api_frame_logs_full_download_includes_all_persisted_logs(async_client, db):
    frame = Frame(
        project_id=async_client.project_id,
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

    capped_response = await async_client.get(f'/api/frames/{frame.id}/logs')
    assert capped_response.status_code == 200
    capped_logs = capped_response.json()['logs']
    assert len(capped_logs) == 1000
    assert capped_logs[0]['line'] == 'line 2'
    assert capped_logs[-1]['line'] == 'line 1001'

    full_response = await async_client.get(f'/api/frames/{frame.id}/logs/full')
    assert full_response.status_code == 200
    assert full_response.headers['content-type'].startswith('text/plain')
    assert 'attachment;' in full_response.headers['content-disposition']
    assert f'frame-{frame.id}-full-logs-' in full_response.headers['content-disposition']
    full_lines = full_response.text.splitlines()
    assert len(full_lines) == 1002
    assert full_lines[0].endswith('(stdout) line 0')
    assert full_lines[-1].endswith('(stdout) line 1001')

@pytest.mark.asyncio
async def test_api_frame_get_image_cached(async_client, db, redis):
    # Create the frame
    frame = await new_frame(db, redis, 'CachedImageFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.set(cache_key, b'cached_image_data')

    image_url = f'/api/frames/{frame.id}/image?t=-1'
    response = await async_client.get(image_url)
    assert response.status_code == 200
    assert response.content == b'cached_image_data'


@pytest.mark.asyncio
async def test_api_frame_get_image_does_not_share_host_port_cache_across_projects(async_client, db, redis):
    frame = await new_frame(
        db,
        redis,
        'ProjectImageFrame',
        'same-frame.local',
        'localhost',
        project_id=async_client.project_id,
    )
    other_user = User(email='other-cache-project@example.com')
    other_user.set_password('testpassword')
    db.add(other_user)
    db.commit()
    db.refresh(other_user)
    other_project = ensure_default_project_for_user(db, other_user)
    await new_frame(
        db,
        redis,
        'OtherProjectImageFrame',
        'same-frame.local',
        'localhost',
        project_id=other_project.id,
    )
    old_shared_cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    await redis.set(old_shared_cache_key, b'other_project_image')

    response = await async_client.get(f'/api/frames/{frame.id}/image?t=-1')

    assert response.status_code == 200
    assert response.content != b'other_project_image'
    assert response.headers['x-frameos-image-state'] == 'placeholder'


@pytest.mark.asyncio
async def test_api_frame_get_image_placeholder_uses_rotated_dimensions(async_client, db, redis):
    frame = await new_frame(db, redis, 'RotatedPlaceholderFrame', 'localhost', 'localhost')
    frame.width = 800
    frame.height = 480
    frame.rotate = 90
    db.add(frame)
    db.commit()

    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.delete(cache_key)

    response = await async_client.get(f'/api/frames/{frame.id}/image?t=-1')

    assert response.status_code == 200
    assert response.headers['x-frameos-image-state'] == 'placeholder'
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (480, 800)


@pytest.mark.asyncio
async def test_api_frame_get_image_head_marks_missing_cache_without_refresh(async_client, db, redis):
    frame = await new_frame(db, redis, 'HeadPlaceholderFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.delete(cache_key)

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock()) as fetch_frame:
        response = await async_client.head(f'/api/frames/{frame.id}/image?t=-1')

    assert response.status_code == 200
    assert response.content == b''
    assert response.headers['x-frameos-image-state'] == 'placeholder'
    fetch_frame.assert_not_awaited()


@pytest.mark.asyncio
async def test_api_frame_get_image_head_omits_placeholder_header_for_cache(async_client, db, redis):
    frame = await new_frame(db, redis, 'HeadCachedFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.set(cache_key, b'cached_image_data')

    response = await async_client.head(f'/api/frames/{frame.id}/image?t=-1')

    assert response.status_code == 200
    assert response.content == b''
    assert 'x-frameos-image-state' not in response.headers


@pytest.mark.asyncio
async def test_api_frame_get_image_returns_cache_when_refresh_already_running(async_client, db, redis):
    frame = await new_frame(db, redis, 'LockedImageFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.set(cache_key, b'cached_while_refreshing')
    lock = frames_api._get_frame_image_lock(frame.id)

    await lock.acquire()
    try:
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')
    finally:
        lock.release()

    assert response.status_code == 200
    assert response.content == b'cached_while_refreshing'


@pytest.mark.asyncio
async def test_api_frame_get_image_returns_cache_when_refresh_fails(async_client, db, redis):
    frame = await new_frame(db, redis, 'FailingImageFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.set(cache_key, b'cached_after_refresh_error')

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        raise HTTPException(status_code=408, detail='timeout')

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert response.content == b'cached_after_refresh_error'


@pytest.mark.asyncio
async def test_api_frame_get_image_returns_error_png_when_refresh_fails_without_cache(async_client, db, redis):
    frame = await new_frame(db, redis, 'NoCacheFailingImageFrame', 'localhost', 'localhost')
    frame.width = 320
    frame.height = 240
    db.add(frame)
    db.commit()
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.delete(cache_key)

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        raise HTTPException(status_code=502, detail='All connection attempts failed')

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert response.headers['content-type'].startswith('image/png')
    assert response.headers['x-frameos-image-state'] == 'error'
    assert response.headers['x-frameos-image-error-status'] == '502'
    assert not response.content.startswith(b'{"detail"')
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (320, 240)


@pytest.mark.asyncio
async def test_api_frame_get_image_uses_redis_refresh_lock(async_client, db, redis):
    frame = await new_frame(db, redis, 'RedisLockedImageFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_image_cache_key(frame.id)
    lock_key = frames_api._frame_image_refresh_lock_key(frame.id)
    await redis.set(cache_key, b'cached_during_redis_refresh')
    await redis.set(lock_key, 'other-worker', ex=30)

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock()) as fetch_frame:
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert response.content == b'cached_during_redis_refresh'
    fetch_frame.assert_not_awaited()


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
async def test_api_frame_states_caches_refresh_failure(async_client, db, redis):
    frame = await new_frame(db, redis, 'FailingStatesFrame', 'localhost', 'localhost')
    cache_key = frames_api._frame_states_cache_key(frame.id)
    lock_key = frames_api._frame_states_cache_lock_key(frame.id)
    await redis.delete(cache_key, lock_key)
    await redis.set(f"frame:{frame.id}:active_scene", "last-scene")

    load_states = AsyncMock(side_effect=HTTPException(status_code=408, detail="timeout"))
    with patch("app.api.frames._load_frame_states", new=load_states):
        response = await async_client.get(f'/api/frames/{frame.id}/states')

        assert response.status_code == 200
        payload = response.json()
        assert payload["sceneId"] == "last-scene"
        assert payload["states"] == {}
        assert payload["cache"]["cached"] is False
        assert payload["cache"]["refreshing"] is True

        for _ in range(10):
            refreshed = await frames_api._read_frame_states_cache(redis, cache_key)
            if refreshed and refreshed.get("error"):
                break
            await asyncio.sleep(0.05)
        else:
            pytest.fail("states cache did not record the refresh failure")

        second_response = await async_client.get(f'/api/frames/{frame.id}/states')

    assert second_response.status_code == 200
    second_payload = second_response.json()
    assert second_payload["sceneId"] == "last-scene"
    assert second_payload["states"] == {}
    assert second_payload["cache"]["cached"] is True
    assert second_payload["cache"]["refreshing"] is False
    assert second_payload["cache"]["retry_after"] == frames_api.FRAME_STATES_CACHE_FAILURE_RETRY_AFTER_SECONDS
    assert "timeout" in second_payload["cache"]["error"]
    load_states.assert_awaited_once()


@pytest.mark.asyncio
async def test_forward_frame_request_get_uses_bounded_frame_http(db, redis):
    frame = await new_frame(db, redis, 'BoundedHttpFrame', 'localhost', 'localhost')

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        assert frame_obj.id == frame.id
        assert path == "/states"
        assert method == "GET"
        return 200, b'{"sceneId":"scene-1","states":{"scene-1":{"value":1}}}', {
            "content-type": "application/json"
        }

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch) as fetch_frame:
        response = await frames_api._forward_frame_request(frame, redis, path="/states")

    assert response == {"sceneId": "scene-1", "states": {"scene-1": {"value": 1}}}
    assert fetch_frame.call_count == 1


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
    response = await async_client.post('/api/frames/999999/reset')
    assert response.status_code == 404
    assert response.json()["detail"] == "Frame not found"


@pytest.mark.asyncio
async def test_api_frame_update_name(async_client, db, redis):
    frame = await new_frame(db, redis, 'InitialName', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"name": "Updated Name"})
    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.name == "Updated Name"


@pytest.mark.asyncio
async def test_api_frame_update_max_http_response_bytes(async_client, db, redis):
    frame = await new_frame(db, redis, 'HttpLimitFrame', 'localhost', 'localhost')
    resp = await async_client.post(f'/api/frames/{frame.id}', json={"max_http_response_bytes": 32 * 1024 * 1024})
    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.max_http_response_bytes == 32 * 1024 * 1024


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
async def test_api_frame_update_timezone_for_rpios(async_client, db, redis):
    frame = await new_frame(db, redis, 'TimezoneFrame', 'localhost', 'localhost')
    frame.mode = 'rpios'
    db.add(frame)
    db.commit()

    resp = await async_client.post(f'/api/frames/{frame.id}', json={"timezone": "Europe/Brussels"})

    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.timezone == "Europe/Brussels"


@pytest.mark.asyncio
async def test_api_frame_update_preserves_custom_timezone_string(async_client, db, redis):
    frame = await new_frame(db, redis, 'CustomTimezoneFrame', 'localhost', 'localhost')
    frame.mode = 'rpios'
    frame.timezone = 'Custom/Zone'
    db.add(frame)
    db.commit()

    resp = await async_client.post(f'/api/frames/{frame.id}', json={"timezone": "Custom/Zone"})

    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.timezone == "Custom/Zone"


@pytest.mark.asyncio
async def test_api_frame_update_compacts_timezone_updater(async_client, db, redis):
    frame = await new_frame(db, redis, 'TimezoneUpdaterFrame', 'localhost', 'localhost')
    frame.timezone_updater = {
        "enabled": True,
        "hour": 3,
        "url": "https://tz.frameos.net/tzdata.json.gz",
    }
    db.add(frame)
    db.commit()

    resp = await async_client.post(
        f'/api/frames/{frame.id}',
        json={
            "timezone_updater": {
                "enabled": True,
                "hour": 3,
                "url": "https://tz.frameos.net/tzdata.json.gz",
            }
        },
    )

    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.timezone_updater is None


@pytest.mark.asyncio
async def test_api_frame_update_keeps_custom_timezone_updater(async_client, db, redis):
    frame = await new_frame(db, redis, 'CustomTimezoneUpdaterFrame', 'localhost', 'localhost')

    resp = await async_client.post(
        f'/api/frames/{frame.id}',
        json={
            "timezone_updater": {
                "enabled": True,
                "hour": 5,
                "url": "https://example.com/tzdata.json.gz",
            }
        },
    )

    assert resp.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.timezone_updater == {
        "hour": 5,
        "url": "https://example.com/tzdata.json.gz",
    }


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
        "timezone": "Europe/Brussels",
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
    assert frame['timezone'] == 'Europe/Brussels'
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
async def test_api_frame_new_buildroot_allows_missing_wifi(async_client):
    payload = {
        "mode": "buildroot",
        "name": "BuildrootFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "raspberry-pi-zero-2-w",
        "network": {"wifiSSID": "", "wifiPassword": ""},
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    frame = response.json()['frame']
    assert frame['mode'] == 'buildroot'
    assert frame['network']['wifiSSID'] == ''
    assert frame['network']['wifiPassword'] == ''
    frames_response = await async_client.get('/api/frames')
    assert len(frames_response.json()['frames']) == 1


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
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img',
            'path': str(image_path),
            'downloadUrl': f'/api/frames/{frame.id}/buildroot/sd_image/download',
            'customizationVersion': BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
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
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
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
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img.gz',
            'path': str(image_path),
            'customizationVersion': BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
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
        'sdImage': {
            'status': 'ready',
            'filename': 'frameos-test.img',
            'path': str(image_path),
            'customizationVersion': BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
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
    existing_frame = await new_frame(
        db,
        redis,
        'ExistingFrame',
        'existinghost',
        'existingserver',
        project_id=async_client.project_id,
    )
    other_user = User(email='other-import@example.com')
    other_user.set_password('password')
    db.add(other_user)
    db.commit()
    other_project = ensure_default_project_for_user(db, other_user)

    payload = {
        "name": "ImportedFrame",
        "frame_host": "importhost",
        "server_host": "importserver",
        "project_id": other_project.id,
        "server_api_key": existing_frame.server_api_key,
    }
    resp = await async_client.post('/api/frames/import', json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data['frame']['name'] == "ImportedFrame"
    imported_frame = db.query(Frame).filter_by(id=data['frame']['id']).one()
    assert imported_frame.project_id == async_client.project_id
    assert imported_frame.server_api_key != existing_frame.server_api_key

    restored_payload = {
        "name": "RestoredFrame",
        "frame_host": "restorehost",
        "server_host": "restoreserver",
        "project_id": other_project.id,
        "server_api_key": "restored-server-api-key",
    }
    restored_resp = await async_client.post('/api/frames/import', json=restored_payload)
    assert restored_resp.status_code == 200
    restored_data = restored_resp.json()
    restored_frame = db.query(Frame).filter_by(id=restored_data['frame']['id']).one()
    assert restored_frame.project_id == async_client.project_id
    assert restored_frame.server_api_key == restored_payload["server_api_key"]


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
    cache_key = frames_api._frame_image_cache_key(frame.id)
    await redis.set(cache_key, b'cookie_cached_image_data')

    user = User(email='cookieframe@example.com')
    user.set_password('testpassword')
    db.add(user)
    db.commit()

    login_resp = await no_auth_client.post('/api/login', data={'username': 'cookieframe@example.com', 'password': 'testpassword'})
    assert login_resp.status_code == 200

    response = await no_auth_client.get(f'/api/projects/{frame.project_id}/frames/{frame.id}/image?t=-1')
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
