from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace

import pytest

from app.tasks.deploy_frame import (
    cancel_active_deploy,
    clear_active_deploy_job,
    register_active_deploy_job,
)
from app.tasks.frame_deploy_workflow import active_deploy_job_key, deploy_lock_key

deploy_frame_module = importlib.import_module("app.tasks.deploy_frame")


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value, nx: bool = False, ex: int | None = None):
        if nx and key in self.store:
            return None
        self.store[key] = value.encode() if isinstance(value, str) else value
        return True

    async def delete(self, key: str) -> int:
        return 1 if self.store.pop(key, None) is not None else 0


class FakeJob:
    aborted_ids: list[str] = []
    abort_result: bool = True
    abort_error: Exception | None = None

    def __init__(self, job_id: str, redis) -> None:
        self.job_id = job_id

    async def abort(self, *, timeout: int | None = None) -> bool:
        if FakeJob.abort_error is not None:
            raise FakeJob.abort_error
        FakeJob.aborted_ids.append(self.job_id)
        return FakeJob.abort_result


@pytest.fixture(autouse=True)
def patch_job_and_logging(monkeypatch: pytest.MonkeyPatch):
    FakeJob.aborted_ids = []
    FakeJob.abort_result = True
    FakeJob.abort_error = None
    logs: list[tuple[str, str]] = []
    updates: list[object] = []

    async def fake_log(db, redis, frame_id, type="stdout", line=""):
        logs.append((type, line))

    async def fake_update_frame(db, redis, frame):
        updates.append(frame)

    monkeypatch.setattr(deploy_frame_module, "Job", FakeJob)
    monkeypatch.setattr(deploy_frame_module, "log", fake_log)
    monkeypatch.setattr(deploy_frame_module, "update_frame", fake_update_frame)
    return {"logs": logs, "updates": updates}


@pytest.mark.asyncio
async def test_cancel_active_deploy_aborts_job_clears_lock_and_resets_status(patch_job_and_logging):
    redis = FakeRedis()
    frame = SimpleNamespace(id=7, status="deploying")
    await register_active_deploy_job(redis, 7, "deploy:7:abc")
    await redis.set(deploy_lock_key(7), "token")

    result = await cancel_active_deploy(None, redis, frame)

    assert result == {"abortedJob": True, "clearedLock": True, "resetStatus": True}
    assert FakeJob.aborted_ids == ["deploy:7:abc"]
    assert active_deploy_job_key(7) not in redis.store
    assert deploy_lock_key(7) not in redis.store
    assert frame.status == "uninitialized"
    assert patch_job_and_logging["updates"] == [frame]


@pytest.mark.asyncio
async def test_cancel_active_deploy_with_nothing_running(patch_job_and_logging):
    redis = FakeRedis()
    frame = SimpleNamespace(id=7, status="ready")

    result = await cancel_active_deploy(None, redis, frame)

    assert result == {"abortedJob": False, "clearedLock": False, "resetStatus": False}
    assert FakeJob.aborted_ids == []
    assert frame.status == "ready"


@pytest.mark.asyncio
async def test_cancel_active_deploy_clears_lock_even_when_abort_times_out(patch_job_and_logging):
    redis = FakeRedis()
    frame = SimpleNamespace(id=7, status="deploying")
    await register_active_deploy_job(redis, 7, "deploy:7:abc")
    await redis.set(deploy_lock_key(7), "token")
    FakeJob.abort_error = asyncio.TimeoutError()

    result = await cancel_active_deploy(None, redis, frame)

    assert result == {"abortedJob": False, "clearedLock": True, "resetStatus": True}
    assert deploy_lock_key(7) not in redis.store
    assert active_deploy_job_key(7) not in redis.store
    assert any("did not confirm the abort" in line for _type, line in patch_job_and_logging["logs"])


