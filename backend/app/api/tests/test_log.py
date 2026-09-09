import gzip
import json

import pytest

from app import config as app_config
from app.models import new_frame, update_frame, Log

@pytest.mark.asyncio
async def test_api_log_single_entry(async_client, db, redis):
    # Create a frame with server_api_key
    frame = await new_frame(db, redis, 'LogFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    # Check the DB
    logs = db.query(Log).filter_by(frame_id=frame.id).all()
    # We have the welcome log plus the new one
    assert len(logs) == 2
    assert "banana" in logs[1].line

@pytest.mark.asyncio
async def test_api_log_multiple_entries(async_client, db, redis):
    frame = await new_frame(db, redis, 'MultiLogFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    data = {
        'logs': [
            {'event': 'log', 'message': 'banana'},
            {'event': 'log', 'message': 'pineapple'}
        ]
    }
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    logs = db.query(Log).filter_by(frame_id=frame.id).all()
    # 1 welcome + 2 new
    assert len(logs) == 3


@pytest.mark.asyncio
async def test_api_log_embedded_bootup_preserves_hostname_frame_host(async_client, db, redis):
    frame = await new_frame(db, redis, 'EmbeddedLogFrame', 'frame53.local', 'localhost')
    frame.mode = 'embedded'
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    data = {
        'log': {
            'event': 'bootup',
            'source': 'esp32',
            'ip': '10.8.0.232',
            'width': 800,
            'height': 480,
        }
    }
    response = await async_client.post('/api/log', json=data, headers=headers)

    assert response.status_code == 200
    db.refresh(frame)
    assert frame.frame_host == 'frame53.local'
    assert frame.width == 800
    assert frame.height == 480


@pytest.mark.asyncio
async def test_api_log_no_data(async_client, db, redis):
    frame = await new_frame(db, redis, 'NoDataFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    response = await async_client.post('/api/log', json={}, headers=headers)
    assert response.status_code == 200

@pytest.mark.asyncio
async def test_api_log_bad_key(async_client, db, redis):
    frame = await new_frame(db, redis, 'BadKeyFrame', 'localhost', 'localhost')
    frame.server_api_key = 'goodkey'
    await update_frame(db, redis, frame)

    headers = {'Authorization': 'Bearer wrongkey'}
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 401
    assert response.json()['detail'] == "Unauthorized"

@pytest.mark.asyncio
async def test_api_log_no_key(async_client, db, redis):
    frame = await new_frame(db, redis, 'NoKeyFrame', 'localhost', 'localhost')
    frame.server_api_key = 'somekey'
    await update_frame(db, redis, frame)

    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data)
    assert response.status_code == 401
    assert response.json()['detail'] == "Unauthorized"


@pytest.mark.asyncio
async def test_api_log_embedded_bootup_follows_ip_only_when_it_is_the_request_peer(async_client, db, redis, monkeypatch):
    frame = await new_frame(db, redis, 'EmbeddedIpFrame', '10.8.0.5', 'localhost')
    frame.mode = 'embedded'
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)
    headers = {'Authorization': 'Bearer testkey'}
    bootup = {'event': 'bootup', 'source': 'esp32', 'ip': '10.8.0.99'}

    # Claimed by the device but the request came from elsewhere: ignored.
    response = await async_client.post('/api/log', json={'log': bootup}, headers=headers)
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.frame_host == '10.8.0.5'

    # A forwarded header from the loopback test client is NOT enough: the
    # implicit private-range proxy trust would make every LAN device a
    # "proxy" that can vouch for any address (the spoof this closes).
    response = await async_client.post(
        '/api/log', json={'log': bootup}, headers={**headers, 'X-Forwarded-For': '10.8.0.99'}
    )
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.frame_host == '10.8.0.5'

    # Name the peer as a trusted proxy and its X-Forwarded-For counts.
    monkeypatch.setattr(app_config.config, "FRAMEOS_TRUSTED_PROXIES", "127.0.0.1, testclient")
    response = await async_client.post(
        '/api/log', json={'log': bootup}, headers={**headers, 'X-Forwarded-For': '10.8.0.99'}
    )
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.frame_host == '10.8.0.99'


