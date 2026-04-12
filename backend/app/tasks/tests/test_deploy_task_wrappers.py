from __future__ import annotations

import importlib
from types import SimpleNamespace

import pytest

deploy_frame_module = importlib.import_module("app.tasks.deploy_frame")
fast_deploy_frame_module = importlib.import_module("app.tasks.fast_deploy_frame")


class _FakeDB:
    def __init__(self, frame):
        self._frame = frame

    def get(self, _model, _id):
        return self._frame


@pytest.mark.asyncio
async def test_full_deploy_task_plans_before_execute(monkeypatch: pytest.MonkeyPatch):
    calls: list[str] = []
    frame = SimpleNamespace(id=1, name="Frame")

    class FakeDeployer:
        def __init__(self, **_kwargs):
            pass

    class FakeWorkflow:
        def __init__(self, **_kwargs):
            pass

        async def plan(self, mode: str):
            calls.append(f"plan:{mode}")
            return {"mode": mode}

        async def execute(self, plan):
            calls.append(f"execute:{plan['mode']}")

    monkeypatch.setattr(deploy_frame_module, "find_nim_v2", lambda: "/usr/bin/nim")
    monkeypatch.setattr(deploy_frame_module, "FrameDeployer", FakeDeployer)
    monkeypatch.setattr(deploy_frame_module, "FrameDeployWorkflow", FakeWorkflow)

    await deploy_frame_module.deploy_frame_task({"db": _FakeDB(frame), "redis": object()}, 1)

    assert calls == ["plan:full", "execute:full"]


@pytest.mark.asyncio
async def test_fast_deploy_task_plans_before_execute(monkeypatch: pytest.MonkeyPatch):
    calls: list[str] = []
    frame = SimpleNamespace(id=1, name="Frame")

    class FakeDeployer:
        def __init__(self, **_kwargs):
            pass

    class FakeWorkflow:
        def __init__(self, **_kwargs):
            pass

        async def plan(self, mode: str):
            calls.append(f"plan:{mode}")
            return {"mode": mode}

        async def execute(self, plan):
            calls.append(f"execute:{plan['mode']}")

    monkeypatch.setattr(fast_deploy_frame_module, "FrameDeployer", FakeDeployer)
    monkeypatch.setattr(fast_deploy_frame_module, "FrameDeployWorkflow", FakeWorkflow)

    await fast_deploy_frame_module.fast_deploy_frame_task({"db": _FakeDB(frame), "redis": object()}, 1)

    assert calls == ["plan:fast", "execute:fast"]
