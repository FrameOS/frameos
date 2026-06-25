from __future__ import annotations

import importlib
from types import SimpleNamespace

import pytest

from app.tasks.restart_remote import restart_remote, restart_remote_task


class FakeRedis:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue_job(self, name: str, **kwargs):
        self.jobs.append((name, kwargs))


@pytest.mark.asyncio
async def test_restart_remote_enqueues_transport():
    redis = FakeRedis()

    await restart_remote(7, redis, transport="remote")

    assert redis.jobs == [("restart_remote", {"id": 7, "transport": "remote"})]


@pytest.mark.asyncio
async def test_restart_remote_defaults_to_auto_transport():
    redis = FakeRedis()

    await restart_remote(7, redis)

    assert redis.jobs == [("restart_remote", {"id": 7, "transport": "auto"})]


@pytest.mark.asyncio
async def test_restart_remote_via_remote_schedules_delayed_restart(monkeypatch: pytest.MonkeyPatch):
    restart_remote_module = importlib.import_module("app.tasks.restart_remote")
    captured: dict[str, object] = {}

    async def fake_log(*_args, **_kwargs):
        return None

    async def fake_run_commands(_db, _redis, _frame, commands, **kwargs):
        captured["commands"] = commands
        captured["transport"] = kwargs.get("transport")

    monkeypatch.setattr(restart_remote_module, "log", fake_log)
    monkeypatch.setattr(restart_remote_module, "get_fresh_frame", lambda _db, _id: SimpleNamespace(id=1))
    monkeypatch.setattr(restart_remote_module, "run_commands", fake_run_commands)

    await restart_remote_task({"db": object(), "redis": object()}, id=1, transport="remote")

    assert captured["transport"] == "remote"
    command = captured["commands"][0]
    assert "systemd-run" in command
    assert "systemctl restart frameos-remote.service" in command
    assert "frameos_agent.service frameos-agent.service" in command
    assert "[f]rameos_agent" in command


@pytest.mark.asyncio
async def test_restart_remote_auto_uses_remote_when_frame_prefers_remote(monkeypatch: pytest.MonkeyPatch):
    restart_remote_module = importlib.import_module("app.tasks.restart_remote")
    captured: dict[str, object] = {}

    async def fake_log(*_args, **_kwargs):
        return None

    async def fake_run_commands(_db, _redis, _frame, commands, **kwargs):
        captured["commands"] = commands
        captured["transport"] = kwargs.get("transport")

    monkeypatch.setattr(restart_remote_module, "log", fake_log)
    monkeypatch.setattr(
        restart_remote_module,
        "get_fresh_frame",
        lambda _db, _id: SimpleNamespace(
            id=1,
            agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        ),
    )
    monkeypatch.setattr(restart_remote_module, "run_commands", fake_run_commands)

    await restart_remote_task({"db": object(), "redis": object()}, id=1)

    assert captured["transport"] == "remote"
    assert "systemd-run" in captured["commands"][0]


@pytest.mark.asyncio
async def test_restart_remote_via_ssh_cleans_up_legacy_remote(monkeypatch: pytest.MonkeyPatch):
    restart_remote_module = importlib.import_module("app.tasks.restart_remote")
    captured: dict[str, object] = {}

    async def fake_log(*_args, **_kwargs):
        return None

    async def fake_run_commands(_db, _redis, _frame, commands, **kwargs):
        captured["commands"] = commands
        captured["transport"] = kwargs.get("transport")

    monkeypatch.setattr(restart_remote_module, "log", fake_log)
    monkeypatch.setattr(restart_remote_module, "get_fresh_frame", lambda _db, _id: SimpleNamespace(id=1))
    monkeypatch.setattr(restart_remote_module, "run_commands", fake_run_commands)

    await restart_remote_task({"db": object(), "redis": object()}, id=1, transport="ssh")

    assert captured["transport"] == "ssh"
    command = captured["commands"][0]
    assert "sudo -n sh -lc" in command
    assert "systemctl restart frameos-remote.service" in command
    assert "frameos_agent.service frameos-agent.service" in command
    assert "[f]rameos_agent" in command
    assert 'exit "$restart_status"' in command
