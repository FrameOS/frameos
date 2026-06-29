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

from app.api import frame_sync, frames as frames_api
from app.models import new_frame
from app.models.frame import Frame
from app.models.log import Log
from app.models.metrics import Metrics
from app.models.scene_image import SceneImage
from app.models.settings import Settings
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
async def test_api_frame_bootstrap_command_enables_remote_and_returns_script(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')
    frame.device = 'framebuffer'
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
    assert 'frameos_remote' in script
    assert 'frameos.service' in script
    assert 'RestartSec=5' in script
    assert 'After=network.target getty@tty1.service' in script
    assert 'Conflicts=getty@tty1.service' in script
    assert 'TTYPath=/dev/tty1' in script
    assert 'StandardInput=tty-force' in script
    assert 'TTYReset=yes' in script
    assert 'ExecStopPost=-+/bin/sh -lc' in script
    assert '/srv/frameos/runtime/frameos-last-exit' in script
    assert (
        "ExecStopPost=-+/bin/systemd-run --quiet --collect --on-active=10 "
        "/bin/sh -lc '/bin/systemctl show -p ActiveState --value frameos.service 2>/dev/null | "
        "/bin/grep -xq -e active -e activating -e reloading && exit 0; "
        "/bin/systemctl reset-failed getty@tty1.service; /bin/systemctl start getty@tty1.service'"
        in script
    )
    assert '--on-active=3 /bin/systemctl reset-failed getty@tty1.service' not in script
    assert '--on-active=4 /bin/systemctl start getty@tty1.service' not in script
    assert 'python3 -c' not in script
    assert 'TTYVHangup=yes' not in script
    assert 'TTYVTDisallocate=yes' not in script
    assert 'FRAMEOS_DIR=/srv/frameos' in script
    assert './frameos setup' in script
    assert 'install -m 0644 "$frameos_release_dir/frameos.service" /etc/systemd/system/frameos.service' in script
    assert (
        'install -m 0644 "$remote_release_dir/frameos-remote.service" '
        '/etc/systemd/system/frameos-remote.service'
    ) in script
    assert 'FrameOS and FrameOS Remote are installed and started' in script
    assert 'compile_frameos_remote' not in script
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

    response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap?select_remote=0')

    assert response.status_code == 200
    db.refresh(frame)
    assert frame.agent['agentEnabled'] is True
    assert frame.agent['agentRunCommands'] is True
    assert frame.agent['deployWithAgent'] is False

    legacy_frame = await new_frame(db, redis, 'BootstrapLegacyFrame', 'legacy-frame.local', 'backend.local')
    legacy_frame.agent = {'deployWithAgent': False}
    db.add(legacy_frame)
    db.commit()

    legacy_response = await async_client.post(f'/api/frames/{legacy_frame.id}/frame_bootstrap?select_agent=0')

    assert legacy_response.status_code == 200
    db.refresh(legacy_frame)
    assert legacy_frame.agent['agentEnabled'] is True
    assert legacy_frame.agent['agentRunCommands'] is True
    assert legacy_frame.agent['deployWithAgent'] is False


@pytest.mark.asyncio
async def test_api_frame_bootstrap_command_can_regenerate_token(async_client, no_auth_client, db, redis):
    frame = await new_frame(db, redis, 'BootstrapFrame', 'frame.local', 'backend.local')

    first_response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap')
    assert first_response.status_code == 200
    first_payload = first_response.json()
    first_script_path = urlparse(first_payload['script_url']).path
    db.refresh(frame)
    first_remote_secret = frame.agent['agentSharedSecret']

    second_response = await async_client.post(f'/api/frames/{frame.id}/frame_bootstrap?regenerate=1')
    assert second_response.status_code == 200
    second_payload = second_response.json()
    second_script_path = urlparse(second_payload['script_url']).path
    db.refresh(frame)

    assert second_payload['script_url'] != first_payload['script_url']
    assert frame.agent['agentSharedSecret'] != first_remote_secret
    assert (await no_auth_client.get(first_script_path)).status_code == 404
    assert (await no_auth_client.get(second_script_path)).status_code == 200


@pytest.mark.asyncio
async def test_api_frame_remote_tasks_default_to_auto_transport(async_client, db, redis, monkeypatch):
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

    async def fake_deploy_remote(id, _redis, **kwargs):
        captured.append(("deploy", id, kwargs))

    async def fake_restart_remote(id, _redis, **kwargs):
        captured.append(("restart", id, kwargs))

    monkeypatch.setattr(tasks_package, "deploy_remote", fake_deploy_remote)
    monkeypatch.setattr(tasks_package, "restart_remote", fake_restart_remote)

    deploy_response = await async_client.post(f'/api/frames/{frame.id}/deploy_remote?recompile=1')
    restart_response = await async_client.post(f'/api/frames/{frame.id}/restart_remote')

    assert deploy_response.status_code == 200
    assert restart_response.status_code == 200
    assert captured == [
        ("deploy", frame.id, {"recompile": True, "transport": "auto"}),
        ("restart", frame.id, {"transport": "auto"}),
    ]


@pytest.mark.asyncio
async def test_api_frame_cancel_deploy_and_force_deploy(async_client, db, redis, monkeypatch):
    import importlib

    import app.tasks as tasks_package

    deploy_frame_module = importlib.import_module("app.tasks.deploy_frame")

    frame = await new_frame(
        db,
        redis,
        name="CancelDeployFrame",
        frame_host="localhost",
        server_host="localhost",
        project_id=async_client.project_id,
    )

    calls: list[tuple[str, int]] = []

    async def fake_cancel_active_deploy(_db, _redis, target_frame):
        calls.append(("cancel", target_frame.id))
        return {"abortedJob": True, "clearedLock": True, "resetStatus": False}

    async def fake_deploy_frame(id, _redis, **kwargs):
        calls.append(("deploy", id))

    monkeypatch.setattr(deploy_frame_module, "cancel_active_deploy", fake_cancel_active_deploy)
    monkeypatch.setattr(tasks_package, "deploy_frame", fake_deploy_frame)

    cancel_response = await async_client.post(f'/api/frames/{frame.id}/cancel_deploy')
    assert cancel_response.status_code == 200
    assert cancel_response.json() == {
        "message": "Success",
        "abortedJob": True,
        "clearedLock": True,
        "resetStatus": False,
    }

    plain_response = await async_client.post(f'/api/frames/{frame.id}/deploy')
    forced_response = await async_client.post(f'/api/frames/{frame.id}/deploy?force=true')
    assert plain_response.status_code == 200
    assert forced_response.status_code == 200
    assert calls == [
        ("cancel", frame.id),
        ("deploy", frame.id),
        ("cancel", frame.id),
        ("deploy", frame.id),
    ]


@pytest.mark.asyncio
async def test_api_frame_embedded_usb_deploy_complete_marks_snapshot(async_client, db, redis):
    frame = await new_frame(
        db,
        redis,
        name="UsbDeployFrame",
        frame_host="localhost",
        server_host="localhost",
        project_id=async_client.project_id,
    )
    frame.mode = "embedded"
    frame.status = "deploying"
    frame.scenes = [
        {
            "id": "scene-1",
            "name": "Scene 1",
            "settings": {},
            "nodes": [],
            "edges": [],
        }
    ]
    frame.last_successful_deploy = {"stale": True}
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.add(frame)
    db.commit()

    response = await async_client.post(
        f"/api/frames/{frame.id}/embedded/usb_deploy_complete?task_id=usb_task.1"
    )

    assert response.status_code == 200
    payload = response.json()["frame"]
    assert payload["status"] == "starting"
    assert payload["last_successful_deploy"]["id"] == frame.id
    assert payload["last_successful_deploy"]["mode"] == "embedded"
    assert payload["last_successful_deploy"]["frameos_version"] == frames_api.current_frameos_version()
    assert payload["last_successful_deploy"]["scenes"] == frame.scenes
    assert "last_successful_deploy" not in payload["last_successful_deploy"]
    assert "last_successful_deploy_at" not in payload["last_successful_deploy"]
    assert payload["last_successful_deploy_at"] is not None

    logs = db.query(Log).filter_by(frame_id=frame.id).order_by(Log.id).all()
    assert [(entry.type, entry.line) for entry in logs[-2:]] == [
        ("stdinfo", "Embedded USB fast deploy complete; reload queued"),
        ("stdout", "[frameos-task:usb_task.1] deploy completed fast"),
    ]


@pytest.mark.asyncio
async def test_api_frame_embedded_usb_deploy_complete_rejects_non_embedded(async_client, db, redis):
    frame = await new_frame(
        db,
        redis,
        name="NotEmbeddedFrame",
        frame_host="localhost",
        server_host="localhost",
        project_id=async_client.project_id,
    )

    response = await async_client.post(f"/api/frames/{frame.id}/embedded/usb_deploy_complete")

    assert response.status_code == 400
    assert response.json()["detail"] == "USB deploy completion is only available for embedded frames"


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
async def test_api_frame_metrics_returns_metrics_separately_from_reboot_markers(async_client, db, redis):
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
    assert payload['reboots'][0]['timestamp'] == boot_timestamp.replace(tzinfo=timezone.utc).isoformat()
    assert payload['reboots'][0]['log_id'] is not None


@pytest.mark.asyncio
async def test_api_frame_metrics_attaches_reboot_context(async_client, db, redis):
    frame = await new_frame(db, redis, 'MetricsRebootContextFrame', 'localhost', 'localhost')
    db.add_all(
        [
            Log(
                frame_id=frame.id,
                type='stdinfo',
                line='OK Deployed! Rebooting device after boot config changes',
                timestamp=datetime(2026, 6, 2, 3, 4, 0),
            ),
            Log(
                frame_id=frame.id,
                type='webhook',
                line=json.dumps(
                    {
                        "event": "bootup",
                        "reboot": {
                            "serviceResult": "success",
                            "exitCode": "exited",
                            "exitStatus": "0",
                        },
                    }
                ),
                timestamp=datetime(2026, 6, 2, 3, 5, 0),
            ),
            Log(
                frame_id=frame.id,
                type='webhook',
                line=json.dumps(
                    {
                        "event": "bootup",
                        "reboot": {
                            "serviceResult": "oom-kill",
                            "exitCode": "killed",
                            "exitStatus": "KILL",
                        },
                    }
                ),
                timestamp=datetime(2026, 6, 2, 3, 10, 0),
            ),
        ]
    )
    db.commit()

    response = await async_client.get(f'/api/frames/{frame.id}/metrics')

    assert response.status_code == 200
    reboots = response.json()['reboots']
    assert reboots[0]['kind'] == 'initiated'
    assert reboots[0]['source'] == 'backend'
    assert reboots[0]['reason'] == 'OK Deployed! Rebooting device after boot config changes'
    assert reboots[0]['service_result'] == 'success'
    assert reboots[1]['kind'] == 'oom'
    assert reboots[1]['service_result'] == 'oom-kill'


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

    # Incremental fetch returns only rows newer than after_id, ascending.
    midpoint = capped_logs[500]['id']
    incremental = await async_client.get(f'/api/frames/{frame.id}/logs?after_id={midpoint}')
    assert incremental.status_code == 200
    new_logs = incremental.json()['logs']
    assert all(log['id'] > midpoint for log in new_logs)
    assert new_logs == sorted(new_logs, key=lambda log: log['id'])
    # Nothing newer than the most recent id.
    newest = capped_logs[-1]['id']
    empty = await async_client.get(f'/api/frames/{frame.id}/logs?after_id={newest}')
    assert empty.status_code == 200
    assert empty.json()['logs'] == []
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
async def test_api_frame_get_image_converts_bmp_preview(async_client, db, redis):
    frame = await new_frame(db, redis, 'BmpImageFrame', 'localhost', 'localhost')
    bmp = io.BytesIO()
    Image.new('RGB', (2, 1), 'white').save(bmp, format='BMP')
    bmp_body = bmp.getvalue()

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        return 200, bmp_body, {'content-type': 'image/bmp', 'x-scene-id': 'scene-1'}

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert response.content.startswith(b'\x89PNG')
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (2, 1)
    cached = await redis.get(frames_api._frame_image_cache_key(frame.id))
    assert cached.startswith(b'\x89PNG')


@pytest.mark.asyncio
async def test_api_frame_get_image_caches_sync_hint_headers_for_head(async_client, db, redis):
    frame = await new_frame(db, redis, 'SyncHintImageFrame', 'localhost', 'localhost')
    png = io.BytesIO()
    Image.new('RGB', (2, 1), 'white').save(png, format='PNG')
    png_body = png.getvalue()

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        return 200, png_body, {
            'content-type': 'image/png',
            'x-scene-id': 'scene-1',
            'x-frameos-sync-changed': '1',
            'x-frameos-sync-revision': 'rev-local',
            'x-frameos-deployed-revision': 'rev-deployed',
            'x-frameos-frame-config-modified-at': '2026-06-28T10:00:00Z',
            'x-frameos-scenes-modified-at': '2026-06-28T10:01:00Z',
            'x-frameos-last-successful-deploy-at': '2026-06-28T09:59:00Z',
        }

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert response.headers['x-frameos-sync-changed'] == '1'
    assert response.headers['x-frameos-sync-revision'] == 'rev-local'
    assert response.headers['x-frameos-deployed-revision'] == 'rev-deployed'
    assert response.headers['x-frameos-frame-config-modified-at'] == '2026-06-28T10:00:00Z'
    assert response.headers['x-frameos-scenes-modified-at'] == '2026-06-28T10:01:00Z'

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock()) as fetch_frame:
        head_response = await async_client.head(f'/api/frames/{frame.id}/image?t=123')

    assert head_response.status_code == 200
    assert head_response.headers['x-frameos-sync-changed'] == '1'
    assert head_response.headers['x-frameos-sync-revision'] == 'rev-local'
    assert head_response.headers['x-frameos-deployed-revision'] == 'rev-deployed'
    assert head_response.headers['x-frameos-last-successful-deploy-at'] == '2026-06-28T09:59:00Z'
    fetch_frame.assert_not_awaited()


