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

    monkeypatch.setattr("app.utils.local_exec.log", fake_log)

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
