import pytest
from app.models.user import User

@pytest.mark.asyncio
async def test_create_user(db):
    u = User(email="test@example.com")
    u.set_password("supersecure")
    db.add(u)
    db.commit()
    assert u.id is not None
    assert u.email == "test@example.com"
    assert u.check_password("supersecure") is True
    assert u.check_password("wrongpw") is False
