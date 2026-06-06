from types import SimpleNamespace

import pytest

from app.utils.local_exec import exec_local_command


@pytest.mark.asyncio
async def test_exec_local_command_preserves_line_breaks():
    status, out, err = await exec_local_command(
        None,
        None,
        SimpleNamespace(id=1),
        "printf 'one\\ntwo\\n'; printf 'err1\\nerr2\\n' >&2",
        log_command=False,
        log_output=False,
    )

    assert status == 0
    assert out == "one\ntwo\n"
    assert err == "err1\nerr2\n"


@pytest.mark.asyncio
async def test_exec_local_command_can_log_stderr_as_stdout(monkeypatch):
    entries = []

    async def fake_log(_db, _redis, frame_id, tag, message):
        entries.append((frame_id, tag, message))

    monkeypatch.setattr("app.utils.build_executor.log", fake_log)

    status, out, err = await exec_local_command(
        object(),
        object(),
        SimpleNamespace(id=1),
        "printf 'out\\n'; printf 'err\\n' >&2",
        log_command=False,
        stderr_log_tag="stdout",
    )

    assert status == 0
    assert out == "out\n"
    assert err == "err\n"
    assert entries == [
        (1, "stdout", "out"),
        (1, "stdout", "err"),
    ]


@pytest.mark.asyncio
async def test_exec_local_command_runs_through_build_executor(monkeypatch):
    calls = []

    class FakeExecutor:
        async def __aenter__(self):
            calls.append(("enter",))
            return self

        async def __aexit__(self, exc_type, exc, tb):
            calls.append(("exit", exc_type))
            return None

        async def run(self, command, **kwargs):
            calls.append(("run", command, kwargs))
            return 0, "ok\n", None

    def fake_create_build_executor(config, **kwargs):
        calls.append(("factory", config, kwargs))
        return FakeExecutor()

    monkeypatch.setattr("app.utils.local_exec.get_modal_sandbox_config", lambda db, project_id: None)
    monkeypatch.setattr("app.utils.local_exec.create_build_executor", fake_create_build_executor)

    status, out, err = await exec_local_command(
        object(),
        object(),
        SimpleNamespace(id=1, project_id=2),
        "echo ok",
        log_command=False,
        log_output=False,
        stderr_log_tag="stdout",
    )

    assert (status, out, err) == (0, "ok\n", None)
    assert calls[0][0] == "factory"
    assert calls[0][1] is None
    assert calls[0][2]["frame"].id == 1
    assert calls[1:] == [
        ("enter",),
        (
            "run",
            "echo ok",
            {"log_command": False, "log_output": False, "stderr_log_tag": "stdout"},
        ),
        ("exit", None),
    ]
