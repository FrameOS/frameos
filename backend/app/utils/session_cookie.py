import base64
import datetime
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken

from app.config import config

SESSION_COOKIE_NAME = "frameos_session"
SESSION_EXPIRE_MINUTES = 7 * 24 * 60


def _session_fernet() -> Fernet:
    digest = hashlib.sha256(config.SECRET_KEY.encode()).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def create_session_cookie_value(
    *,
    email: str,
    session_id: str,
    expires_delta: datetime.timedelta | None = None,
) -> tuple[str, int]:
    """`session_id` is the jti of a `user_session` row; without a live row the
    cookie is worthless, which is what makes logout and revocation real."""
    now = datetime.datetime.utcnow()
    ttl = expires_delta or datetime.timedelta(minutes=SESSION_EXPIRE_MINUTES)
    expire_at = now + ttl
    payload = {
        "sub": email,
        "exp": int(expire_at.timestamp()),
        "jti": session_id,
    }
    token = _session_fernet().encrypt(json.dumps(payload).encode()).decode()
    return token, int(ttl.total_seconds())


def decode_session_cookie_claims(cookie_value: str | None) -> tuple[str, str] | None:
    """Returns (email, session_id), or None when the cookie is unusable.

    Cookies minted before sessions were recorded carry no jti and are rejected:
    there is no row to check them against, and treating them as valid would
    leave a seven-day window in which revocation still did nothing.
    """
    if not cookie_value:
        return None

    try:
        payload_raw = _session_fernet().decrypt(cookie_value.encode())
        payload = json.loads(payload_raw.decode())
    except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError):
        return None

    email = payload.get("sub")
    exp = payload.get("exp")
    session_id = payload.get("jti")
    if not isinstance(email, str) or not isinstance(exp, int) or not isinstance(session_id, str):
        return None

    if datetime.datetime.utcnow().timestamp() > exp:
        return None

    return email, session_id