@pytest.mark.asyncio
async def test_api_frames_include_cached_sync_hint(async_client, db, redis):
    frame = await new_frame(db, redis, 'SyncHintFrame', 'localhost', 'localhost')
    await frame_sync.store_frame_sync_hint_headers(
        redis,
        frame.id,
        {
            'x-frameos-sync-changed': '1',
            'x-frameos-sync-revision': 'rev-local',
            'x-frameos-deployed-revision': 'rev-deployed',
            'x-frameos-frame-config-modified-at': '2026-06-28T10:00:00Z',
            'x-frameos-scenes-modified-at': '2026-06-28T10:01:00Z',
            'x-frameos-last-successful-deploy-at': '2026-06-28T09:59:00Z',
        },
    )

    detail_response = await async_client.get(f'/api/frames/{frame.id}')
    assert detail_response.status_code == 200
    detail_hint = detail_response.json()['frame']['frame_sync_hint']
    assert detail_hint['has_changes'] is True
    assert detail_hint['current_revision'] == 'rev-local'
    assert detail_hint['deployed_revision'] == 'rev-deployed'
    assert detail_hint['frame_config_modified_at'] == '2026-06-28T10:00:00Z'
    assert detail_hint['scenes_modified_at'] == '2026-06-28T10:01:00Z'
    assert detail_hint['last_successful_deploy_at'] == '2026-06-28T09:59:00Z'

    list_response = await async_client.get('/api/frames')
    assert list_response.status_code == 200
    list_frame = next(item for item in list_response.json()['frames'] if item['id'] == frame.id)
    assert list_frame['frame_sync_hint']['has_changes'] is True
    assert list_frame['frame_sync_hint']['current_revision'] == 'rev-local'


