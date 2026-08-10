from __future__ import annotations

from types import SimpleNamespace

import pytest

# `app.tasks.restart_frame` the attribute is shadowed by the function
# re-exported from app/tasks/__init__.py, so monkeypatch string paths (and
# `from app.tasks import restart_frame`) resolve to the function; grab the
# real module from sys.modules and patch that.
import importlib

restart_frame_module = importlib.import_module("app.tasks.restart_frame")
reboot_frame_task = restart_frame_module.reboot_frame_task
restart_frame_task = restart_frame_module.restart_frame_task


def _embedded_frame(**overrides) -> SimpleNamespace:
    defaults = dict(
        id=53,
        name="ESPvaarikas",
        mode="embedded",
        status="ready",
        embedded={"platform": "esp32-s3", "flashSize": "8MB"},
        device_config={},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _patch_common(monkeypatch: pytest.MonkeyPatch, frame: SimpleNamespace):
    statuses: list[str] = []
    logs: list[tuple[str, str]] = []
    http_calls: list[tuple[str, str]] = []

    async def fake_update_frame(_db, _redis, _frame):
        statuses.append(_frame.status)
        return _frame

    async def fake_log(_db, _redis, _frame_id, log_type, message):
        logs.append((log_type, message))

    async def fake_fetch_frame_http_bytes(_frame, _redis, *, path, method, body=None, headers=None):
        http_calls.append((method, path))
        return 200, b'{"ok":true}', {}

    async def fail_run_commands(*_args, **_kwargs):
        raise AssertionError("embedded frames must not run SSH commands")

    monkeypatch.setattr(restart_frame_module, "get_fresh_frame", lambda _db, _id: frame)
    monkeypatch.setattr(restart_frame_module, "update_frame", fake_update_frame)
    monkeypatch.setattr(restart_frame_module, "log", fake_log)
    monkeypatch.setattr(restart_frame_module, "run_commands", fail_run_commands)
    monkeypatch.setattr("app.utils.frame_http._fetch_frame_http_bytes", fake_fetch_frame_http_bytes)
    return statuses, logs, http_calls


@pytest.mark.asyncio
async def test_restart_frame_task_embedded_posts_device_action(monkeypatch: pytest.MonkeyPatch):
    frame = _embedded_frame()
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    await restart_frame_task({"db": None, "redis": None}, 53)

    assert http_calls == [("POST", "/api/action/restart")]
    assert statuses == ["restarting", "starting"]
    assert any("Requested embedded restart" in message for _t, message in logs)


@pytest.mark.asyncio
async def test_reboot_frame_task_embedded_posts_device_action(monkeypatch: pytest.MonkeyPatch):
    frame = _embedded_frame()
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    await reboot_frame_task({"db": None, "redis": None}, 53)

    assert http_calls == [("POST", "/api/action/reboot")]
    # Like the SSH path, reboot leaves the frame "rebooting" until the
    # device's bootup log flips it back to ready.
    assert statuses == ["rebooting"]
    assert frame.status == "rebooting"


@pytest.mark.asyncio
async def test_restart_frame_task_embedded_http_failure_marks_uninitialized(monkeypatch: pytest.MonkeyPatch):
    frame = _embedded_frame()
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    async def failing_fetch(_frame, _redis, *, path, method, body=None, headers=None):
        http_calls.append((method, path))
        return 502, b"device unreachable", {}

    monkeypatch.setattr("app.utils.frame_http._fetch_frame_http_bytes", failing_fetch)

    await restart_frame_task({"db": None, "redis": None}, 53)

    assert statuses == ["restarting", "uninitialized"]
    assert any("HTTP 502" in message for _t, message in logs)


@pytest.mark.asyncio
async def test_restart_frame_task_virtual_frame_is_a_noop(monkeypatch: pytest.MonkeyPatch):
    frame = _embedded_frame(embedded={"platform": "virtual"})
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    await restart_frame_task({"db": None, "redis": None}, 53)

    assert http_calls == []
    assert statuses == []
    assert any("no device to restart" in message for _t, message in logs)