@pytest.mark.asyncio
async def test_clear_active_deploy_job_only_removes_own_registration():
    redis = FakeRedis()
    await register_active_deploy_job(redis, 7, "deploy:7:old")

    # A newer job re-registered the key; the old job's cleanup must not remove it
    await register_active_deploy_job(redis, 7, "deploy:7:new")
    await clear_active_deploy_job(redis, 7, "deploy:7:old")
    assert redis.store[active_deploy_job_key(7)] == b"deploy:7:new"

    await clear_active_deploy_job(redis, 7, "deploy:7:new")
    assert active_deploy_job_key(7) not in redis.store


@pytest.mark.asyncio
async def test_deploy_frame_task_resets_the_frame_when_the_job_is_cancelled(monkeypatch: pytest.MonkeyPatch, patch_job_and_logging):
    """A cancelled (aborted or timed-out) job is a BaseException: it used to
    skip the error branch, leave status="deploying" and log nothing, so the
    next deploy hit the stuck-status branch. The task must reset the row, log
    the outcome, release its job registration and still re-raise so arq
    records the cancellation."""
    frame = SimpleNamespace(id=31, name="CancelledFrame", mode="rpios", status="deploying")
    monkeypatch.setattr(deploy_frame_module, "get_fresh_frame", lambda db, frame_id: frame)

    class FakeDeployer:
        def __init__(self, **_kwargs) -> None:
            pass

    class FakeWorkflow:
        DEPLOY_LOCK_TTL_SECONDS = 60

        def __init__(self, **_kwargs) -> None:
            pass

        async def plan(self, mode: str):
            return SimpleNamespace(mode=mode)

        async def execute(self, plan):
            raise asyncio.CancelledError()

    monkeypatch.setattr(deploy_frame_module, "FrameDeployer", FakeDeployer)
    monkeypatch.setattr(deploy_frame_module, "FrameDeployWorkflow", FakeWorkflow)

    redis = FakeRedis()
    ctx = {"db": None, "redis": redis, "job_id": "job-31"}

    with pytest.raises(asyncio.CancelledError):
        await deploy_frame_module.deploy_frame_task(ctx, 31, task_id="task-31")

    assert frame.status == "uninitialized"
    assert patch_job_and_logging["updates"] == [frame]
    failed_lines = [line for kind, line in patch_job_and_logging["logs"] if kind == "stderr"]
    assert any("cancelled" in line for line in failed_lines), failed_lines
    assert any("task-31" in line and "failed" in line for line in failed_lines), failed_lines
    assert active_deploy_job_key(31) not in redis.store, "the job registration must not outlive the job"


@pytest.mark.asyncio
async def test_deploy_frame_task_leaves_a_healthy_frame_alone_when_cancelled_after_completion(monkeypatch: pytest.MonkeyPatch, patch_job_and_logging):
    """Only a row still marked "deploying" is reset — a frame the workflow
    already moved on (e.g. cancelled during the final log flush) keeps its
    real status."""
    frame = SimpleNamespace(id=32, name="DoneFrame", mode="rpios", status="ready")
    monkeypatch.setattr(deploy_frame_module, "get_fresh_frame", lambda db, frame_id: frame)

    class FakeWorkflow:
        DEPLOY_LOCK_TTL_SECONDS = 60

        def __init__(self, **_kwargs) -> None:
            pass

        async def plan(self, mode: str):
            return SimpleNamespace(mode=mode)

        async def execute(self, plan):
            raise asyncio.CancelledError()

    monkeypatch.setattr(deploy_frame_module, "FrameDeployer", lambda **_kwargs: object())
    monkeypatch.setattr(deploy_frame_module, "FrameDeployWorkflow", FakeWorkflow)

    with pytest.raises(asyncio.CancelledError):
        await deploy_frame_module.deploy_frame_task({"db": None, "redis": FakeRedis(), "job_id": None}, 32)

    assert frame.status == "ready"
    assert patch_job_and_logging["updates"] == []