@pytest.mark.asyncio
async def test_api_frame_get_image_caches_uploaded_preview_under_original_scene_id(async_client, db, redis):
    frame = await new_frame(db, redis, 'UploadedPreviewImageFrame', 'localhost', 'localhost')
    frame.scenes = [{'id': 'scene-1', 'name': 'Scene 1', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    png = io.BytesIO()
    Image.new('RGB', (2, 1), 'white').save(png, format='PNG')
    png_body = png.getvalue()

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        return 200, png_body, {'content-type': 'image/png', 'x-scene-id': 'uploaded/scene-1'}

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert response.content == png_body
    assert (
        db.query(SceneImage)
        .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id='scene-1')
        .first()
        is not None
    )
    assert (
        db.query(SceneImage)
        .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id='uploaded/scene-1')
        .first()
        is None
    )


@pytest.mark.asyncio
async def test_api_frame_get_image_caches_unsaved_uploaded_preview_under_original_scene_id(async_client, db, redis):
    frame = await new_frame(db, redis, 'UnsavedUploadedPreviewImageFrame', 'localhost', 'localhost')

    png = io.BytesIO()
    Image.new('RGB', (2, 1), 'white').save(png, format='PNG')
    png_body = png.getvalue()

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET"):
        return 200, png_body, {'content-type': 'image/png', 'x-scene-id': 'uploaded/new-scene'}

    with patch('app.api.frames._fetch_frame_http_bytes', side_effect=mock_fetch):
        response = await async_client.get(f'/api/frames/{frame.id}/image?t=123')

    assert response.status_code == 200
    assert (
        db.query(SceneImage)
        .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id='new-scene')
        .first()
        is not None
    )
    assert (
        db.query(SceneImage)
        .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id='uploaded/new-scene')
        .first()
        is None
    )


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


