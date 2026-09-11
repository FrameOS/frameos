from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace

import pytest

from app.tasks import utils as task_utils
from app.tasks.deploy_frame import deploy_frame
from app.tasks.fast_deploy_frame import fast_deploy_frame
from app.tasks.frame_deploy_helpers import DEFAULT_QUICKJS_SHA256, DEFAULT_QUICKJS_VERSION, ensure_quickjs
from app.tasks.utils import JobAlreadyQueuedError, record_task_failure

embedded_firmware = importlib.import_module("app.tasks.embedded_firmware")
frame_deployer_module = importlib.import_module("app.tasks._frame_deployer")


class DuplicateRejectingRedis:
    """arq's enqueue_job answers a job id it already holds with None."""

    def __init__(self) -> None:
        self.job_ids: set[str] = set()

    async def enqueue_job(self, name: str, **kwargs):
        job_id = kwargs.get("_job_id")
        if job_id in self.job_ids:
            return None
        if job_id:
            self.job_ids.add(job_id)
        return object()


@pytest.mark.asyncio
@pytest.mark.parametrize("enqueue", [deploy_frame, fast_deploy_frame])
async def test_duplicate_task_id_is_an_error_not_a_silent_success(enqueue):
    redis = DuplicateRejectingRedis()
    await enqueue(7, redis, task_id="deploy:7:same")

    with pytest.raises(JobAlreadyQueuedError, match="deploy:7:same"):
        await enqueue(7, redis, task_id="deploy:7:same")


@pytest.fixture
def failure_sinks(monkeypatch: pytest.MonkeyPatch):
    logs: list[tuple[str, str]] = []
    statuses: list[str] = []

    async def fake_log(_db, _redis, _frame_id, log_type, line):
        logs.append((log_type, line))

    async def fake_update_frame(_db, _redis, frame):
        statuses.append(frame.status)

    monkeypatch.setattr(task_utils, "log", fake_log)
    monkeypatch.setattr(task_utils, "update_frame", fake_update_frame)
    return logs, statuses


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["deploying", "restarting", "rebooting", "stopping"])
async def test_record_task_failure_resets_a_verbs_transient_status(failure_sinks, status):
    logs, statuses = failure_sinks
    frame = SimpleNamespace(id=3, status=status)

    message = await record_task_failure(None, None, 3, RuntimeError("ssh refused"), frame=frame)

    assert message == "ssh refused"
    assert logs == [("stderr", "ssh refused")]
    assert statuses == ["uninitialized"]


@pytest.mark.asyncio
async def test_record_task_failure_leaves_a_settled_status_alone(failure_sinks):
    logs, statuses = failure_sinks
    frame = SimpleNamespace(id=3, status="ready")

    await record_task_failure(None, None, 3, RuntimeError("late failure"), frame=frame)

    assert frame.status == "ready"
    assert statuses == []


@pytest.mark.asyncio
async def test_record_task_failure_names_cancellation_and_http_detail(failure_sinks):
    logs, _statuses = failure_sinks

    assert await record_task_failure(None, None, 3, asyncio.CancelledError()) == "cancelled"
    assert await record_task_failure(None, None, 3, SimpleNamespace_error("device said no")) == "device said no"
    assert await record_task_failure(
        None, None, 3, RuntimeError("boom"), task_line=lambda message: f"[task] failed {message}"
    ) == "boom"
    assert logs[-2:] == [("stderr", "[task] failed boom"), ("stderr", "boom")]


def SimpleNamespace_error(detail: str) -> Exception:
    exc = Exception()
    setattr(exc, "detail", detail)  # an HTTPException's shape
    return exc


