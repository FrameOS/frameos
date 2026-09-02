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
    Five failures lock the account with exponential backoff; the lock is on the
    account, not the (ip, account) pair.
    """
    from app.api.auth import LOGIN_LOCKOUT_THRESHOLD, login_lockout_seconds
    from app.utils.rate_limit import rate_limit_key

    user = User(email="toomany@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    login_data = {"username": "toomany@example.com", "password": "wrongpassword"}
    for i in range(LOGIN_LOCKOUT_THRESHOLD):
        resp = await no_auth_client.post("/api/login", data=login_data)
        assert resp.status_code == HTTP_401_UNAUTHORIZED, f"Expected 401 on attempt {i+1}, got {resp.status_code}"

    resp = await no_auth_client.post("/api/login", data=login_data)
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    assert resp.json()["detail"] == "Too many login attempts"
    assert 0 < int(resp.headers["Retry-After"]) <= login_lockout_seconds(LOGIN_LOCKOUT_THRESHOLD)

    # The right password is refused too while the lock holds ...
    resp = await no_auth_client.post(
        "/api/login", data={"username": "toomany@example.com", "password": "testpassword"}
    )
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    # ... from any address: the lock keys on the account.
    resp = await no_auth_client.post(
        "/api/login", data=login_data, headers={"X-Forwarded-For": "203.0.113.7"}
    )
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    # A different account is not affected by this one's failures.
    resp = await no_auth_client.post("/api/login", data={"username": "other@example.com", "password": "x"})
    assert resp.status_code == HTTP_401_UNAUTHORIZED

    # Once the lock expires a successful login resets the counter.
    await redis.delete(rate_limit_key("login_lock", "toomany@example.com"))
    resp = await no_auth_client.post(
        "/api/login", data={"username": "toomany@example.com", "password": "testpassword"}
    )
    assert resp.status_code == HTTP_200_OK
    resp = await no_auth_client.post("/api/login", data=login_data)
    assert resp.status_code == HTTP_401_UNAUTHORIZED


def test_login_lockout_backoff_doubles_up_to_the_cap():
    from app.api.auth import (
        LOGIN_LOCKOUT_BASE_SECONDS,
        LOGIN_LOCKOUT_MAX_SECONDS,
        LOGIN_LOCKOUT_THRESHOLD,
        login_lockout_seconds,
    )

    assert login_lockout_seconds(LOGIN_LOCKOUT_THRESHOLD - 1) == 0
    assert login_lockout_seconds(LOGIN_LOCKOUT_THRESHOLD) == LOGIN_LOCKOUT_BASE_SECONDS
    assert login_lockout_seconds(LOGIN_LOCKOUT_THRESHOLD + 1) == 2 * LOGIN_LOCKOUT_BASE_SECONDS
    assert login_lockout_seconds(LOGIN_LOCKOUT_THRESHOLD + 40) == LOGIN_LOCKOUT_MAX_SECONDS


@pytest.mark.asyncio
async def test_login_lockout_is_case_insensitive_on_the_account(no_auth_client, redis, db):
    from app.api.auth import LOGIN_LOCKOUT_THRESHOLD

    user = User(email="mixed@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    for _ in range(LOGIN_LOCKOUT_THRESHOLD):
        await no_auth_client.post("/api/login", data={"username": "Mixed@Example.com", "password": "nope"})
    resp = await no_auth_client.post("/api/login", data={"username": "mixed@example.com", "password": "testpassword"})
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS


@pytest.mark.asyncio
async def test_login_per_ip_failure_limit(no_auth_client, redis, db, monkeypatch):
    from app.api import auth as auth_module

    monkeypatch.setattr(auth_module, "LOGIN_IP_LIMIT", 3)
    for i in range(3):
        resp = await no_auth_client.post("/api/login", data={"username": f"user{i}@example.com", "password": "x"})
        assert resp.status_code == HTTP_401_UNAUTHORIZED
    resp = await no_auth_client.post("/api/login", data={"username": "user9@example.com", "password": "x"})
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    # The test client connects from loopback, a trusted proxy, so a forwarded
    # address counts as a different caller.
    resp = await no_auth_client.post(
        "/api/login",
        data={"username": "user9@example.com", "password": "x"},
        headers={"X-Forwarded-For": "203.0.113.9"},
    )
    assert resp.status_code == HTTP_401_UNAUTHORIZED


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
async def test_signup_accepts_localhost_domain(no_auth_client, db: Session):
    db.query(User).delete()
    db.commit()

    signup_data = {
        "email": "marius@localhost",
        "password": "newpassword",
        "password2": "newpassword",
        "newsletter": False,
    }
    response = await no_auth_client.post("/api/signup", json=signup_data)

    assert response.status_code == HTTP_200_OK
    json_data = response.json()
    assert json_data["success"] is True


@pytest.mark.asyncio
async def test_signup_invalid_email_rejected(no_auth_client, db: Session):
    db.query(User).delete()
    db.commit()

    signup_data = {
        "email": "not-an-email",
        "password": "newpassword",
        "password2": "newpassword",
        "newsletter": False,
    }
    response = await no_auth_client.post("/api/signup", json=signup_data)

    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Value error, Please enter a valid email address."


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


@pytest.mark.asyncio
async def test_cookie_auth_on_protected_route(no_auth_client, db: Session):
    user = User(email="cookieuser@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    login_data = {"username": "cookieuser@example.com", "password": "testpassword"}
    login_response = await no_auth_client.post("/api/login", data=login_data)
    assert login_response.status_code == HTTP_200_OK
    assert "frameos_session" in login_response.cookies

    no_auth_client.headers.pop("Authorization", None)
    response = await no_auth_client.get("/api/system/metrics")
    assert response.status_code == HTTP_200_OK


@pytest.mark.asyncio
async def test_login_cookie_secure_flag_depends_on_request_scheme(no_auth_client, db: Session):
    user = User(email="securecookie@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    login_data = {"username": "securecookie@example.com", "password": "testpassword"}

    http_response = await no_auth_client.post("/api/login", data=login_data)
    assert http_response.status_code == HTTP_200_OK
    assert "Secure" not in http_response.headers.get("set-cookie", "")

    https_response = await no_auth_client.post(
        "/api/login",
        data=login_data,
        headers={"x-forwarded-proto": "https"},
    )
    assert https_response.status_code == HTTP_200_OK
    assert "Secure" in https_response.headers.get("set-cookie", "")
