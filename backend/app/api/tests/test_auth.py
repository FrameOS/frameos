import pytest
from starlette.status import HTTP_200_OK, HTTP_400_BAD_REQUEST, HTTP_401_UNAUTHORIZED, HTTP_429_TOO_MANY_REQUESTS
from sqlalchemy.orm import Session
from app.models.user import User


@pytest.mark.asyncio
async def test_login_success(async_client):
    """
    Test that /api/login with correct credentials returns 200 and a valid token.
    The async_client fixture automatically creates a user with email test@example.com / testpassword.
    """
    login_data = {"username": "test@example.com", "password": "testpassword"}
    response = await async_client.post("/api/login", data=login_data)
    assert response.status_code == HTTP_200_OK, f"Expected 200, got {response.status_code}"
    json_data = response.json()
    assert "access_token" in json_data, "Expected an access_token in the response"
    assert "token_type" in json_data, "Expected a token_type in the response"
    assert json_data["token_type"] == "bearer", "Expected token_type to be 'bearer'"


@pytest.mark.asyncio
async def test_login_invalid_password(async_client):
    """
    Test that /api/login returns 401 if the password is invalid.
    """
    login_data = {"username": "test@example.com", "password": "wrongpassword"}
    response = await async_client.post("/api/login", data=login_data)
    assert response.status_code == HTTP_401_UNAUTHORIZED, f"Expected 401, got {response.status_code}"
    assert response.json()["detail"] == "Invalid email or password"


@pytest.mark.asyncio
async def test_login_unknown_email(async_client):
    """
    Test that /api/login returns 401 if the email is not found.
    """
    login_data = {"username": "unknown@example.com", "password": "testpassword"}
    response = await async_client.post("/api/login", data=login_data)
    assert response.status_code == HTTP_401_UNAUTHORIZED
    assert response.json()["detail"] == "Invalid email or password"


@pytest.mark.asyncio
async def test_login_too_many_attempts(no_auth_client, redis, db):
    """
    Test that after too many failed login attempts, we get 429 Too Many Requests.
    The code sets the limit to 10 attempts.
    """
    user = User(email="toomany@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    login_data = {"username": "toomany@example.com", "password": "wrongpassword"}
    # Make 11 attempts
    for i in range(11):
        resp = await no_auth_client.post("/api/login", data=login_data)
        if i <= 10:
            # first 10 attempts => 401
            assert resp.status_code == HTTP_401_UNAUTHORIZED, f"Expected 401 on attempt {i+1}, got {resp.status_code}"
        else:
            # 11th attempt => 429
            assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS, f"Expected 429 on attempt 11, got {resp.status_code}"
            assert resp.json()["detail"] == "Too many login attempts"

    # Even more attempts => still 429
    resp = await no_auth_client.post("/api/login", data=login_data)
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "Too many login attempts"


@pytest.mark.asyncio
async def test_signup_first_user(no_auth_client, db: Session):
    """
    Test that signing up when no user exists will succeed.
    We'll delete all existing users first to ensure DB is empty.
    """
    db.query(User).delete()
    db.commit()

    signup_data = {
        "email": "newuser@example.com",
        "password": "newpassword",
        "password2": "newpassword",
        "newsletter": False
    }
    response = await no_auth_client.post("/api/signup", json=signup_data)
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    json_data = response.json()
    # Should contain success, access_token, token_type
    assert "success" in json_data and json_data["success"] is True, "Expected 'success: True' in signup response"
    assert "access_token" in json_data, "Expected 'access_token' in signup response"
    assert "token_type" in json_data, "Expected 'token_type' in signup response"


@pytest.mark.asyncio
async def test_signup_already_exists(no_auth_client, db: Session):
    """
    Test that if a user already exists, we cannot sign up a new user,
    because the system only allows one user in total.
    """
    # Ensure exactly 1 user is present (the test above or the fixture might have added one).
    # If none exist, create one quickly:
    if not db.query(User).first():
        user = User(email="existing@example.com")
        user.set_password("existingpassword")
        db.add(user)
        db.commit()

    signup_data = {
        "email": "other@example.com",
        "password": "somepass",
        "password2": "somepass",
        "newsletter": True
    }
    response = await no_auth_client.post("/api/signup", json=signup_data)
    assert response.status_code == HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == "Only one user is allowed. Please login!"


@pytest.mark.asyncio
async def test_signup_password_mismatch(no_auth_client, db: Session):
    """
    Test that signing up with mismatched passwords returns 400.
    We'll remove any existing user for this test just for clarity.
    """
    db.query(User).delete()
    db.commit()

    signup_data = {
        "email": "someone@example.com",
        "password": "somepass",
        "password2": "differentpass",
        "newsletter": False
    }
    response = await no_auth_client.post("/api/signup", json=signup_data)
    assert response.status_code == HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == "Passwords do not match."


@pytest.mark.asyncio
async def test_signup_password_too_short(no_auth_client, db: Session):
    """
    Test that signing up with too short a password returns 400.
    """
    db.query(User).delete()
    db.commit()

    signup_data = {
        "email": "shortpass@example.com",
        "password": "abc",    # too short
        "password2": "abc",
        "newsletter": True
    }
    response = await no_auth_client.post("/api/signup", json=signup_data)
    assert response.status_code == HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == "Password too short."
