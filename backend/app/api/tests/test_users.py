import pytest
from app.models.user import User
from sqlalchemy.orm import Session
from starlette.status import HTTP_200_OK, HTTP_400_BAD_REQUEST, HTTP_401_UNAUTHORIZED, HTTP_422_UNPROCESSABLE_ENTITY


async def assert_password_login_status(client, email: str, password: str, expected_status: int):
    response = await client.post("/api/login", data={"username": email, "password": password})
    assert response.status_code == expected_status


def assert_stored_password(db: Session, email: str, password: str, expected: bool):
    db.expire_all()
    user = db.query(User).filter_by(email=email).one()
    assert user.check_password(password) is expected


def create_user(db: Session, email: str, password: str = "testpassword") -> User:
    user = User(email=email)
    user.set_password(password)
    db.add(user)
    db.commit()
    return user

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


@pytest.mark.asyncio
async def test_get_current_user(async_client):
    response = await async_client.get("/api/user")

    assert response.status_code == HTTP_200_OK
    assert response.json() == {"email": "test@example.com"}


@pytest.mark.asyncio
async def test_get_current_user_requires_auth(no_auth_client):
    response = await no_auth_client.get("/api/user")

    assert response.status_code == HTTP_401_UNAUTHORIZED


@pytest.mark.asyncio
async def test_change_current_user_email_requires_auth(no_auth_client, db: Session):
    create_user(db, "emailauth@example.com")

    response = await no_auth_client.post("/api/user/email", json={"email": "new@example.com"})

    assert response.status_code == HTTP_401_UNAUTHORIZED
    db.expire_all()
    assert db.query(User).filter_by(email="emailauth@example.com").one()
    assert db.query(User).filter_by(email="new@example.com").first() is None


@pytest.mark.asyncio
async def test_change_current_user_email_updates_cookie_session(no_auth_client, db: Session):
    create_user(db, "old@example.com")
    login_response = await no_auth_client.post(
        "/api/login",
        data={"username": "old@example.com", "password": "testpassword"},
    )
    assert login_response.status_code == HTTP_200_OK

    response = await no_auth_client.post("/api/user/email", json={"email": "new@example.com"})

    assert response.status_code == HTTP_200_OK
    assert response.json() == {"email": "new@example.com"}
    assert "password" not in response.json()
    assert "frameos_session" in response.headers.get("set-cookie", "")

    db.expire_all()
    assert db.query(User).filter_by(email="old@example.com").first() is None
    assert_stored_password(db, "new@example.com", "testpassword", True)

    current_user_response = await no_auth_client.get("/api/user")
    assert current_user_response.status_code == HTTP_200_OK
    assert current_user_response.json() == {"email": "new@example.com"}

    await assert_password_login_status(no_auth_client, "old@example.com", "testpassword", HTTP_401_UNAUTHORIZED)
    await assert_password_login_status(no_auth_client, "new@example.com", "testpassword", HTTP_200_OK)


@pytest.mark.asyncio
async def test_change_current_user_email_trims_email(async_client, db: Session):
    response = await async_client.post("/api/user/email", json={"email": "  renamed@example.com  "})

    assert response.status_code == HTTP_200_OK
    assert response.json() == {"email": "renamed@example.com"}
    db.expire_all()
    assert db.query(User).filter_by(email="test@example.com").first() is None
    assert db.query(User).filter_by(email="renamed@example.com").one()


@pytest.mark.asyncio
async def test_change_current_user_email_rejects_duplicate(async_client, db: Session):
    create_user(db, "other@example.com", "otherpassword")

    response = await async_client.post("/api/user/email", json={"email": "other@example.com"})

    assert response.status_code == HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == "Email already in use."
    db.expire_all()
    assert_stored_password(db, "test@example.com", "testpassword", True)
    assert_stored_password(db, "other@example.com", "otherpassword", True)


@pytest.mark.asyncio
@pytest.mark.parametrize("email", ["not-an-email", "missing-local@", "@missing-domain", "has space@example.com"])
async def test_change_current_user_email_rejects_invalid_email(async_client, db: Session, email):
    response = await async_client.post("/api/user/email", json={"email": email})

    assert response.status_code == HTTP_422_UNPROCESSABLE_ENTITY
    db.expire_all()
    assert_stored_password(db, "test@example.com", "testpassword", True)


