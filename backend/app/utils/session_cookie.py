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
    expires_delta: datetime.timedelta | None = None,
) -> tuple[str, int]:
    now = datetime.datetime.utcnow()
    ttl = expires_delta or datetime.timedelta(minutes=SESSION_EXPIRE_MINUTES)
    expire_at = now + ttl
    payload = {
        "sub": email,
        "exp": int(expire_at.timestamp()),
    }
    token = _session_fernet().encrypt(json.dumps(payload).encode()).decode()
    return token, int(ttl.total_seconds())


def decode_session_cookie_value(cookie_value: str | None) -> str | None:
    if not cookie_value:
        return None

    try:
        payload_raw = _session_fernet().decrypt(cookie_value.encode())
        payload = json.loads(payload_raw.decode())
    except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError):
        return None

    email = payload.get("sub")
    exp = payload.get("exp")
    if not isinstance(email, str) or not isinstance(exp, int):
        return None

    if datetime.datetime.utcnow().timestamp() > exp:
        return None

    return email
