import datetime
from typing import Optional

from fastapi import Depends, HTTPException, status, Request, Response, WebSocket
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
import jwt
from jwt import PyJWTError as JWTError
from sqlalchemy import func, text
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis
from app import config as app_config
from app.models.user import User
from app.models.api_token import (
    ApiTokenIdentity,
    api_token_access_from_prefix,
    authenticate_api_token,
    is_api_token,
)
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
from app.utils.rate_limit import clear_rate_limit, hit_rate_limit, rate_limit_key
from app.utils.request_ip import client_ip_for_request
from app.utils.same_origin import hosts_match as _hosts_match, origin_is_ours  # noqa: F401

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


def find_user_by_login_email(db: Session, email: str) -> User | None:
    """The login name is case-insensitive, like the lockout keyed on it
    (`normalize_login_email`): `Me@Example.com` and `me@example.com` are one
    account. Emails are stored as typed, so the match is on `lower()`; where
    old rows differ only in case, the exact spelling wins and otherwise the
    name is ambiguous and matches nobody."""
    account = normalize_login_email(email)
    if not account:
        return None
    candidates = db.query(User).filter(func.lower(User.email) == account).all()
    typed = (email or "").strip()
    for candidate in candidates:
        if candidate.email == typed:
            return candidate
    return candidates[0] if len(candidates) == 1 else None


def lock_user_table_for_first_signup(db: Session) -> None:
    """Hold the user table's write lock until this transaction ends.

    Postgres: a self-conflicting table lock. SQLite has one writer lock for
    the whole database, and any write statement takes it — even one that
    touches no rows — so a zero-row DELETE opens the write transaction; a
    second signup blocks on it (busy timeout) until the first commits."""
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        db.execute(text('LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE'))
    elif dialect == "sqlite":
        db.execute(text('DELETE FROM "user" WHERE 0'))


def login_lockout_seconds(failures: int) -> int:
    if failures < LOGIN_LOCKOUT_THRESHOLD:
        return 0
    return min(LOGIN_LOCKOUT_BASE_SECONDS * (2 ** (failures - LOGIN_LOCKOUT_THRESHOLD)), LOGIN_LOCKOUT_MAX_SECONDS)


# One attempt, counted before the password is looked at and in one step with
# the lock check: reading the lock, verifying and counting the failure
# afterwards let every request of a concurrent burst pass the read before any
# of them had counted (five hundred guesses, five hundred checks). KEYS: the
# lock, the failure counter. ARGV: the counter's window, the threshold, the
# base lock and the longest. Answers minus the seconds left on a lock, or the
# attempt's number; the attempt that reaches the threshold sets the lock
# itself, so the ones behind it find it.
_LOGIN_ATTEMPT_SCRIPT = """
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then
  return -ttl
end
local failures = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
local threshold = tonumber(ARGV[2])
if failures >= threshold then
  local lock = tonumber(ARGV[3]) * 2 ^ math.min(failures - threshold, 30)
  if lock > tonumber(ARGV[4]) then
    lock = tonumber(ARGV[4])
  end
  redis.call('SET', KEYS[1], tostring(failures), 'EX', math.floor(lock))
end
return failures
"""


async def _count_login_attempt(redis: Redis, email: str) -> int:
    """Count this attempt against the account as a failure (a success takes
    it back, `_clear_login_failures`). Returns 0 to go on and verify, or the
    seconds the account is locked for."""
    outcome = int(
        await redis.eval(
            _LOGIN_ATTEMPT_SCRIPT,
            2,
            rate_limit_key("login_lock", email),
            rate_limit_key("login_failures", email),
            LOGIN_FAILURE_WINDOW_SECONDS,
            LOGIN_LOCKOUT_THRESHOLD,
            LOGIN_LOCKOUT_BASE_SECONDS,
            LOGIN_LOCKOUT_MAX_SECONDS,
        )
    )
    return -outcome if outcome < 0 else 0


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


