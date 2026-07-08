import asyncio
import json

import pytest

from app.ha import HA_SYNC_CHANNEL


async def next_pubsub_message(pubsub, timeout=5.0):
    async def read():
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
            if message is not None:
                return message
    return await asyncio.wait_for(read(), timeout)


@pytest.mark.asyncio
async def test_get_settings(async_client):
    response = await async_client.get('/api/settings')
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, dict)
    assert data["personal"]["favouriteTemplateIds"] == []


@pytest.mark.asyncio
async def test_set_settings(async_client):
    payload = {"some_setting": "hello"}
    response = await async_client.post('/api/settings', json=payload)
    assert response.status_code == 200, f"Got {response.status_code} and {response.json()}"
    updated = response.json()
    assert updated["some_setting"] == "hello"


@pytest.mark.asyncio
async def test_set_personal_favourite_templates(async_client):
    payload = {"personal": {"favouriteTemplateIds": ["local:abc", "repository:https://repo.example/scenes.json:template:clock"]}}
    response = await async_client.post('/api/settings', json=payload)
    assert response.status_code == 200, f"Got {response.status_code} and {response.json()}"
    assert response.json()["personal"]["favouriteTemplateIds"] == payload["personal"]["favouriteTemplateIds"]

    response = await async_client.get('/api/settings')
    assert response.status_code == 200
    assert response.json()["personal"]["favouriteTemplateIds"] == payload["personal"]["favouriteTemplateIds"]


@pytest.mark.asyncio
async def test_set_settings_normalizes_build_environment_enabled_flags(async_client):
    payload = {
        "buildEnvironment": {"provider": "modal"},
        "buildHost": {"enabled": True, "host": "builder.local"},
        "modalSandbox": {"tokenId": "ak-test", "tokenSecret": "as-test"},
    }
    response = await async_client.post('/api/settings', json=payload)
    assert response.status_code == 200, f"Got {response.status_code} and {response.json()}"
    updated = response.json()
    assert updated["buildHost"]["enabled"] is False
    assert updated["modalSandbox"]["enabled"] is True


@pytest.mark.asyncio
async def test_set_settings_normalizes_partial_provider_settings_from_current_settings(async_client):
    initial_response = await async_client.post(
        '/api/settings',
        json={
            "buildEnvironment": {"provider": "buildHost"},
            "buildHost": {"enabled": True, "host": "builder.local"},
        },
    )
    assert initial_response.status_code == 200, (
        f"Got {initial_response.status_code} and {initial_response.json()}"
    )

    response = await async_client.post('/api/settings', json={"buildHost": {"host": "builder-2.local"}})
    assert response.status_code == 200, f"Got {response.status_code} and {response.json()}"
    updated = response.json()
    assert updated["buildEnvironment"]["provider"] == "buildHost"
    assert updated["buildHost"]["enabled"] is True
    assert updated["buildHost"]["host"] == "builder-2.local"


@pytest.mark.asyncio
async def test_set_settings_no_payload(async_client):
    response = await async_client.post('/api/settings', json={})
    assert response.status_code == 400
    assert response.json()['detail'] == "No JSON payload received"


@pytest.mark.asyncio
async def test_set_home_assistant_settings_notifies_sync_service(async_client, redis):
    pubsub = redis.pubsub()
    await pubsub.subscribe(HA_SYNC_CHANNEL)
    try:
        response = await async_client.post('/api/settings', json={"homeAssistant": {"syncEnabled": True}})
        assert response.status_code == 200, f"Got {response.status_code} and {response.json()}"
        assert response.json()["homeAssistant"]["syncEnabled"] is True

        message = await next_pubsub_message(pubsub)
        assert json.loads(message["data"])["event"] == "settings_changed"
    finally:
        await pubsub.unsubscribe(HA_SYNC_CHANNEL)
        await pubsub.close()


@pytest.mark.asyncio
async def test_home_assistant_sync_now_requires_sync_enabled(async_client):
    response = await async_client.post('/api/settings/home_assistant/sync')
    assert response.status_code == 400
    assert response.json()["detail"] == "Enable 'Share frames with Home Assistant' first"