def _sync_admin_login_response():
    return 200, b'{"status":"ok"}', {'set-cookie': 'frame_admin_session=test-session; Path=/'}


@pytest.mark.asyncio
async def test_api_frame_sync_status_reports_frame_and_scene_changes(async_client, db, redis):
    frame = await new_frame(db, redis, 'Backend Name', 'localhost', 'localhost')
    frame.frame_admin_auth = {'enabled': True, 'user': 'admin', 'pass': 'secret'}
    frame.scenes = [{'id': 'scene-1', 'name': 'Backend scene', 'nodes': [], 'edges': []}]
    frame.last_successful_deploy = frame.to_dict()
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.add(frame)
    db.commit()

    remote_frame = {
        **frame.to_dict(),
        'id': 1,
        'name': 'Frame Name',
        'scenes': [{'id': 'scene-2', 'name': 'Frame scene', 'nodes': [], 'edges': []}],
        'frame_sync': {
            'frame_config_modified_at': '2026-06-28T10:00:00Z',
            'scenes_modified_at': '2026-06-28T10:01:00Z',
        },
    }

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET", body=None, headers=None):
        if path == '/api/admin/login':
            return _sync_admin_login_response()
        assert headers and 'Cookie' in headers
        assert path == '/api/frames/1'
        return 200, json.dumps({'frame': remote_frame}).encode(), {'content-type': 'application/json'}

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=mock_fetch)):
        response = await async_client.get(f'/api/frames/{frame.id}/sync')

    assert response.status_code == 200
    sync = response.json()['sync']
    assert sync['has_changes'] is True
    assert sync['last_in_sync_at'] is not None
    assert sync['sections'][0]['id'] == 'frame_json'
    assert any(change['path'] == 'name' for change in sync['sections'][0]['changes'])
    assert sync['sections'][0]['frame_updated_at'] == '2026-06-28T10:00:00Z'
    assert sync['sections'][1]['id'] == 'scenes_json'
    assert {change['kind'] for change in sync['sections'][1]['changes']} == {'added', 'removed'}
    assert sync['sections'][1]['frame_updated_at'] == '2026-06-28T10:01:00Z'


@pytest.mark.asyncio
async def test_api_frame_sync_status_ignores_backend_only_changes_since_last_deploy(async_client, db, redis):
    frame = await new_frame(db, redis, 'Baseline Name', 'localhost', 'localhost')
    frame.frame_admin_auth = {'enabled': True, 'user': 'admin', 'pass': 'secret'}
    frame.scenes = [{'id': 'scene-1', 'name': 'Baseline scene', 'nodes': [], 'edges': []}]
    baseline = frame.to_dict()
    frame.last_successful_deploy = baseline
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    frame.name = 'Backend Name'
    frame.scenes = [
        {'id': 'scene-1', 'name': 'Baseline scene', 'nodes': [], 'edges': []},
        {'id': 'scene-2', 'name': 'Custom events', 'nodes': [], 'edges': []},
    ]
    db.add(frame)
    db.commit()

    remote_frame = {
        **baseline,
        'id': 1,
        'frame_sync': {
            'frame_config_modified_at': '2026-06-28T10:00:00Z',
            'scenes_modified_at': '2026-06-28T10:01:00Z',
        },
    }

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET", body=None, headers=None):
        if path == '/api/admin/login':
            return _sync_admin_login_response()
        assert headers and 'Cookie' in headers
        assert path == '/api/frames/1'
        return 200, json.dumps({'frame': remote_frame}).encode(), {'content-type': 'application/json'}

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=mock_fetch)):
        response = await async_client.get(f'/api/frames/{frame.id}/sync')

    assert response.status_code == 200
    sync = response.json()['sync']
    assert sync['has_changes'] is False
    assert sync['sections'][0]['changes'] == []
    assert sync['sections'][1]['changes'] == []


def test_frame_sync_scene_diff_ignores_editor_layout_noise():
    backend_scene = {
        'id': 'scene-1',
        'name': 'Calendar',
        'settings': {'execution': 'interpreted', 'refreshInterval': 300},
        'nodes': [
            {
                'id': 'node-1',
                'type': 'app',
                'position': {'x': 189.39661853806825, 'y': -941.1436002264414},
                'positionAbsolute': {'x': 189.39661853806825, 'y': -941.1436002264414},
                'width': 237,
                'height': 134,
                'selected': False,
                'dragging': False,
                'data': {'keyword': 'render/text', 'config': {'text': 'Calendar'}},
            }
        ],
        'edges': [],
    }
    frame_scene = {
        **backend_scene,
        'nodes': [
            {
                'id': 'node-1',
                'type': 'app',
                'position': {'x': 0, 'y': 12},
                'data': {'keyword': 'render/text', 'config': {'text': 'Calendar'}},
            }
        ],
    }

    section = frame_sync._build_scene_sync_section({'scenes': [backend_scene]}, {'scenes': [frame_scene]})

    assert section['changes'] == []


