from types import SimpleNamespace

import pytest

from app.models.settings import Settings
from app.utils.build_host import BuildHostConfig, BuildHostSession, get_build_host_config


@pytest.mark.asyncio
async def test_get_build_host_config_enabled(db, default_project):
    db.query(Settings).delete()
    db.add(
        Settings(
            project_id=default_project.id,
            key="buildHost",
            value={
                "enabled": True,
                "host": "builder.local",
                "user": "ubuntu",
                "port": 2222,
                "sshKey": "dummy-key",
            },
        )
    )
    db.commit()

    config = get_build_host_config(db, default_project.id)
    assert isinstance(config, BuildHostConfig)
    assert config.host == "builder.local"
    assert config.port == 2222
    assert config.user == "ubuntu"
    assert config.ssh_key == "dummy-key"


@pytest.mark.asyncio
async def test_get_build_host_config_requires_fields(db, default_project):
    db.query(Settings).delete()
    db.add(
        Settings(
            project_id=default_project.id,
            key="buildHost",
            value={
                "enabled": True,
                "host": "builder.local",
                "user": "",
                "sshKey": "dummy-key",
            },
        )
    )
    db.commit()

    assert get_build_host_config(db, default_project.id) is None


@pytest.mark.asyncio
async def test_build_host_run_preserves_buffered_stdout_line_breaks():
    class FakeStream:
        def __init__(self, chunks):
            self.chunks = list(chunks)

        async def read(self, _size):
            if self.chunks:
                return self.chunks.pop(0)
            return ""

    class FakeProcess:
        def __init__(self):
            self.stdout = FakeStream(
                [
                    "drivers/inkyPython/inkyPython.so\n"
                    "drivers/gpioButton/gpioButton.so\n"
                    "scenes/abc/scene_abc.so"
                ]
            )
            self.stderr = FakeStream([])

        async def wait(self):
            return SimpleNamespace(returncode=0)

    class FakeConnection:
        async def create_process(self, _command):
            return FakeProcess()

    session = BuildHostSession(
        BuildHostConfig(host="builder.local", user="ubuntu", ssh_key="dummy-key")
    )
    session._conn = FakeConnection()

    status, stdout, stderr = await session.run("find drivers scenes", log_command=False)

    assert status == 0
    assert stdout == (
        "drivers/inkyPython/inkyPython.so\n"
        "drivers/gpioButton/gpioButton.so\n"
        "scenes/abc/scene_abc.so"
    )
    assert stderr is None
