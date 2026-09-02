import datetime
from typing import Optional

from fastapi import Depends, HTTPException, status, Request, Response, WebSocket
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import jwt, JWTError
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis
from app import config as app_config
from app.models.user import User
from app.database import get_db
from app.redis import get_redis
from werkzeug.security import generate_password_hash, check_password_hash
from app.schemas.auth import Token, UserSignup
from app.models.user_session import (
    create_user_session,
    revoke_user_session,
    session_is_active,
)
from app.utils.session_cookie import (
    SESSION_COOKIE_NAME,
    create_session_cookie_value,
    decode_session_cookie_claims,
)
from app.utils.rate_limit import clear_rate_limit, hit_rate_limit, over_rate_limit, rate_limit_key
from app.utils.request_ip import client_ip_for_request

from . import api_open, api_user

SECRET_KEY = app_config.config.SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 7 * 24 * 60  # 7 days

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login", auto_error=False)

# Failed logins lock the *account*, not the (IP, account) pair: behind a proxy
# every visitor shares one IP (so a pair lock is a trivial owner lockout) and
# from many IPs a pair lock is no brute-force limit at all. After
# LOGIN_LOCKOUT_THRESHOLD failures the account waits LOGIN_LOCKOUT_BASE_SECONDS,
# doubling per further failure up to LOGIN_LOCKOUT_MAX_SECONDS; a successful
# login clears it. A much looser per-IP failure counter still stops one address
# from hammering every account.
LOGIN_LOCKOUT_THRESHOLD = 5
LOGIN_LOCKOUT_BASE_SECONDS = 30
LOGIN_LOCKOUT_MAX_SECONDS = 15 * 60
LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60
LOGIN_IP_LIMIT = 100
LOGIN_IP_WINDOW_SECONDS = 15 * 60


def normalize_login_email(email: str) -> str:
    return (email or "").strip().lower()


def login_lockout_seconds(failures: int) -> int:
    if failures < LOGIN_LOCKOUT_THRESHOLD:
        return 0
    return min(LOGIN_LOCKOUT_BASE_SECONDS * (2 ** (failures - LOGIN_LOCKOUT_THRESHOLD)), LOGIN_LOCKOUT_MAX_SECONDS)


async def _login_locked_seconds(redis: Redis, email: str) -> int:
    ttl = await redis.ttl(rate_limit_key("login_lock", email))
    return max(int(ttl or 0), 0)


async def _record_login_failure(redis: Redis, email: str, ip: str) -> None:
    await hit_rate_limit(redis, "login_ip", ip, limit=LOGIN_IP_LIMIT, window_seconds=LOGIN_IP_WINDOW_SECONDS)
    failures_key = rate_limit_key("login_failures", email)
    failures = int(await redis.incr(failures_key))
    await redis.expire(failures_key, LOGIN_FAILURE_WINDOW_SECONDS)
    lock_seconds = login_lockout_seconds(failures)
    if lock_seconds:
        await redis.set(rate_limit_key("login_lock", email), str(failures), ex=lock_seconds)


async def _clear_login_failures(redis: Redis, email: str) -> None:
    await clear_rate_limit(redis, "login_failures", email)
    await clear_rate_limit(redis, "login_lock", email)