def test_frame_sync_scene_diff_reports_semantic_scene_changes():
    backend_scene = {
        'id': 'scene-1',
        'name': 'Calendar',
        'settings': {'execution': 'interpreted', 'refreshInterval': 300},
        'nodes': [
            {
                'id': 'node-1',
                'type': 'app',
                'position': {'x': 189.39661853806825, 'y': -941.1436002264414},
                'width': 237,
                'height': 134,
                'data': {'keyword': 'render/text', 'config': {'text': 'Calendar'}},
            }
        ],
        'edges': [],
    }
    frame_scene = {
        **backend_scene,
        'nodes': [
            {
                'id': 'node-1',
                'type': 'app',
                'position': {'x': 0, 'y': 12},
                'data': {'keyword': 'render/text', 'config': {'text': 'Frame Calendar'}},
            }
        ],
    }

    section = frame_sync._build_scene_sync_section({'scenes': [backend_scene]}, {'scenes': [frame_scene]})

    assert len(section['changes']) == 1
    assert section['changes'][0]['backend_json'] == backend_scene
    assert section['changes'][0]['frame_json'] == frame_scene
    details = section['changes'][0]['details']
    assert details == [
        {
            'path': 'Node render/text config.text',
            'backend': 'Calendar',
            'frame': 'Frame Calendar',
        }
    ]
    assert 'scene-1' not in details[0]['path']
    assert 'nodes[0]' not in details[0]['path']


@pytest.mark.asyncio
async def test_api_frame_sync_status_filters_runtime_and_deploy_noise(async_client, db, redis):
    frame = await new_frame(db, redis, 'Noise Backend', 'localhost', 'localhost')
    frame.frame_admin_auth = {'enabled': True, 'user': 'admin', 'pass': 'secret'}
    frame.https_proxy = {
        'enable': True,
        'port': 8443,
        'expose_only_port': True,
        'certs': {
            'server': 'server-cert',
            'server_key': 'server-key',
            'client_ca': 'client-ca',
        },
        'server_cert_not_valid_after': '2028-06-15T00:17:50+00:00',
        'client_ca_cert_not_valid_after': '2036-03-10T00:17:50+00:00',
    }
    frame.ssh_user = 'marius'
    frame.ssh_keys = ['default', 'secondary']
    frame.timezone_updater = {'enabled': True}
    frame.log_to_file = None
    frame.device_config = {
        'queryParam': 'images',
        'uploadMethod': 'POST',
    }
    frame.reboot = {'enabled': False, 'crontab': '0 0 * * *'}
    frame.control_code = {'enabled': 'false', 'size': '5', 'offsetX': '0', 'offsetY': '0'}
    frame.schedule = {'disabled': False, 'events': []}
    frame.gpio_buttons = [{'pin': '5', 'label': 'Pin 5'}]
    frame.network = {
        'agent': True,
        'agentConnection': True,
        'agentEnabled': True,
        'agentSharedSecret': 'legacy-secret',
        'reverseProxyEnabled': True,
        'reverseProxyTlsCert': 'cert',
        'reverseProxyTlsKey': 'key',
    }
    frame.agent = {
        'agentEnabled': False,
        'agentVersion': '2026.6.24',
        'remoteCapabilities': {'restart': True},
        'deployWithAgent': False,
    }
    frame.buildroot = {'readonly': True}
    frame.rpios = {'compilationMode': 'precompiled'}
    frame.scenes = []
    db.add(frame)
    db.commit()

    remote_frame = {
        **frame.to_dict(),
        'id': 1,
        'ssh_user': '',
        'ssh_keys': [],
        'timezone_updater': None,
        'log_to_file': '',
        'https_proxy': {
            'enable': True,
            'port': 8443,
            'expose_only_port': True,
            'certs': {
                'server': 'server-cert',
                'server_key': 'server-key',
                'client_ca': '',
            },
            'server_cert_not_valid_after': None,
            'client_ca_cert_not_valid_after': None,
        },
        'device_config': {
            'partial': False,
            'partialMaxAreaPercent': 0,
            'partialMaxRefreshesBeforeFull': 0,
            'vcom': 0,
        },
        'reboot': None,
        'control_code': {
            'enabled': False,
            'size': 5,
            'padding': 1,
            'offsetX': 0,
            'offsetY': 0,
            'qrCodeColor': '#000000',
            'backgroundColor': '#FFFFFF',
        },
        'schedule': {'events': []},
        'gpio_buttons': [{'pin': 5}],
        'network': {},
        'agent': {
            'agentEnabled': False,
            'agentRunCommands': False,
            'agentSharedSecret': '',
        },
        'palette': {},
        'buildroot': None,
        'rpios': None,
        'frame_sync': {
            'frame_config_modified_at': '2026-06-28T10:00:00Z',
            'scenes_modified_at': '2026-06-28T10:01:00Z',
        },
    }

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET", body=None, headers=None):
        if path == '/api/admin/login':
            return _sync_admin_login_response()
        assert headers and 'Cookie' in headers
        assert path == '/api/frames/1'
        return 200, json.dumps({'frame': remote_frame}).encode(), {'content-type': 'application/json'}

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=mock_fetch)):
        response = await async_client.get(f'/api/frames/{frame.id}/sync')

    assert response.status_code == 200
    sync = response.json()['sync']
    assert sync['has_changes'] is False
    assert sync['sections'][0]['changes'] == []
    assert sync['sections'][1]['changes'] == []