@pytest.mark.asyncio
async def test_stop_frame_task_failure_raises_after_resetting(monkeypatch: pytest.MonkeyPatch, failure_sinks):
    logs, statuses = failure_sinks
    stop_frame_module = importlib.import_module("app.tasks.stop_frame")
    frame = SimpleNamespace(id=9, status="ready", mode="rpios", agent={}, ssh_keys=["k"], ssh_pass="", buildroot={})

    async def fake_update_frame(_db, _redis, target):
        statuses.append(target.status)

    async def failing_run_commands(*_args, **_kwargs):
        raise RuntimeError("connection lost")

    monkeypatch.setattr(stop_frame_module, "get_fresh_frame", lambda _db, _id: frame)
    monkeypatch.setattr(stop_frame_module, "update_frame", fake_update_frame)
    monkeypatch.setattr(stop_frame_module, "frame_has_shell_access", lambda _frame: True)
    monkeypatch.setattr(stop_frame_module, "run_commands", failing_run_commands)

    with pytest.raises(RuntimeError, match="connection lost"):
        await stop_frame_module.stop_frame_task({"db": None, "redis": None}, 9)

    assert statuses == ["stopping", "uninitialized"]
    assert logs == [("stderr", "connection lost")]


class RecordingDeployer:
    def __init__(self) -> None:
        self.commands: list[str] = []
        self.logs: list[tuple[str, str]] = []

    async def exec_command(self, command: str, **_kwargs) -> int:
        self.commands.append(command)
        return 0

    async def log(self, log_type: str, line: str) -> None:
        self.logs.append((log_type, line))


@pytest.mark.asyncio
async def test_quickjs_source_fallback_checks_the_pinned_sha256_before_unpacking():
    deployer = RecordingDeployer()

    await ensure_quickjs(
        deployer,  # type: ignore[arg-type]
        prebuilt_entry=None,
        build_id="b1",
        cross_compiled=False,
        quickjs_installed=False,
        quickjs_dirname=f"quickjs-{DEFAULT_QUICKJS_VERSION}",
    )

    download = next(command for command in deployer.commands if "wget" in command)
    assert f"{DEFAULT_QUICKJS_SHA256}  /tmp/quickjs-{DEFAULT_QUICKJS_VERSION}.tar.xz" in download
    assert download.index("sha256sum -c -") < download.index("tar -xf")
    assert "exit 1" in download


@pytest.mark.asyncio
async def test_quickjs_source_fallback_refuses_a_version_without_a_pin():
    deployer = RecordingDeployer()

    with pytest.raises(Exception, match="No pinned sha256 for the QuickJS 2099-01-01"):
        await ensure_quickjs(
            deployer,  # type: ignore[arg-type]
            prebuilt_entry=None,
            build_id="b1",
            cross_compiled=False,
            quickjs_installed=False,
            quickjs_dirname="quickjs-2099-01-01",
        )

    assert not any("wget" in command for command in deployer.commands)


@pytest.mark.asyncio
async def test_frame_json_is_uploaded_private(monkeypatch: pytest.MonkeyPatch):
    uploads: list[tuple[str, dict]] = []

    async def fake_upload_file(_db, _redis, _frame, path, _data, **kwargs):
        uploads.append((path, kwargs))

    monkeypatch.setattr(frame_deployer_module, "get_frame_json", lambda _db, _frame: {"serverApiKey": "secret"})
    monkeypatch.setattr(frame_deployer_module, "upload_file", fake_upload_file)
    deployer = frame_deployer_module.FrameDeployer(
        db=None, redis=None, frame=SimpleNamespace(id=1), nim_path="", temp_dir=""
    )

    await deployer._upload_frame_json("/srv/frameos/releases/x/frame.json")

    assert uploads == [("/srv/frameos/releases/x/frame.json", {"transport": "auto", "mode": 0o600})]


def test_gpio_button_labels_cannot_split_the_console_spec(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(embedded_firmware, "embedded_hardware_preset_for_frame", lambda _frame: None)
    frame = SimpleNamespace(
        gpio_buttons=[{"pin": 2, "label": "Up, next"}, {"pin": 5, "label": "a:b,c"}],
    )

    assert embedded_firmware.embedded_gpio_buttons_for_frame(frame) == [(2, "Up next"), (5, "a b c")]
    # What console provisioning sends: one comma per button, no more.
    assert embedded_firmware.embedded_gpio_buttons_config(frame).replace("\n", ",") == "2:Up next,5:a b c"