def _should_use_secure_cookie(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    return forwarded_proto == "https"

def create_access_token(data: dict, expires_delta: Optional[datetime.timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.datetime.utcnow() + expires_delta
    else:
        expire = datetime.datetime.utcnow() + datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def _decode_jwt_claims(token: str) -> tuple[str, str]:
    """Returns (email, session_id). Tokens minted before sessions were recorded
    have no jti and are rejected — there is no row to validate them against."""
    payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    email: str = payload.get("sub")
    session_id: str = payload.get("jti")
    if email is None:
        raise JWTError("Missing subject")
    if not session_id:
        raise JWTError("Missing session id")
    return email, session_id


def issue_credentials(
    db: Session, user: User, expires_delta: datetime.timedelta
) -> tuple[str, str, int]:
    """One session row per sign-in, referenced by both the bearer token and the
    cookie, so revoking it ends every credential handed out at that moment."""
    expires_at = datetime.datetime.utcnow() + expires_delta
    session_id = create_user_session(db, user_id=user.id, expires_at=expires_at)
    access_token = create_access_token(
        data={"sub": user.email, "jti": session_id}, expires_delta=expires_delta
    )
    session_value, max_age = create_session_cookie_value(
        email=user.email, session_id=session_id, expires_delta=expires_delta
    )
    return access_token, session_value, max_age


async def get_current_user_from_jwt(token: str, db: Session) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        email, session_id = _decode_jwt_claims(token)
    except JWTError:
        raise credentials_exception
    if not session_is_active(db, session_id):
        raise credentials_exception

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
    return user


def current_session_id(request: Request) -> str | None:
    """The session behind whichever credential authenticated this request."""
    authorization = request.headers.get("authorization") or ""
    if authorization.startswith("Bearer "):
        try:
            return _decode_jwt_claims(authorization.split(" ", 1)[1])[1]
        except JWTError:
            return None
    claims = decode_session_cookie_claims(request.cookies.get(SESSION_COOKIE_NAME))
    return claims[1] if claims else None


async def get_current_user_from_request(
    request: Request,
    db: Session,
    authorization: str | None = None,
) -> User | None:
    token: str | None = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1]
    if token:
        try:
            return await get_current_user_from_jwt(token, db)
        except HTTPException:
            return None

    claims = decode_session_cookie_claims(request.cookies.get(SESSION_COOKIE_NAME))
    if claims is None:
        return None
    email, session_id = claims
    if not session_is_active(db, session_id):
        return None
    return db.query(User).filter(User.email == email).first()


def get_current_user_from_websocket(
    websocket: WebSocket,
    db: Session,
) -> tuple[User | None, str | None]:
    token = websocket.query_params.get("token")
    if token:
        try:
            email, session_id = _decode_jwt_claims(token)
        except JWTError:
            return None, "Invalid token"
        if not session_is_active(db, session_id):
            return None, "Session revoked"
        user = db.query(User).filter(User.email == email).first()
        if user is None:
            return None, "User not found"
        return user, None

    cookie_value = websocket.cookies.get(SESSION_COOKIE_NAME)
    claims = decode_session_cookie_claims(cookie_value)
    if claims is None:
        return None, "Missing token"
    email, session_id = claims
    if not session_is_active(db, session_id):
        return None, "Session revoked"

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        return None, "User not found"
    return user, None


async def get_current_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    if app_config.config.HASSIO_RUN_MODE == "ingress":
        return None

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        if token:
            email, session_id = _decode_jwt_claims(token)
        else:
            claims = decode_session_cookie_claims(request.cookies.get(SESSION_COOKIE_NAME))
            if claims is None:
                raise credentials_exception
            email, session_id = claims
    except JWTError:
        raise credentials_exception

    if not session_is_active(db, session_id):
        raise credentials_exception

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
    return user

@api_open.post("/login", response_model=Token)
async def login(
    request: Request,
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if app_config.config.HASSIO_RUN_MODE is not None:
        raise HTTPException(status_code=401, detail="Login not allowed with HASSIO_RUN_MODE")

    # Cloud login can disable local passwords; the flag lives on the
    # cloud link and flips back to True whenever the link is lost, so this can
    # never lock an install out entirely.
    from app.models.cloud import current_cloud_backend_link

    cloud_link_row = current_cloud_backend_link(db)
    if (
        cloud_link_row is not None
        and cloud_link_row.status == "connected"
        and not cloud_link_row.local_fallback_enabled
    ):
        raise HTTPException(
            status_code=403,
            detail="Local password login is disabled on this install. Sign in with FrameOS Cloud.",
        )

    email = form_data.username
    password = form_data.password
    account = normalize_login_email(email)
    ip = client_ip_for_request(request) or "unknown"
    locked_for = await _login_locked_seconds(redis, account)
    if locked_for:
        raise HTTPException(
            status_code=429, detail="Too many login attempts", headers={"Retry-After": str(locked_for)}
        )
    if await over_rate_limit(redis, "login_ip", ip, limit=LOGIN_IP_LIMIT):
        raise HTTPException(status_code=429, detail="Too many login attempts")

    user = db.query(User).filter_by(email=email).first()
    # Cloud-created users (first-run cloud signup) have no local password.
    if user is None or not user.password or not check_password_hash(user.password, password):
        await _record_login_failure(redis, account, ip)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    from app.tenancy import ensure_default_project_for_user

    ensure_default_project_for_user(db, user)

    await _clear_login_failures(redis, account)
    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token, session_value, max_age = issue_credentials(db, user, access_token_expires)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )
    return {"access_token": access_token, "token_type": "bearer"}

@api_open.post("/signup")
async def signup(request: Request, data: UserSignup, response: Response, db: Session = Depends(get_db)):
    if app_config.config.HASSIO_RUN_MODE is not None:
        raise HTTPException(status_code=401, detail="Signup not allowed with HASSIO_RUN_MODE")

    # Check if there is already a user registered (one-user system)
    if db.query(User).first() is not None:
        raise HTTPException(status_code=400, detail="Only one user is allowed. Please login!")

    if not data.email:
        raise HTTPException(status_code=400, detail="Email is required.")
    if not data.password:
        raise HTTPException(status_code=400, detail="Password is required.")
    if data.password != data.password2:
        raise HTTPException(status_code=400, detail="Passwords do not match.")
    if len(data.password) < 8:
        raise HTTPException(status_code=400, detail="Password too short.")

    if db.query(User).filter_by(email=data.email).first():
        raise HTTPException(status_code=400, detail="Email already in use.")

    # if data.newsletter:
    #     async with httpx.AsyncClient() as client:
    #         response = await client.post(
    #             "https://buttondown.email/api/emails/embed-subscribe/frameos",
    #             data={ "email": data.email },
    #             timeout=15.0
    #         )
    #         if response.status_code not in (200, 301, 302):
    #             raise HTTPException(status_code=400, detail="Error signing up to newsletter.")

    user = User(email=data.email)
    user.password = generate_password_hash(data.password)
    db.add(user)
    db.commit()
    db.refresh(user)

    from app.tenancy import ensure_default_project_for_user

    ensure_default_project_for_user(db, user)

    # Auto-login after signup:
    access_token_expires = datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token, session_value, max_age = issue_credentials(db, user, access_token_expires)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=_should_use_secure_cookie(request),
    )
    return {"success": True, "access_token": access_token, "token_type": "bearer"}


@api_user.post("/logout")
async def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    # If this user signs in through FrameOS Cloud, the browser must also leave
    # the cloud session, or "Continue with FrameOS Cloud" on the login screen
    # would sign them straight back in. The frontend navigates to this URL; the
    # cloud validates the return_to against the link's origin and bounces back
    # to our login page.
    cloud_logout_url = None
    user = await get_current_user_from_request(request, db, request.headers.get("authorization"))

    # End the session server-side, not just in this browser: the cookie may
    # have been copied, and the bearer token issued alongside it is a second
    # credential the browser never held.
    authorization = request.headers.get("authorization") or ""
    if authorization.startswith("Bearer "):
        try:
            _, bearer_session_id = _decode_jwt_claims(authorization.split(" ", 1)[1])
            revoke_user_session(db, bearer_session_id)
        except JWTError:
            pass
    cookie_claims = decode_session_cookie_claims(request.cookies.get(SESSION_COOKIE_NAME))
    if cookie_claims is not None:
        revoke_user_session(db, cookie_claims[1])
    if user is not None:
        from urllib.parse import quote

        from app.api.cloud import _browser_origin, _connected_link, _link_has_scope
        from app.models.cloud import CloudIdentity

        link = _connected_link(db)
        if _link_has_scope(link, "auth:login"):
            identity = db.query(CloudIdentity).filter(CloudIdentity.user_id == user.id).first()
            if identity is not None:
                origin = _browser_origin(request) or ""
                return_to = quote(f"{origin}/login", safe="")
                cloud_logout_url = f"{link.provider_url}/logout?return_to={return_to}"

    response.delete_cookie(key=SESSION_COOKIE_NAME)
    return {"success": True, "cloud_logout_url": cloud_logout_url}