@pytest.mark.asyncio
async def test_api_frame_sync_status_repairs_synced_baseline_missing_frameos_version(async_client, db, redis):
    frame = await new_frame(db, redis, 'Synced No Version', 'localhost', 'localhost')
    frame.frame_admin_auth = {'enabled': True, 'user': 'admin', 'pass': 'secret'}
    frame.scenes = [{'id': 'scene-1', 'name': 'Scene 1', 'nodes': [], 'edges': []}]
    baseline = frame.to_dict()
    baseline.pop('last_successful_deploy', None)
    baseline.pop('last_successful_deploy_at', None)
    baseline.pop('frameos_version', None)
    frame.last_successful_deploy = baseline
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.add(frame)
    db.commit()

    remote_frame = {
        **frame.to_dict(),
        'id': 1,
        'frame_sync': {
            'frame_config_modified_at': '2026-06-28T10:00:00Z',
            'scenes_modified_at': '2026-06-28T10:01:00Z',
        },
    }

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET", body=None, headers=None):
        if path == '/api/admin/login':
            return _sync_admin_login_response()
        assert headers and 'Cookie' in headers
        assert path == '/api/frames/1'
        return 200, json.dumps({'frame': remote_frame}).encode(), {'content-type': 'application/json'}

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=mock_fetch)):
        response = await async_client.get(f'/api/frames/{frame.id}/sync')

    assert response.status_code == 200
    payload = response.json()
    assert payload['sync']['has_changes'] is False
    assert payload['frame']['last_successful_deploy']['frameos_version'] == frames_api.current_frameos_version()
    assert payload['frame']['last_successful_deploy_at'] == '2026-01-01T00:00:00+00:00'
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.last_successful_deploy['frameos_version'] == frames_api.current_frameos_version()
    assert updated_frame.last_successful_deploy_at == datetime(2026, 1, 1)


@pytest.mark.asyncio
async def test_api_frame_sync_apply_imports_frame_copy_and_marks_baseline(async_client, db, redis):
    frame = await new_frame(db, redis, 'Backend Name', 'localhost', 'localhost')
    frame.frame_admin_auth = {'enabled': True, 'user': 'admin', 'pass': 'secret'}
    frame.scenes = [{'id': 'scene-1', 'name': 'Backend scene', 'nodes': [], 'edges': []}]
    frame.last_successful_deploy = frame.to_dict()
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.add(frame)
    db.commit()

    remote_scenes = [{'id': 'scene-2', 'name': 'Frame scene', 'nodes': [], 'edges': []}]
    posted_payloads = []

    def remote_frame_payload():
        return {
            **frame.to_dict(),
            'id': 1,
            'name': 'Frame Name',
            'scenes': remote_scenes,
            'frame_sync': {
                'frame_config_modified_at': '2026-06-28T10:00:00Z',
                'scenes_modified_at': '2026-06-28T10:01:00Z',
            },
        }

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET", body=None, headers=None):
        if path == '/api/admin/login':
            return _sync_admin_login_response()
        assert headers and 'Cookie' in headers
        assert path == '/api/frames/1'
        if method == 'POST':
            posted_payloads.append(json.loads(body))
            return 200, b'{"message":"ok"}', {'content-type': 'application/json'}
        return 200, json.dumps({'frame': remote_frame_payload()}).encode(), {'content-type': 'application/json'}

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=mock_fetch)):
        response = await async_client.post(
            f'/api/frames/{frame.id}/sync',
            json={'frame_json': 'frame', 'scenes_json': 'frame'},
        )

    assert response.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.name == 'Frame Name'
    assert updated_frame.scenes == remote_scenes
    assert updated_frame.last_successful_deploy_at is not None
    assert updated_frame.last_successful_deploy['name'] == 'Frame Name'
    assert updated_frame.last_successful_deploy['scenes'] == remote_scenes
    assert updated_frame.last_successful_deploy['frameos_version'] == frames_api.current_frameos_version()
    assert response.json()['sync']['has_changes'] is False
    assert posted_payloads[-1]['last_successful_deploy']['name'] == 'Frame Name'
    assert posted_payloads[-1]['last_successful_deploy']['frameos_version'] == frames_api.current_frameos_version()
    assert posted_payloads[-1]['frame_sync_mark_deployed'] is True
    assert posted_payloads[-1]['skip_runtime_reload'] is True