@pytest.mark.asyncio
async def test_api_log_embedded_bootup_follows_any_ip_with_opt_in(async_client, db, redis):
    frame = await new_frame(db, redis, 'EmbeddedOptInFrame', '10.8.0.5', 'localhost')
    frame.mode = 'embedded'
    frame.embedded = {'followBootIp': True}
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)

    response = await async_client.post(
        '/api/log',
        json={'log': {'event': 'bootup', 'source': 'esp32', 'ip': '10.8.0.42'}},
        headers={'Authorization': 'Bearer testkey'},
    )
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.frame_host == '10.8.0.42'


@pytest.mark.asyncio
async def test_api_log_bootup_never_moves_a_non_embedded_frame(async_client, db, redis):
    frame = await new_frame(db, redis, 'PiFrame', '10.8.0.5', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)

    response = await async_client.post(
        '/api/log',
        json={'log': {'event': 'bootup', 'ip': '10.8.0.99'}},
        headers={'Authorization': 'Bearer testkey', 'X-Forwarded-For': '10.8.0.99'},
    )
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.frame_host == '10.8.0.5'


@pytest.mark.asyncio
async def test_api_log_bad_key_is_rejected_before_the_body_is_parsed(async_client, db, redis):
    frame = await new_frame(db, redis, 'EarlyAuthFrame', 'localhost', 'localhost')
    frame.server_api_key = 'goodkey'
    await update_frame(db, redis, frame)

    # An invalid body would be a 422 once parsed; the key is checked first.
    response = await async_client.post(
        '/api/log', content=b'not json', headers={'Authorization': 'Bearer wrongkey', 'Content-Type': 'application/json'}
    )
    assert response.status_code == 401
    response = await async_client.post(
        '/api/log',
        content=b'{}',
        headers={'Authorization': 'Bearer goodkey', 'Content-Type': 'application/json', 'Content-Length': str(10 * 1024 * 1024)},
    )
    assert response.status_code == 413