SAFE_HTTP_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _api_token_user(request: Request, db: Session, token: str) -> User:
    """A personal API token (app/models/api_token.py) in the bearer slot.

    Resolved to its owner exactly where a login JWT would be, so no route
    changes. The identity lands on `request.state.api_token` for the routes
    that must refuse tokens (`require_session_credential`) and for the MCP
    server's `account_info`. A read-only token is refused for anything but a
    safe method here — the one place that sees method and credential
    together — with the same `read_only_token` code the cloud uses."""
    authenticated = authenticate_api_token(db, token)
    if authenticated is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API token refused: revoked, expired, or not minted by this server",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user_id, identity = authenticated
    # The MCP endpoint is a POST by transport, not by effect: its tool calls
    # reach the routes as separate in-process requests carrying this same
    # token, and those are where a read-only token meets a real mutation.
    is_mcp_transport = request.url.path.rstrip("/").endswith("/api/mcp")
    if identity.read_only and request.method.upper() not in SAFE_HTTP_METHODS and not is_mcp_transport:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "read_only_token", "message": "This API token is read-only"},
        )
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials")
    request.state.api_token = identity
    return user


def request_api_token(request: Request) -> ApiTokenIdentity | None:
    """The API token this request authenticated with, if any."""
    return getattr(request.state, "api_token", None)


def _bearer_is_api_token(request: Request) -> bool:
    """Whether the bearer slot holds an API token, read off the header so the
    answer does not depend on the user dependency having run first (it sets
    `request.state.api_token`; a route-level dependency may run before it)."""
    authorization = request.headers.get("authorization") or ""
    return authorization.startswith("Bearer ") and is_api_token(authorization.split(" ", 1)[1])


def require_session_credential(request: Request) -> None:
    """Refuse API tokens on the routes that turn a session into something
    more durable (minting a token, linking the install or an identity to a
    cloud account, the backup recovery code) or change the login itself
    (email, password, whether the password still works): a leaked token must
    not be able to make itself permanent. Usable as a route dependency."""
    if request_api_token(request) is not None or _bearer_is_api_token(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "api_token_not_allowed",
                "message": "This action needs a browser sign-in and is not available to API tokens",
            },
        )


def request_token_is_read_only(request: Request) -> bool:
    """Whether this request carries a read-only API token."""
    token = request_api_token(request)
    if token is not None:
        return token.read_only
    authorization = request.headers.get("authorization") or ""
    bearer = authorization.split(" ", 1)[1] if authorization.startswith("Bearer ") else ""
    return is_api_token(bearer) and api_token_access_from_prefix(bearer) == "read_only"


def refuse_read_only_token(request: Request) -> None:
    """Refuse a read-only token on a GET whose answer is credentials (a
    backup with every frame's keys, a provisioning command list, an SD
    image). The read-only rule is the HTTP method, and these reads would let
    "may look" become "may log in to every frame". Usable as a route
    dependency."""
    if request_token_is_read_only(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "read_only_token",
                "message": "This read hands out credentials and is not available to read-only API tokens",
            },
        )


def _session_user(db: Session, email: str, session_id: str) -> User | None:
    """The account a credential names, when its session is alive and that
    account's own. The email alone is not enough: a session opened for one
    account must not answer for whichever account carries that address
    later (an address changed, then taken by another user)."""
    user = db.query(User).filter(User.email == email).first()
    if user is None or not session_is_active(db, session_id, user.id):
        return None
    return user


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
    user = _session_user(db, email, session_id)
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
    if authorization is None:
        authorization = request.headers.get("authorization")
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1]
    if token:
        if is_api_token(token):
            try:
                return _api_token_user(request, db, token)
            except HTTPException as exc:
                # A read-only token on a mutation is a refusal the caller
                # must see, not an anonymous 401.
                if exc.status_code == status.HTTP_403_FORBIDDEN:
                    raise
                return None
        try:
            return await get_current_user_from_jwt(token, db)
        except HTTPException:
            return None

    claims = decode_session_cookie_claims(request.cookies.get(SESSION_COOKIE_NAME))
    if claims is None:
        return None
    email, session_id = claims
    return _session_user(db, email, session_id)


