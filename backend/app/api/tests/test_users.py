import pytest
from app.models.user import User
from sqlalchemy.orm import Session

@pytest.mark.asyncio
async def test_has_first_user_no_users(async_client, db: Session):
    """
    Ensure that has_first_user returns false when there are no users in the DB.
    """
    # Remove all existing users
    db.query(User).delete()
    db.commit()

    response = await async_client.get("/api/has_first_user")
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    data = response.json()
    assert "has_first_user" in data, "Response should contain 'has_first_user' key"
    assert data["has_first_user"] is False, "Expected 'has_first_user' to be False when DB is empty"


@pytest.mark.asyncio
async def test_has_first_user_exists(async_client, db: Session):
    """
    Ensure that has_first_user returns true when at least one user is in the DB.
    """
    # Clear all users and then add a new one
    db.query(User).delete()
    db.commit()
    db.expunge_all()

    user = User(email="someone@example.com")
    user.set_password("somepassword")
    db.add(user)
    db.commit()

    response = await async_client.get("/api/has_first_user")
    assert response.status_code == 200
    data = response.json()
    assert "has_first_user" in data
    assert data["has_first_user"] is True, "Expected 'has_first_user' to be True when user exists"
