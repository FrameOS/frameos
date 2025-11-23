import pytest

from app.models.settings import Settings
from app.utils.build_host import BuildHostConfig, get_build_host_config


@pytest.mark.asyncio
async def test_get_build_host_config_enabled(db):
    db.query(Settings).delete()
    db.add(
        Settings(
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

    config = get_build_host_config(db)
    assert isinstance(config, BuildHostConfig)
    assert config.host == "builder.local"
    assert config.port == 2222
    assert config.user == "ubuntu"
    assert config.ssh_key == "dummy-key"


@pytest.mark.asyncio
async def test_get_build_host_config_requires_fields(db):
    db.query(Settings).delete()
    db.add(
        Settings(
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

    assert get_build_host_config(db) is None
