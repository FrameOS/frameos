import pytest
from app.models.user import User

@pytest.mark.asyncio
async def test_create_user(db_session):
    u = User(email="test@example.com")
    u.set_password("supersecure")
    db_session.add(u)
    db_session.commit()
    assert u.id is not None
    assert u.email == "test@example.com"
    assert u.check_password("supersecure") is True
    assert u.check_password("wrongpw") is False