@pytest.mark.asyncio
async def test_api_log_caps_batch_size_and_line_length(async_client, db, redis, monkeypatch):
    from app.api import log as log_module

    frame = await new_frame(db, redis, 'CapsFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)
    headers = {'Authorization': 'Bearer testkey'}

    monkeypatch.setattr(log_module, "MAX_LOG_ENTRIES_PER_BATCH", 3)
    logs = [{'event': 'log', 'message': f'line {i}'} for i in range(4)]
    response = await async_client.post('/api/log', json={'logs': logs}, headers=headers)
    assert response.status_code == 413
    response = await async_client.post('/api/log', json={'logs': logs[:3]}, headers=headers)
    assert response.status_code == 200

    long_line = {'event': 'log', 'message': 'x' * (log_module.MAX_LOG_LINE_BYTES + 1)}
    response = await async_client.post('/api/log', json={'log': long_line}, headers=headers)
    assert response.status_code == 413
    response = await async_client.post('/api/log', json={'logs': [long_line]}, headers=headers)
    assert response.status_code == 413
    assert db.query(Log).filter_by(frame_id=frame.id).count() == 1 + 3


@pytest.mark.asyncio
async def test_api_log_rate_limited_per_frame(async_client, db, redis, monkeypatch):
    from app.api import log as log_module

    frame = await new_frame(db, redis, 'RateFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)
    other = await new_frame(db, redis, 'OtherRateFrame', 'localhost', 'localhost')
    other.server_api_key = 'otherkey'
    await update_frame(db, redis, other)

    monkeypatch.setattr(log_module, "LOG_REQUESTS_PER_MINUTE", 2)
    headers = {'Authorization': 'Bearer testkey'}
    for _ in range(2):
        assert (await async_client.post('/api/log', json={}, headers=headers)).status_code == 200
    assert (await async_client.post('/api/log', json={}, headers=headers)).status_code == 429
    # Per key: another frame is unaffected.
    assert (await async_client.post('/api/log', json={}, headers={'Authorization': 'Bearer otherkey'})).status_code == 200


@pytest.mark.asyncio
async def test_gzip_body_over_the_cap_is_rejected_before_decompression(async_client, db, redis, monkeypatch):
    from app import middleware

    frame = await new_frame(db, redis, 'GzipFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)
    headers = {'Authorization': 'Bearer testkey', 'Content-Encoding': 'gzip', 'Content-Type': 'application/json'}
    body = gzip.compress(json.dumps({'log': {'event': 'log', 'message': 'zipped'}}).encode())

    response = await async_client.post('/api/log', content=body, headers=headers)
    assert response.status_code == 200

    monkeypatch.setattr(middleware, "MAX_DECOMPRESSED_BODY", len(body) - 1)
    response = await async_client.post('/api/log', content=body, headers=headers)
    assert response.status_code == 413



@pytest.mark.asyncio
async def test_api_log_bootup_version_updates_a_shell_less_frames_baseline(async_client, db, redis):
    """An adopted generic card upgrades itself and the runtime says which
    FrameOS it booted; the deploy baseline's version follows, nothing else
    in the baseline moves, and a frame the backend can deploy to ignores it."""
    frame = await new_frame(db, redis, 'AdoptedCard', 'localhost', 'localhost')
    frame.mode = 'buildroot'
    frame.buildroot = {'adopted': True, 'platform': 'raspberry-pi-64'}
    frame.ssh_keys = []
    frame.ssh_pass = None
    frame.server_api_key = 'testkey'
    frame.last_successful_deploy = {'name': 'AdoptedCard', 'frameos_version': '2026.9.11'}
    await update_frame(db, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    response = await async_client.post('/api/log', json={'log': {'event': 'bootup', 'version': '2026.9.12'}}, headers=headers)
    assert response.status_code == 200
    db.refresh(frame)
    assert frame.last_successful_deploy == {'name': 'AdoptedCard', 'frameos_version': '2026.9.12'}

    shell = await new_frame(db, redis, 'SshFrame', 'localhost', 'localhost')
    shell.server_api_key = 'sshkey'
    shell.ssh_pass = 'raspberry'
    shell.last_successful_deploy = {'name': 'SshFrame', 'frameos_version': '2026.9.11'}
    await update_frame(db, redis, shell)
    response = await async_client.post('/api/log', json={'log': {'event': 'bootup', 'version': '2026.9.12'}},
                                       headers={'Authorization': 'Bearer sshkey'})
    assert response.status_code == 200
    db.refresh(shell)
    assert shell.last_successful_deploy['frameos_version'] == '2026.9.11'


@pytest.mark.asyncio
async def test_api_log_rejects_malformed_entries_before_writing_anything(async_client, db, redis):
    """`log`/`logs` were typed Any and shape-checked by an `assert` AFTER the
    row was committed (and `-O` strips asserts): junk rows for every typo."""
    frame = await new_frame(db, redis, 'ShapeFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db, redis, frame)
    headers = {'Authorization': 'Bearer testkey'}
    before = db.query(Log).filter_by(frame_id=frame.id).count()

    for body in (
        {'log': 'banana'},
        {'log': ['not-a-timestamp', {'event': 'log'}]},
        {'log': [1.0, 'not-a-dict']},
        {'logs': [{'event': 'log'}, 42]},
        {'logs': 'banana'},
    ):
        response = await async_client.post('/api/log', json=body, headers=headers)
        assert response.status_code == 422, (body, response.text)

    assert db.query(Log).filter_by(frame_id=frame.id).count() == before

    # The batched `[timestamp, entry]` form is still fine.
    response = await async_client.post('/api/log', json={'logs': [[1700000000, {'event': 'log', 'message': 'ok'}]]}, headers=headers)
    assert response.status_code == 200, response.text
    assert db.query(Log).filter_by(frame_id=frame.id).count() == before + 1