@pytest.mark.asyncio
async def test_api_frame_sync_apply_resolves_individual_items_and_keeps_both_scene_versions(async_client, db, redis):
    frame = await new_frame(db, redis, 'Backend Name', 'localhost', 'localhost')
    frame.frame_admin_auth = {'enabled': True, 'user': 'admin', 'pass': 'secret'}
    frame.interval = 300
    frame.scenes = [
        {
            'id': 'scene-1',
            'name': 'Backend scene',
            'nodes': [{'id': 'node-1', 'type': 'event'}],
            'edges': [],
        }
    ]
    frame.last_successful_deploy = frame.to_dict()
    frame.last_successful_deploy_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.add(frame)
    db.commit()

    remote_frame = {
        **frame.to_dict(),
        'id': 1,
        'name': 'Frame Name',
        'interval': 600,
        'scenes': [
            {
                'id': 'scene-1',
                'name': 'Frame scene',
                'nodes': [{'id': 'node-2', 'type': 'event'}],
                'edges': [],
            }
        ],
        'frame_sync': {
            'frame_config_modified_at': '2026-06-28T10:00:00Z',
            'scenes_modified_at': '2026-06-28T10:01:00Z',
        },
    }
    posted_payloads = []

    async def mock_fetch(frame_obj, redis_obj, *, path, method="GET", body=None, headers=None):
        if path == '/api/admin/login':
            return _sync_admin_login_response()
        assert headers and 'Cookie' in headers
        assert path == '/api/frames/1'
        if method == 'POST':
            payload = json.loads(body)
            posted_payloads.append(payload)
            for key, value in payload.items():
                if key != 'skip_runtime_reload':
                    remote_frame[key] = value
            return 200, b'{"message":"ok"}', {'content-type': 'application/json'}
        return 200, json.dumps({'frame': remote_frame}).encode(), {'content-type': 'application/json'}

    with patch('app.api.frames._fetch_frame_http_bytes', new=AsyncMock(side_effect=mock_fetch)):
        response = await async_client.post(
            f'/api/frames/{frame.id}/sync',
            json={
                'frame_json_choices': {'name': 'frame', 'interval': 'backend'},
                'scenes_json_choices': {'scene-1': 'both'},
            },
        )

    assert response.status_code == 200
    db.expire_all()
    updated_frame = db.get(Frame, frame.id)
    assert updated_frame.name == 'Frame Name'
    assert updated_frame.interval == 300
    assert len(updated_frame.scenes) == 2
    assert updated_frame.scenes[0]['id'] == 'scene-1'
    assert updated_frame.scenes[0]['name'] == 'Backend scene'
    assert updated_frame.scenes[1]['id'] != 'scene-1'
    assert updated_frame.scenes[1]['name'] == 'Frame scene (frame copy)'

    sync_write = next(payload for payload in posted_payloads if 'scenes' in payload)
    assert sync_write['interval'] == 300
    assert sync_write['scenes'] == updated_frame.scenes
    assert remote_frame['name'] == 'Frame Name'
    assert remote_frame['interval'] == 300
    assert remote_frame['scenes'] == updated_frame.scenes
    assert response.json()['sync']['has_changes'] is False
    assert updated_frame.last_successful_deploy_at is not None
    assert posted_payloads[-1]['frame_sync_mark_deployed'] is True


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
async def test_api_frame_new_preserves_device_config(async_client):
    payload = {
        "name": "PartialFrame",
        "frame_host": "myhost",
        "server_host": "myserver",
        "device": "waveshare.EPD_13in3b",
        "device_config": {"partial": True},
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    frame = response.json()['frame']
    assert frame['device'] == 'waveshare.EPD_13in3b'
    assert frame['device_config']['partial'] is True


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
async def test_api_frame_new_embedded_waveshare_13in3e6_preset(async_client):
    payload = {
        "mode": "embedded",
        "name": "WaveshareFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "esp32-s3",
        "embedded": {"hardwarePreset": "waveshare_esp32_s3_epaper_13_3e6"},
        "network": {"wifiSSID": "", "wifiPassword": ""},
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    frame = response.json()['frame']
    assert frame['mode'] == 'embedded'
    assert frame['frame_port'] == 80
    assert frame['device'] == 'waveshare.EPD_13in3e'
    assert frame['embedded']['platform'] == 'esp32-s3'
    assert frame['embedded']['hardwarePreset'] == 'waveshare_esp32_s3_epaper_13_3e6'
    assert frame['embedded']['flashSize'] == '32MB'
    assert frame['device_config']['hardwarePreset'] == 'waveshare_esp32_s3_epaper_13_3e6'
    assert frame['device_config']['psramMB'] == 16
    assert frame['device_config']['pins'] == {
        'rst': 10,
        'dc': 7,
        'cs': 1,
        'cs2': 4,
        'busy': 8,
        'sck': 6,
        'mosi': 5,
        'pwr': 16,
    }
    assert frame['device_config']['sdCardAssets'] == {
        'enabled': True,
        'preset': 'waveshare_esp32_s3_epaper_13_3e6',
        'mountPath': '/srv/assets',
        'pins': {'cs': 3, 'sck': 44, 'miso': 43, 'mosi': 2},
        'maxFrequencyKHz': 20000,
    }


@pytest.mark.asyncio
async def test_api_frame_new_embedded_waveshare_photopainter_preset(async_client):
    payload = {
        "mode": "embedded",
        "name": "PhotoPainter",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "esp32-s3",
        "embedded": {"hardwarePreset": "waveshare_esp32_s3_photopainter"},
        "network": {"wifiSSID": "", "wifiPassword": ""},
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    frame = response.json()['frame']
    assert frame['mode'] == 'embedded'
    assert frame['device'] == 'waveshare.EPD_7in3e'
    assert frame['embedded']['platform'] == 'esp32-s3'
    assert frame['embedded']['hardwarePreset'] == 'waveshare_esp32_s3_photopainter'
    assert frame['embedded']['flashSize'] == '16MB'
    assert frame['device_config']['hardwarePreset'] == 'waveshare_esp32_s3_photopainter'
    assert frame['device_config']['psramMB'] == 8
    assert frame['device_config']['pins'] == {
        'rst': 12,
        'dc': 8,
        'cs': 9,
        'cs2': -1,
        'busy': 13,
        'sck': 10,
        'mosi': 11,
        'pwr': -1,
    }
    assert frame['device_config']['sdCardAssets'] == {
        'enabled': True,
        'preset': 'waveshare_esp32_s3_photopainter',
        'mountPath': '/srv/assets',
        'pins': {'cs': 38, 'sck': 39, 'miso': 40, 'mosi': 41},
        'maxFrequencyKHz': 20000,
    }


@pytest.mark.asyncio
async def test_api_frame_new_buildroot_accepts_root_password_and_ssh_keys(async_client):
    payload = {
        "mode": "buildroot",
        "name": "BuildrootFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "raspberry-pi-zero-2-w",
        "network": {"wifiSSID": "", "wifiPassword": ""},
        "ssh_pass": "secret-root-password",
        "ssh_keys": ["main", "main", "", "backup"],
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    frame = response.json()['frame']
    assert frame['mode'] == 'buildroot'
    assert frame['ssh_pass'] == 'secret-root-password'
    assert frame['ssh_keys'] == ["main", "backup"]


@pytest.mark.asyncio
async def test_api_frame_new_buildroot_preserves_empty_ssh_key_selection(async_client):
    payload = {
        "mode": "buildroot",
        "name": "BuildrootFrame",
        "frame_host": "",
        "server_host": "backend.local",
        "platform": "raspberry-pi-zero-2-w",
        "network": {"wifiSSID": "", "wifiPassword": ""},
        "ssh_keys": [],
    }

    response = await async_client.post('/api/frames/new', json=payload)

    assert response.status_code == 200
    assert response.json()['frame']['ssh_keys'] == []


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
async def test_api_frame_buildroot_sd_image_accepts_configured_build_host(async_client, db, redis, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.network = {
        **(frame.network or {}),
        'wifiSSID': 'Test WiFi',
        'wifiPassword': 'secret1234',
    }
    frame.buildroot = {'platform': 'raspberry-pi-zero-2-w'}
    db.add(Settings(project_id=frame.project_id, key='buildEnvironment', value={'provider': 'buildHost'}))
    db.add(
        Settings(
            project_id=frame.project_id,
            key='buildHost',
            value={
                'enabled': True,
                'host': 'builder.local',
                'user': 'ubuntu',
                'sshKey': 'dummy-key',
            },
        )
    )
    db.add(frame)
    db.commit()
    captured: list[int] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append(id)

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured == [frame.id]


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_allows_precompiled_when_build_environment_is_none(
    async_client, db, redis, monkeypatch
):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.buildroot = {'platform': 'raspberry-pi-zero-2-w', 'compilationMode': 'precompiled'}
    frame.scenes = [{'id': 'scene-1', 'settings': {'execution': 'interpreted'}}]
    db.add(Settings(project_id=frame.project_id, key='buildEnvironment', value={'provider': 'none'}))
    db.add(frame)
    db.commit()
    captured: list[int] = []

    async def fake_buildroot_sd_image(id, _redis, *, request_id=None, queue_job_id=None):
        captured.append(id)

    monkeypatch.setattr(buildroot_image_module, "buildroot_sd_image", fake_buildroot_sd_image)

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['message'] == 'Buildroot SD card image preparation started'
    assert captured == [frame.id]


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_rejects_source_build_when_build_environment_is_none(
    async_client, db, redis
):
    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.buildroot = {'platform': 'raspberry-pi-zero-2-w', 'compilationMode': 'static'}
    db.add(Settings(project_id=frame.project_id, key='buildEnvironment', value={'provider': 'none'}))
    db.add(frame)
    db.commit()

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 400
    assert 'precompiled Buildroot SD image mode' in response.json()['detail']


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_hassio_rejects_source_build_with_container_message(
    async_client, db, redis, monkeypatch
):
    monkeypatch.setenv("HASSIO_RUN_MODE", "ingress")
    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.buildroot = {'platform': 'raspberry-pi-zero-2-w', 'compilationMode': 'static'}
    db.add(frame)
    db.commit()

    response = await async_client.post(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 400
    detail = response.json()['detail']
    assert 'Home Assistant add-on' in detail
    assert 'existing add-on container' in detail
    assert 'Docker' not in detail


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_status_allows_precompiled_when_base_manifest_is_unavailable(
    async_client, db, redis, monkeypatch
):
    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    frame.buildroot = {'platform': 'raspberry-pi-zero-2-w', 'compilationMode': 'precompiled'}
    frame.scenes = []
    db.add(frame)
    db.commit()

    async def fake_resolve_buildroot_base_entry(*_args, **_kwargs):
        raise RuntimeError('base manifest unavailable')

    monkeypatch.setattr(frames_api, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)

    response = await async_client.get(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    assert response.json()['sdImage']['status'] == 'idle'


@pytest.mark.asyncio
async def test_api_frame_buildroot_sd_image_status_marks_inactive_build_failed(async_client, db, redis, monkeypatch):
    import app.tasks.buildroot_image as buildroot_image_module

    frame = await new_frame(db, redis, 'BuildrootFrame', 'frame.local', 'backend.local')
    frame.mode = 'buildroot'
    stale_at = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
    frame.buildroot = {
        'platform': 'raspberry-pi-zero-2-w',
        'sdImage': {
            'status': 'building',
            'requestId': 'request123',
            'queueJobId': 'buildroot_sd_image:1:request123',
            'startedAt': stale_at,
            'lastHeartbeatAt': stale_at,
        },
    }
    db.add(frame)
    db.commit()

    async def fake_resolve_buildroot_base_entry(*_args, **_kwargs):
        return None

    async def fake_queue_job_active(*_args, **_kwargs):
        return False

    monkeypatch.setattr(frames_api, "resolve_buildroot_base_entry", fake_resolve_buildroot_base_entry)
    monkeypatch.setattr(buildroot_image_module, "_buildroot_sd_image_queue_job_active", fake_queue_job_active)

    response = await async_client.get(f'/api/frames/{frame.id}/buildroot/sd_image')

    assert response.status_code == 200
    sd_image = response.json()['sdImage']
    assert sd_image['status'] == 'error'
    assert 'stopped updating' in sd_image['error']
    db.expire_all()
    stored = db.get(Frame, frame.id).buildroot['sdImage']
    assert stored['status'] == 'error'
    assert 'completedAt' in stored


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
async def test_api_frame_upload_image_updates_cache_and_scene(async_client, db, redis):
    frame = await new_frame(db, redis, 'UsbImageFrame', 'example.com', 'localhost')
    frame.scenes = [{'id': 'scene-1', 'name': 'Scene 1', 'nodes': [], 'edges': []}]
    db.add(frame)
    db.commit()

    image = Image.new('RGB', (4, 3), (255, 255, 255))
    png_buffer = io.BytesIO()
    image.save(png_buffer, format='PNG')
    png = png_buffer.getvalue()

    with patch('app.api.frames.publish_message', new_callable=AsyncMock) as publish:
        response = await async_client.post(
            f'/api/frames/{frame.id}/image?scene_id=scene-1',
            content=png,
            headers={'Content-Type': 'image/png'},
        )

    assert response.status_code == 200, response.text
    assert response.json()['message'] == 'Frame image updated'
    assert response.json()['sceneId'] == 'scene-1'
    assert await redis.get(frames_api._frame_image_cache_key(frame.id)) == png

    stored_scene_image = (
        db.query(SceneImage)
        .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id='scene-1')
        .first()
    )
    assert stored_scene_image is not None
    assert stored_scene_image.image == png
    assert stored_scene_image.width == 4
    assert stored_scene_image.height == 3

    published_events = [call.args[1] for call in publish.await_args_list]
    assert published_events == ['new_scene_image', 'frame_rendered']


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
