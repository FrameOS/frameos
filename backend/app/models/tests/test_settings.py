import pytest
from app.models.settings import Settings, get_settings_dict

@pytest.mark.asyncio
async def test_create_setting(db, default_project):
    s = Settings(project_id=default_project.id, key="myKey", value="myValue")
    db.add(s)
    db.commit()
    assert s.id is not None

@pytest.mark.asyncio
async def test_get_settings_dict(db, default_project):
    # Clear out
    db.query(Settings).delete()
    db.commit()

    s1 = Settings(project_id=default_project.id, key="k1", value="v1")
    s2 = Settings(project_id=default_project.id, key="k2", value={"nested": True})
    db.add_all([s1, s2])
    db.commit()

    settings_map = get_settings_dict(db, project_id=default_project.id)
    assert settings_map["k1"] == "v1"
    assert settings_map["k2"] == {"nested": True}


@pytest.mark.asyncio
async def test_get_settings_dict_merges_defaults(db, default_project):
    db.query(Settings).delete()
    db.commit()

    db.add(
        Settings(
            project_id=default_project.id,
            key="defaults",
            value={
                "timezone": "Europe/Brussels",
                "wifiSSID": "FrameOS",
            },
        )
    )
    db.commit()

    settings_map = get_settings_dict(db, project_id=default_project.id)
    assert settings_map["defaults"] == {
        "timezone": "Europe/Brussels",
        "wifiSSID": "FrameOS",
        "wifiPassword": "",
    }


def test_get_settings_dict_without_db():
    settings_map = get_settings_dict(None)
    assert settings_map["defaults"]["timezone"]


def test_get_settings_dict_requires_project_id_with_db(db):
    with pytest.raises(ValueError, match="project_id is required"):
        get_settings_dict(db)
