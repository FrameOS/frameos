"""The SSH pool hands a connection back only to the frame row, credentials
and pinned host it was opened for (app/utils/ssh_utils.py)."""
from types import SimpleNamespace

import pytest

from app.utils import ssh_utils

HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFrameOSFrameOSFrameOSFrameOSFrameOSFrameOSFram"
OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOtherOthe"


class FakeKey:
    def __init__(self, line: str):
        self.line = line

    def export_public_key(self, _format):
        return self.line.encode("ascii")


class FakeSsh:
    def __init__(self, host_key: str):
        self.host_key = host_key

    def get_server_host_key(self):
        return FakeKey(self.host_key)


def frame(**overrides):
    values = dict(
        id=1, project_id=1, frame_host="10.0.0.9", ssh_port=22, ssh_user="pi", ssh_pass="one", ssh_host_key=HOST_KEY
    )
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture
def pool(monkeypatch):
    opened: list[SimpleNamespace] = []

    async def connect(db, redis, frame):
        opened.append(frame)
        return FakeSsh(HOST_KEY)

    monkeypatch.setattr(ssh_utils, "_create_new_connection", connect)
    monkeypatch.setattr(ssh_utils, "_ssh_pool", {})
    yield opened
    for connections in ssh_utils._ssh_pool.values():
        for pooled in connections:
            if pooled.closing_task:
                pooled.closing_task.cancel()


async def take_and_release(target):
    ssh = await ssh_utils.get_ssh_connection(None, None, target)  # type: ignore[arg-type]
    await ssh_utils.remove_ssh_connection(None, None, ssh, target)  # type: ignore[arg-type]
    return ssh


@pytest.mark.asyncio
async def test_a_frame_reuses_its_own_idle_connection(pool):
    first = await take_and_release(frame())
    assert await take_and_release(frame()) is first
    assert len(pool) == 1


@pytest.mark.asyncio
async def test_another_frame_row_at_the_same_address_never_gets_the_session(pool):
    owner = await take_and_release(frame())
    # Another project's row for the same host, port and user: wrong password,
    # no password, even the same password. Each opens (or fails to open) its own.
    for other in (
        frame(id=2, project_id=2, ssh_pass="guess"),
        frame(id=2, project_id=2, ssh_pass=None),
        frame(id=2, project_id=2),
        frame(id=3),
    ):
        assert await take_and_release(other) is not owner
    assert len(pool) == 5


@pytest.mark.asyncio
async def test_changed_credentials_or_pin_open_a_new_connection(pool):
    first = await take_and_release(frame())
    assert await take_and_release(frame(ssh_pass="two")) is not first
    # Another key pinned, or the key forgotten: the open session is to a host
    # this row no longer vouches for.
    assert await take_and_release(frame(ssh_host_key=OTHER_KEY)) is not first
    assert await take_and_release(frame(ssh_host_key=None)) is not first
    assert len(pool) == 4


@pytest.mark.asyncio
async def test_release_finds_the_connection_after_the_row_changed(pool):
    target = frame(ssh_host_key=None)
    ssh = await ssh_utils.get_ssh_connection(None, None, target)  # type: ignore[arg-type]
    # The first connect records the host key on the row; a save may change
    # the password. The connection must still go back to idle.
    target.ssh_host_key = HOST_KEY
    await ssh_utils.remove_ssh_connection(None, None, ssh, target)  # type: ignore[arg-type]
    pooled = [pc for connections in ssh_utils._ssh_pool.values() for pc in connections]
    assert [pc.in_use for pc in pooled] == [False]
    assert await take_and_release(target) is not None
