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


def _adopted_card(**overrides) -> SimpleNamespace:
    """A generic Buildroot card adopted over its admin API: no Remote, no SSH
    credentials, nothing of this backend's on it (frame_has_shell_access)."""
    defaults = dict(
        id=14,
        name="frame-2c2ea9",
        mode="buildroot",
        status="ready",
        buildroot={"platform": "raspberry-pi-64", "adopted": True},
        agent={},
        ssh_pass="",
        ssh_keys=[],
        device_config={},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.mark.asyncio
async def test_restart_frame_task_shell_less_card_posts_the_control_event(monkeypatch: pytest.MonkeyPatch):
    frame = _adopted_card()
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    await restart_frame_task({"db": None, "redis": None}, 14)

    assert http_calls == [("POST", "/event/restart")]
    assert statuses == ["restarting", "starting"]
    assert any("no shell on this frame" in message for _t, message in logs)


@pytest.mark.asyncio
async def test_reboot_frame_task_shell_less_card_posts_the_control_event(monkeypatch: pytest.MonkeyPatch):
    frame = _adopted_card()
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    await reboot_frame_task({"db": None, "redis": None}, 14)

    assert http_calls == [("POST", "/event/reboot")]
    assert statuses == ["rebooting"]


@pytest.mark.asyncio
async def test_restart_frame_task_shell_less_card_reports_a_refused_event(monkeypatch: pytest.MonkeyPatch):
    frame = _adopted_card()
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)

    async def refused(_frame, _redis, *, path, method, body=None, headers=None):
        http_calls.append((method, path))
        return 401, b"Unauthorized", {}

    monkeypatch.setattr("app.utils.frame_http._fetch_frame_http_bytes", refused)

    await restart_frame_task({"db": None, "redis": None}, 14)

    assert http_calls == [("POST", "/event/restart")]
    assert statuses == ["restarting", "uninitialized"]
    assert any(t == "stderr" and "HTTP 401" in message for t, message in logs)


@pytest.mark.asyncio
async def test_restart_frame_task_buildroot_card_with_ssh_keys_still_uses_the_shell(monkeypatch: pytest.MonkeyPatch):
    frame = _adopted_card(ssh_keys=["key-1"])
    statuses, logs, http_calls = _patch_common(monkeypatch, frame)
    ran: list[list[str]] = []

    async def fake_run_commands(_db, _redis, _frame, commands):
        ran.append(commands)

    monkeypatch.setattr(restart_frame_module, "run_commands", fake_run_commands)

    await restart_frame_task({"db": None, "redis": None}, 14)

    assert http_calls == []
    assert ran and "sudo -n systemctl start frameos.service" in ran[0]
    assert statuses == ["restarting", "starting"]


@pytest.mark.asyncio
async def test_stop_frame_task_shell_less_card_refuses_with_a_reason(monkeypatch: pytest.MonkeyPatch):
    stop_frame_module = importlib.import_module("app.tasks.stop_frame")
    frame = _adopted_card()
    logs: list[tuple[str, str]] = []
    statuses: list[str] = []

    async def fake_log(_db, _redis, _frame_id, log_type, message):
        logs.append((log_type, message))

    async def fake_update_frame(_db, _redis, _frame):
        statuses.append(_frame.status)

    async def fail_run_commands(*_args, **_kwargs):
        raise AssertionError("a shell-less card must not be reached over SSH")

    monkeypatch.setattr(stop_frame_module, "get_fresh_frame", lambda _db, _id: frame)
    monkeypatch.setattr(stop_frame_module, "log", fake_log)
    monkeypatch.setattr(stop_frame_module, "update_frame", fake_update_frame)
    monkeypatch.setattr(stop_frame_module, "run_commands", fail_run_commands)

    await stop_frame_module.stop_frame_task({"db": None, "redis": None}, 14)

    assert statuses == []
    assert logs == [("stderr", "No shell on this frame: stopping frameos.service needs SSH or FrameOS Remote. "
                     "Use Restart FrameOS or Reboot instead.")]