def websocket_origin_allowed(websocket: WebSocket) -> bool:
    """Whether a WebSocket handshake comes from a page on this backend.

    Browsers always send `Origin` on a WebSocket handshake and it cannot be
    set by page script, so a mismatch against the host the browser dialled
    is a cross-site page opening a socket with the user's cookie (SameSite=Lax
    does not cover WebSockets). Non-browser clients send no Origin and pass;
    the cookie check that follows still applies to them. What counts as the
    host the browser dialled is `origin_is_ours` (app/utils/same_origin.py),
    shared with the guard on cookie-authenticated mutations."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    peer = websocket.client.host if websocket.client else None
    return origin_is_ours(origin, websocket.headers, peer)


def get_current_user_from_websocket(
    websocket: WebSocket,
    db: Session,
) -> tuple[User | None, str | None]:
    # Cookie only. The `?token=<jwt>` query form nothing in the SPA ever sent
    # is gone: a bearer in a URL lands in proxy and browser logs, and the
    # session cookie already rides every handshake from the same origin.
    if not websocket_origin_allowed(websocket):
        return None, "Origin not allowed"

    cookie_value = websocket.cookies.get(SESSION_COOKIE_NAME)
    claims = decode_session_cookie_claims(cookie_value)
    if claims is None:
        return None, "Missing token"
    email, session_id = claims
    if not session_is_active(db, session_id):
        return None, "Session revoked"

    user = _session_user(db, email, session_id)
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
    if token and is_api_token(token):
        return _api_token_user(request, db, token)

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

    user = _session_user(db, email, session_id)
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
    # Strict: the limiter keys on this address, so a header any LAN peer can
    # set must not pick the bucket (docs/cloud-link.md, FRAMEOS_TRUSTED_PROXIES).
    ip = client_ip_for_request(request, strict=True) or "unknown"
    # Both counters move before the password is looked at (a success takes
    # its count back): checked first and counted after, a burst of requests
    # all passed the check.
    if await hit_rate_limit(redis, "login_ip", ip, limit=LOGIN_IP_LIMIT, window_seconds=LOGIN_IP_WINDOW_SECONDS):
        raise HTTPException(status_code=429, detail="Too many login attempts")
    locked_for = await _count_login_attempt(redis, account)
    if locked_for:
        raise HTTPException(
            status_code=429, detail="Too many login attempts", headers={"Retry-After": str(locked_for)}
        )

    user = find_user_by_login_email(db, email)
    # Cloud-created users (first-run cloud signup) have no local password.
    if user is None or not user.password or not check_password_hash(user.password, password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    from app.tenancy import ensure_default_project_for_user

    ensure_default_project_for_user(db, user)

    await _clear_login_failures(redis, account)
    # Only failures count against the address.
    await redis.decr(rate_limit_key("login_ip", ip))
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

    # Check if there is already a user registered (one-user system). The
    # check and the insert below are separate statements, so two first
    # signups (two workers) could both see an empty table; the lock makes the
    # second wait for the first to commit and then see its user.
    lock_user_table_for_first_signup(db)
    if db.query(User).first() is not None:
        raise HTTPException(status_code=400, detail="Only one user is allowed. Please login!")

    # The first account is made from the network the install lives on, like
    # the rest of first-run setup: a public name in Host here is a browser
    # pointed at somebody's domain that resolves to this backend's LAN
    # address (DNS rebinding), which could otherwise claim a fresh install
    # and read the token below.
    from app.api.cloud import SETUP_HOST_REFUSAL, setup_host_allowed

    if not setup_host_allowed(request.headers.get("host")):
        raise HTTPException(status_code=403, detail=SETUP_HOST_REFUSAL)

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