@pytest.mark.asyncio
async def test_home_assistant_sync_now_publishes_sync_message(async_client, redis):
    response = await async_client.post('/api/settings', json={"homeAssistant": {"syncEnabled": True}})
    assert response.status_code == 200

    pubsub = redis.pubsub()
    await pubsub.subscribe(HA_SYNC_CHANNEL)
    try:
        response = await async_client.post('/api/settings/home_assistant/sync')
        assert response.status_code == 200, f"Got {response.status_code} and {response.json()}"
        assert response.json() == {"ok": True}

        message = await next_pubsub_message(pubsub)
        assert json.loads(message["data"])["event"] == "sync_now"
    finally:
        await pubsub.unsubscribe(HA_SYNC_CHANNEL)
        await pubsub.close()


@pytest.mark.asyncio
async def test_modal_sandbox_test_requires_credentials(async_client):
    response = await async_client.post('/api/settings/test_modal_sandbox', json={"modalSandbox": {"enabled": True}})

    assert response.status_code == 400
    assert response.json()["detail"] == "Select Modal sandboxes and enter a token ID and token secret first"


@pytest.mark.asyncio
async def test_build_host_test_requires_credentials(async_client):
    response = await async_client.post('/api/settings/test_build_host', json={"buildHost": {"host": "builder.local"}})

    assert response.status_code == 400
    assert response.json()["detail"] == "Select build host via SSH and enter a host, user, and private SSH key first"


@pytest.mark.asyncio
async def test_build_host_test_runs_probe(async_client, monkeypatch):
    class FakeBuildExecutor:
        def __init__(self, config, **kwargs):
            self.config = config
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def run(self, command, **kwargs):
            assert command == "echo frameos-build-host-ok && command -v docker >/dev/null && docker buildx version >/dev/null"
            assert kwargs["log_command"] is False
            assert kwargs["log_output"] is False
            return 0, "frameos-build-host-ok\n", None

    def fake_create_build_executor(config, **kwargs):
        assert config.host == "builder.local"
        assert config.user == "ubuntu"
        assert config.ssh_key == "dummy-key"
        assert kwargs["db"] is None
        assert kwargs["redis"] is None
        assert kwargs["frame"].id == 0
        assert kwargs["workspace_prefix"] == "frameos-build-host-test-"
        return FakeBuildExecutor(config, **kwargs)

    monkeypatch.setattr("app.api.settings.create_build_executor", fake_create_build_executor)

    response = await async_client.post(
        '/api/settings/test_build_host',
        json={
            "buildHost": {
                "host": "builder.local",
                "user": "ubuntu",
                "sshKey": "dummy-key",
            }
        },
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "output": "frameos-build-host-ok"}


@pytest.mark.asyncio
async def test_modal_sandbox_test_runs_probe(async_client, monkeypatch):
    class FakeBuildExecutor:
        def __init__(self, config, **kwargs):
            self.config = config
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def run(self, command, **kwargs):
            assert command == "command -v nimble && nimble --version >/dev/null && echo frameos-modal-sandbox-ok"
            assert kwargs["log_command"] is False
            assert kwargs["log_output"] is False
            return 0, "frameos-modal-sandbox-ok\n", None

    def fake_create_build_executor(config, **kwargs):
        assert config.token_id == "ak-test"
        assert config.token_secret == "as-test"
        assert kwargs["db"] is None
        assert kwargs["redis"] is None
        assert kwargs["frame"].id == 0
        return FakeBuildExecutor(config, **kwargs)

    monkeypatch.setattr("app.api.settings.create_build_executor", fake_create_build_executor)

    response = await async_client.post(
        '/api/settings/test_modal_sandbox',
        json={
            "modalSandbox": {
                "enabled": True,
                "tokenId": "ak-test",
                "tokenSecret": "as-test",
            }
        },
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "output": "frameos-modal-sandbox-ok"}
