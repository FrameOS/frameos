import pytest
from app.models.settings import Settings, get_settings_dict

@pytest.mark.asyncio
async def test_create_setting(db_session):
    s = Settings(key="myKey", value="myValue")
    db_session.add(s)
    db_session.commit()
    assert s.id is not None

@pytest.mark.asyncio
async def test_get_settings_dict(db_session):
    # Clear out
    db_session.query(Settings).delete()
    db_session.commit()

    s1 = Settings(key="k1", value="v1")
    s2 = Settings(key="k2", value={"nested": True})
    db_session.add_all([s1, s2])
    db_session.commit()

    settings_map = get_settings_dict(db_session)
    assert settings_map["k1"] == "v1"
    assert settings_map["k2"] == {"nested": True}
