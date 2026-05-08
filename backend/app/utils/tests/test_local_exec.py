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
