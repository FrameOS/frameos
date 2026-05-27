from __future__ import annotations

import importlib
from types import SimpleNamespace

import pytest

from app.tasks.restart_agent import restart_agent, restart_agent_task


class FakeRedis:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue_job(self, name: str, **kwargs):
        self.jobs.append((name, kwargs))


@pytest.mark.asyncio
async def test_restart_agent_enqueues_transport():
    redis = FakeRedis()

    await restart_agent(7, redis, transport="agent")

    assert redis.jobs == [("restart_agent", {"id": 7, "transport": "agent"})]


@pytest.mark.asyncio
async def test_restart_agent_defaults_to_auto_transport():
    redis = FakeRedis()

    await restart_agent(7, redis)

    assert redis.jobs == [("restart_agent", {"id": 7, "transport": "auto"})]


@pytest.mark.asyncio
async def test_restart_agent_via_agent_schedules_delayed_restart(monkeypatch: pytest.MonkeyPatch):
    restart_agent_module = importlib.import_module("app.tasks.restart_agent")
    captured: dict[str, object] = {}

    async def fake_log(*_args, **_kwargs):
        return None

    async def fake_run_commands(_db, _redis, _frame, commands, **kwargs):
        captured["commands"] = commands
        captured["transport"] = kwargs.get("transport")

    monkeypatch.setattr(restart_agent_module, "log", fake_log)
    monkeypatch.setattr(restart_agent_module, "get_fresh_frame", lambda _db, _id: SimpleNamespace(id=1))
    monkeypatch.setattr(restart_agent_module, "run_commands", fake_run_commands)

    await restart_agent_task({"db": object(), "redis": object()}, id=1, transport="agent")

    assert captured["transport"] == "agent"
    command = captured["commands"][0]
    assert "systemd-run" in command
    assert "systemctl restart frameos_agent.service" in command


@pytest.mark.asyncio
async def test_restart_agent_auto_uses_agent_when_frame_prefers_agent(monkeypatch: pytest.MonkeyPatch):
    restart_agent_module = importlib.import_module("app.tasks.restart_agent")
    captured: dict[str, object] = {}

    async def fake_log(*_args, **_kwargs):
        return None

    async def fake_run_commands(_db, _redis, _frame, commands, **kwargs):
        captured["commands"] = commands
        captured["transport"] = kwargs.get("transport")

    monkeypatch.setattr(restart_agent_module, "log", fake_log)
    monkeypatch.setattr(
        restart_agent_module,
        "get_fresh_frame",
        lambda _db, _id: SimpleNamespace(
            id=1,
            agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        ),
    )
    monkeypatch.setattr(restart_agent_module, "run_commands", fake_run_commands)

    await restart_agent_task({"db": object(), "redis": object()}, id=1)

    assert captured["transport"] == "agent"
    assert "systemd-run" in captured["commands"][0]
