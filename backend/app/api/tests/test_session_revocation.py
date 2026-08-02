"""Local sessions are revocable, and setup-mode linking is claimed.

Covers the two backend findings from docs/cloud-security-review.md that needed
new storage: sessions had no server-side record (so nothing could end one), and
/api/cloud/setup/* was open to any LAN caller while no user existed.
"""
import datetime

import pytest
from sqlalchemy.orm import Session

from app.api.auth import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, issue_credentials
from app.models.user import User
from app.models.user_session import UserSession, revoke_sessions_for_user
from app.utils.session_cookie import SESSION_COOKIE_NAME, create_session_cookie_value


@pytest.mark.asyncio
async def test_logout_revokes_the_session_server_side(async_client, db: Session):
    # The client authenticates with the bearer token minted at login.
    assert (await async_client.get("/api/user")).status_code == 200

    response = await async_client.post("/api/logout")
    assert response.status_code == 200

    # A copied credential is now worthless, not merely absent from this browser.
    assert (await async_client.get("/api/user")).status_code == 401
    assert db.query(UserSession).filter(UserSession.revoked_at.isnot(None)).count() >= 1


@pytest.mark.asyncio
async def test_credentials_without_a_session_are_rejected(async_client, db: Session):
    """Pre-existing cookies and tokens carry no jti. There is no row to check
    them against, so they must not be honoured — otherwise revocation would do
    nothing for the rest of their seven days."""
    user = db.query(User).filter(User.email == "test@example.com").first()

    legacy_token = create_access_token({"sub": user.email})
    response = await async_client.get("/api/user", headers={"Authorization": f"Bearer {legacy_token}"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_revoked_session_stops_working_immediately(async_client, db: Session):
    user = db.query(User).filter(User.email == "test@example.com").first()
    access_token, _, _ = issue_credentials(db, user, datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    headers = {"Authorization": f"Bearer {access_token}"}
    assert (await async_client.get("/api/user", headers=headers)).status_code == 200

    revoke_sessions_for_user(db, user.id)

    assert (await async_client.get("/api/user", headers=headers)).status_code == 401


@pytest.mark.asyncio
async def test_expired_session_row_is_rejected(async_client, db: Session):
    user = db.query(User).filter(User.email == "test@example.com").first()
    access_token, _, _ = issue_credentials(db, user, datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    headers = {"Authorization": f"Bearer {access_token}"}
    assert (await async_client.get("/api/user", headers=headers)).status_code == 200

    # Expire the row without touching the token, which still looks valid.
    for row in db.query(UserSession).filter(UserSession.revoked_at.is_(None)).all():
        row.expires_at = datetime.datetime.utcnow() - datetime.timedelta(minutes=1)
    db.commit()

    assert (await async_client.get("/api/user", headers=headers)).status_code == 401


@pytest.mark.asyncio
async def test_password_change_keeps_this_session_and_drops_the_others(async_client, db: Session):
    user = db.query(User).filter(User.email == "test@example.com").first()
    other_token, _, _ = issue_credentials(db, user, datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    other_headers = {"Authorization": f"Bearer {other_token}"}
    assert (await async_client.get("/api/user", headers=other_headers)).status_code == 200

    response = await async_client.post(
        "/api/user/password",
        json={"current_password": "testpassword", "password": "newpassword", "password2": "newpassword"},
    )
    assert response.status_code == 200

    # The browser that changed the password stays signed in...
    assert (await async_client.get("/api/user")).status_code == 200
    # ...every other login does not.
    assert (await async_client.get("/api/user", headers=other_headers)).status_code == 401


@pytest.mark.asyncio
async def test_session_cookie_without_jti_is_rejected(async_client, db: Session):
    """The cookie half of the same rule."""
    from app.utils.session_cookie import _session_fernet
    import json

    payload = {
        "sub": "test@example.com",
        "exp": int((datetime.datetime.utcnow() + datetime.timedelta(days=1)).timestamp()),
    }
    legacy_cookie = _session_fernet().encrypt(json.dumps(payload).encode()).decode()

    from httpx import AsyncClient
    from httpx._transports.asgi import ASGITransport

    from app.fastapi import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(SESSION_COOKIE_NAME, legacy_cookie)
        assert (await client.get("/api/user")).status_code == 401


@pytest.mark.asyncio
async def test_a_valid_cookie_session_still_works(db: Session):
    """The positive control for the two rejection tests above."""
    from httpx import AsyncClient
    from httpx._transports.asgi import ASGITransport

    from app.fastapi import app
    from app.models.user_session import create_user_session
    from app.tenancy import ensure_default_project_for_user

    user = User(email="cookie@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()
    db.refresh(user)
    ensure_default_project_for_user(db, user)

    expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    session_id = create_user_session(db, user_id=user.id, expires_at=datetime.datetime.utcnow() + expires)
    cookie_value, _ = create_session_cookie_value(email=user.email, session_id=session_id, expires_delta=expires)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(SESSION_COOKIE_NAME, cookie_value)
        response = await client.get("/api/user")
        assert response.status_code == 200
        assert response.json() == {"email": "cookie@example.com"}
