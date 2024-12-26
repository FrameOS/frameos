import pytest
from app.models.settings import Settings, get_settings_dict

@pytest.mark.asyncio
async def test_create_setting(db):
    s = Settings(key="myKey", value="myValue")
    db.add(s)
    db.commit()
    assert s.id is not None

@pytest.mark.asyncio
async def test_get_settings_dict(db):
    # Clear out
    db.query(Settings).delete()
    db.commit()

    s1 = Settings(key="k1", value="v1")
    s2 = Settings(key="k2", value={"nested": True})
    db.add_all([s1, s2])
    db.commit()

    settings_map = get_settings_dict(db)
    assert settings_map["k1"] == "v1"
    assert settings_map["k2"] == {"nested": True}
