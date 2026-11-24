import pytest

from app import config as app_config
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


@pytest.mark.asyncio
async def test_a_burst_of_guesses_gets_no_more_checks_than_the_threshold(no_auth_client, redis, db):
    """The attempt is counted before the password is looked at, in one step
    with the lock check. Counted afterwards, every request of a concurrent
    burst passed the lock check before any of them had failed."""
    import asyncio

    from app.api import auth
    from app.api.auth import LOGIN_LOCKOUT_THRESHOLD

    user = User(email="burst@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    checked = 0
    real_check = auth.check_password_hash

    def counting_check(hashed, password):
        nonlocal checked
        checked += 1
        return real_check(hashed, password)

    auth.check_password_hash = counting_check
    try:
        responses = await asyncio.gather(*(
            no_auth_client.post("/api/login", data={"username": "burst@example.com", "password": f"guess-{n}"})
            for n in range(40)
        ))
    finally:
        auth.check_password_hash = real_check
    statuses = sorted(response.status_code for response in responses)
    assert statuses.count(HTTP_401_UNAUTHORIZED) == LOGIN_LOCKOUT_THRESHOLD
    assert statuses.count(HTTP_429_TOO_MANY_REQUESTS) == 40 - LOGIN_LOCKOUT_THRESHOLD
    assert checked == LOGIN_LOCKOUT_THRESHOLD


@pytest.mark.asyncio
async def test_only_failures_count_against_an_address(no_auth_client, redis, db):
    from app.api.auth import LOGIN_IP_LIMIT
    from app.utils.rate_limit import rate_limit_key

    user = User(email="steady@example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    good = {"username": "steady@example.com", "password": "testpassword"}
    for _ in range(3):
        assert (await no_auth_client.post("/api/login", data=good)).status_code == HTTP_200_OK
    await no_auth_client.post("/api/login", data={"username": "nobody@example.com", "password": "x"})
    keys = [key async for key in redis.scan_iter(match=rate_limit_key("login_ip", "*").rsplit(":", 1)[0] + "*")]
    assert len(keys) == 1 and int(await redis.get(keys[0])) == 1

    # An address at its limit is refused before any account is touched.
    await redis.set(keys[0], LOGIN_IP_LIMIT)
    assert (await no_auth_client.post("/api/login", data=good)).status_code == HTTP_429_TOO_MANY_REQUESTS


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
async def test_login_lookup_is_case_insensitive_like_the_lockout(no_auth_client, redis, db):
    """The lockout keys on the lower-cased address; the lookup used to match
    the stored spelling exactly, so `Mixed@Example.com` counted failures
    against the account but could never sign in to it."""
    user = User(email="Mixed@Example.com")
    user.set_password("testpassword")
    db.add(user)
    db.commit()

    for typed in ("mixed@example.com", "MIXED@EXAMPLE.COM", " Mixed@Example.com "):
        resp = await no_auth_client.post("/api/login", data={"username": typed, "password": "testpassword"})
        assert resp.status_code == HTTP_200_OK, typed


def test_find_user_by_login_email_prefers_the_exact_spelling(db):
    from app.api.auth import find_user_by_login_email

    for email in ("dup@example.com", "Dup@Example.com", "solo@example.com"):
        user = User(email=email)
        user.set_password("testpassword")
        db.add(user)
    db.commit()

    assert find_user_by_login_email(db, "Dup@Example.com").email == "Dup@Example.com"
    assert find_user_by_login_email(db, "dup@example.com").email == "dup@example.com"
    # Two rows differ only in case and neither is the typed spelling.
    assert find_user_by_login_email(db, "DUP@EXAMPLE.COM") is None
    assert find_user_by_login_email(db, "SOLO@example.com").email == "solo@example.com"
    assert find_user_by_login_email(db, "  ") is None


def test_first_signup_lock_serialises_a_second_signup(db):
    """Two first signups used to both pass the empty-table check. With the
    lock held, the second blocks until the first commits and then sees its
    user."""
    import threading
    import time

    from app.api.auth import lock_user_table_for_first_signup
    from app.database import SessionLocal

    db.query(User).delete()
    db.commit()

    lock_user_table_for_first_signup(db)
    assert db.query(User).first() is None
    first = User(email="first@example.com")
    first.set_password("testpassword")
    db.add(first)
    db.flush()

    seen: dict[str, str | None] = {}

    def second_signup() -> None:
        other = SessionLocal()
        try:
            lock_user_table_for_first_signup(other)
            existing = other.query(User).first()
            seen["email"] = existing.email if existing else None
        finally:
            other.rollback()
            other.close()

    thread = threading.Thread(target=second_signup)
    thread.start()
    time.sleep(0.5)
    assert thread.is_alive(), "the second signup did not wait for the first"
    db.commit()
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert seen["email"] == "first@example.com"


@pytest.mark.asyncio
async def test_login_per_ip_failure_limit(no_auth_client, redis, db, monkeypatch):
    from app.api import auth as auth_module

    monkeypatch.setattr(auth_module, "LOGIN_IP_LIMIT", 3)
    for i in range(3):
        resp = await no_auth_client.post("/api/login", data={"username": f"user{i}@example.com", "password": "x"})
        assert resp.status_code == HTTP_401_UNAUTHORIZED
    resp = await no_auth_client.post("/api/login", data={"username": "user9@example.com", "password": "x"})
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    # The limiter keys on the address, so a forwarded header counts only from
    # a proxy named in FRAMEOS_TRUSTED_PROXIES — never from the implicit
    # private-range trust, which every LAN peer would satisfy.
    forwarded = {"X-Forwarded-For": "203.0.113.9"}
    resp = await no_auth_client.post("/api/login", data={"username": "user9@example.com", "password": "x"}, headers=forwarded)
    assert resp.status_code == HTTP_429_TOO_MANY_REQUESTS
    monkeypatch.setattr(app_config.config, "FRAMEOS_TRUSTED_PROXIES", "127.0.0.1, testclient")
    resp = await no_auth_client.post("/api/login", data={"username": "user9@example.com", "password": "x"}, headers=forwarded)
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


# -- first-run signup is the local network's ----------------------------------

SIGNUP = {"email": "first@example.com", "password": "newpassword", "password2": "newpassword", "newsletter": False}


@pytest.mark.asyncio
async def test_signup_answers_on_local_names_only(no_auth_client, db, monkeypatch):
    """A public name in Host on a first-run request is a browser pointed at a
    domain that resolves to this backend (DNS rebinding): it must not be
    able to make the first account, or read the token the answer carries."""
    for host in ("evil.example.com", "192.168.1.20.evil.example.com:8989"):
        response = await no_auth_client.post("/api/signup", json=SIGNUP, headers={"Host": host})
        assert response.status_code == 403, host
        assert "FRAMEOS_SETUP_ALLOWED_HOSTS" in response.json()["detail"]
        assert "access_token" not in response.text
    assert db.query(User).count() == 0

    # The address the owner said the install is reached at is theirs.
    monkeypatch.setattr(app_config.config, "FRAMEOS_PUBLIC_URL", "https://frames.example.com")
    assert (await no_auth_client.post("/api/signup", json=SIGNUP, headers={"Host": "other.example.com"})).status_code == 403
    response = await no_auth_client.post("/api/signup", json=SIGNUP, headers={"Host": "frames.example.com"})
    assert response.status_code == HTTP_200_OK and response.json()["access_token"]


@pytest.mark.asyncio
async def test_signup_by_address_or_local_name(no_auth_client, db):
    response = await no_auth_client.post("/api/signup", json=SIGNUP, headers={"Host": "192.168.1.20:8989"})
    assert response.status_code == HTTP_200_OK
    # With an account made, the answer is the old one whatever the name.
    again = await no_auth_client.post("/api/signup", json=SIGNUP, headers={"Host": "evil.example.com"})
    assert again.status_code == HTTP_400_BAD_REQUEST


# -- a session answers for its own account only --------------------------------

@pytest.mark.asyncio
async def test_a_session_does_not_answer_for_another_account(no_auth_client, db):
    """A credential names its account by email and its session by id. A
    session opened for one account must not be good for whichever account
    carries that address (an address changed, then taken by someone else)."""
    import datetime

    from app.api.auth import create_access_token
    from app.models.user_session import create_user_session
    from app.utils.session_cookie import SESSION_COOKIE_NAME, create_session_cookie_value

    users = []
    for email in ("first@example.com", "second@example.com"):
        user = User(email=email)
        user.set_password("testpassword")
        db.add(user)
        db.commit()
        db.refresh(user)
        users.append(user)
    first, second = users
    session_id = create_user_session(
        db, user_id=first.id, expires_at=datetime.datetime.utcnow() + datetime.timedelta(hours=1)
    )
    week = datetime.timedelta(days=7)

    own = create_access_token({"sub": first.email, "jti": session_id})
    assert (await no_auth_client.get("/api/user", headers={"Authorization": f"Bearer {own}"})).status_code == HTTP_200_OK

    # The same live session under the other account's address: bearer and cookie.
    crossed = create_access_token({"sub": second.email, "jti": session_id})
    response = await no_auth_client.get("/api/user", headers={"Authorization": f"Bearer {crossed}"})
    assert response.status_code == HTTP_401_UNAUTHORIZED
    cookie, _ = create_session_cookie_value(email=second.email, session_id=session_id, expires_delta=week)
    response = await no_auth_client.get("/api/user", headers={"Cookie": f"{SESSION_COOKIE_NAME}={cookie}"})
    assert response.status_code == HTTP_401_UNAUTHORIZED


# -- the forms anyone can post have a ceiling ----------------------------------

@pytest.mark.asyncio
async def test_login_and_signup_bodies_have_a_ceiling(no_auth_client, db):
    big = "x" * (200 * 1024)
    response = await no_auth_client.post("/api/login", data={"username": "a@example.com", "password": big})
    assert response.status_code == 413
    response = await no_auth_client.post("/api/signup", json={**SIGNUP, "password": big, "password2": big})
    assert response.status_code == 413

    async def streamed():
        for _ in range(8):
            yield b"y" * (32 * 1024)

    # No Content-Length to refuse on: cut off as it passes the cap.
    response = await no_auth_client.post(
        "/api/login", content=streamed(), headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    assert response.status_code == 413
    assert db.query(User).count() == 0
    # An ordinary form is untouched.
    response = await no_auth_client.post("/api/login", data={"username": "a@example.com", "password": "nope"})
    assert response.status_code == HTTP_401_UNAUTHORIZED


def test_the_app_config_cannot_close_its_script_element():
    import json

    from app.fastapi import script_json

    config = {"ingress_path": "/x</script><script>alert(1)</script><!--", "note": "a & b"}
    rendered = script_json(config)
    assert "<" not in rendered and ">" not in rendered and "&" not in rendered
    assert json.loads(rendered) == config


def test_a_bearer_minted_before_the_switch_to_pyjwt_still_reads():
    """python-jose made the tokens of every session open at the upgrade; the
    same HS256 JWT must still decode, and anything else must not."""
    import base64
    import hashlib
    import hmac
    import json

    from app.api.auth import ALGORITHM, SECRET_KEY, JWTError, _decode_jwt_claims

    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    def token(claims: dict, key: str = SECRET_KEY, alg: str = ALGORITHM) -> str:
        head = b64(json.dumps({"alg": alg, "typ": "JWT"}, separators=(",", ":")).encode())
        body = b64(json.dumps(claims, separators=(",", ":")).encode())
        digest = hashlib.sha256 if alg == "HS256" else hashlib.sha512
        signature = b64(hmac.new(key.encode(), f"{head}.{body}".encode(), digest).digest())
        return f"{head}.{body}.{signature}"

    import time

    later = int(time.time()) + 3600
    assert _decode_jwt_claims(token({"sub": "a@example.com", "jti": "s1", "exp": later})) == ("a@example.com", "s1")
    for bad in (
        token({"sub": "a@example.com", "jti": "s1", "exp": int(time.time()) - 10}),
        token({"sub": "a@example.com", "jti": "s1", "exp": later}, key="another-key-of-enough-length-000000"),
        token({"sub": "a@example.com", "jti": "s1", "exp": later}, alg="HS512"),
        token({"sub": "a@example.com", "exp": later}),
        "not.a.token",
    ):
        with pytest.raises(JWTError):
            _decode_jwt_claims(bad)