@pytest.mark.asyncio
async def test_change_current_user_password_requires_auth(no_auth_client, db: Session):
    create_user(db, "passwordauth@example.com")

    response = await no_auth_client.post(
        "/api/user/password",
        json={
            "current_password": "testpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_401_UNAUTHORIZED
    assert_stored_password(db, "passwordauth@example.com", "testpassword", True)
    assert_stored_password(db, "passwordauth@example.com", "newpassword", False)


@pytest.mark.asyncio
async def test_change_current_user_password(async_client, no_auth_client):
    response = await async_client.post(
        "/api/user/password",
        json={
            "current_password": "testpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_200_OK
    assert response.json() == {"email": "test@example.com"}
    assert "password" not in response.json()

    await assert_password_login_status(no_auth_client, "test@example.com", "testpassword", HTTP_401_UNAUTHORIZED)
    await assert_password_login_status(no_auth_client, "test@example.com", "newpassword", HTTP_200_OK)


@pytest.mark.asyncio
async def test_change_current_user_password_keeps_existing_session_valid(async_client):
    response = await async_client.post(
        "/api/user/password",
        json={
            "current_password": "testpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_200_OK

    current_user_response = await async_client.get("/api/user")
    assert current_user_response.status_code == HTTP_200_OK
    assert current_user_response.json() == {"email": "test@example.com"}


@pytest.mark.asyncio
async def test_change_current_user_password_updates_only_authenticated_user(async_client, db: Session):
    other_user = User(email="other@example.com")
    other_user.set_password("otherpassword")
    db.add(other_user)
    db.commit()

    response = await async_client.post(
        "/api/user/password",
        json={
            "current_password": "testpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_200_OK
    assert_stored_password(db, "test@example.com", "newpassword", True)
    assert_stored_password(db, "other@example.com", "otherpassword", True)
    assert_stored_password(db, "other@example.com", "newpassword", False)


@pytest.mark.asyncio
async def test_change_current_user_password_requires_current_password(async_client):
    response = await async_client.post(
        "/api/user/password",
        json={
            "current_password": "wrongpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == "Current password is incorrect."


@pytest.mark.asyncio
async def test_change_current_user_password_wrong_current_password_does_not_change_password(
    async_client, db: Session
):
    response = await async_client.post(
        "/api/user/password",
        json={
            "current_password": "wrongpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_400_BAD_REQUEST
    assert_stored_password(db, "test@example.com", "testpassword", True)
    assert_stored_password(db, "test@example.com", "newpassword", False)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload, detail",
    [
        (
            {"current_password": "", "password": "newpassword", "password2": "newpassword"},
            "Current password is required.",
        ),
        (
            {"current_password": "testpassword", "password": "", "password2": ""},
            "New password is required.",
        ),
        (
            {"current_password": "testpassword", "password": "newpassword", "password2": "differentpassword"},
            "Passwords do not match.",
        ),
        (
            {"current_password": "testpassword", "password": "short", "password2": "short"},
            "Password too short.",
        ),
    ],
)
async def test_change_current_user_password_rejects_invalid_payloads(
    async_client, db: Session, payload, detail
):
    response = await async_client.post("/api/user/password", json=payload)

    assert response.status_code == HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == detail
    assert_stored_password(db, "test@example.com", "testpassword", True)
    if payload["password"]:
        assert_stored_password(db, "test@example.com", payload["password"], False)


@pytest.mark.asyncio
async def test_change_current_user_password_requires_all_fields(async_client):
    response = await async_client.post("/api/user/password", json={"current_password": "testpassword"})

    assert response.status_code == HTTP_422_UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_get_current_user_disabled_with_hassio_run_mode(async_client, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config.config, "HASSIO_RUN_MODE", "ingress")

    response = await async_client.get("/api/user")

    assert response.status_code == HTTP_401_UNAUTHORIZED
    assert response.json()["detail"] == "Account management is not available with HASSIO_RUN_MODE."


@pytest.mark.asyncio
async def test_change_current_user_email_disabled_with_hassio_run_mode(async_client, db: Session, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config.config, "HASSIO_RUN_MODE", "ingress")

    response = await async_client.post("/api/user/email", json={"email": "new@example.com"})

    assert response.status_code == HTTP_401_UNAUTHORIZED
    assert response.json()["detail"] == "Account management is not available with HASSIO_RUN_MODE."
    db.expire_all()
    assert_stored_password(db, "test@example.com", "testpassword", True)
    assert db.query(User).filter_by(email="new@example.com").first() is None


@pytest.mark.asyncio
async def test_change_current_user_password_disabled_with_hassio_run_mode(async_client, db: Session, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config.config, "HASSIO_RUN_MODE", "ingress")

    response = await async_client.post(
        "/api/user/password",
        json={
            "current_password": "testpassword",
            "password": "newpassword",
            "password2": "newpassword",
        },
    )

    assert response.status_code == HTTP_401_UNAUTHORIZED
    assert response.json()["detail"] == "Account management is not available with HASSIO_RUN_MODE."
    assert_stored_password(db, "test@example.com", "testpassword", True)
    assert_stored_password(db, "test@example.com", "newpassword", False)
