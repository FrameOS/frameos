from __future__ import annotations

"""Helpers for issuing and validating short-lived JWT tokens."""

from datetime import datetime, timedelta

from fastapi import HTTPException
from jose import JWTError, jwt

from app.api.auth import ALGORITHM, SECRET_KEY


DEFAULT_EXPIRE_MINUTES = 5


def create_scoped_token_response(
    subject: str,
    *,
    expire_minutes: int = DEFAULT_EXPIRE_MINUTES,
) -> dict[str, int | str]:
    """Return a ``{"token", "expires_in"}`` pair for the given scope."""

    now = datetime.utcnow()
    expire = now + timedelta(minutes=expire_minutes)
    payload = {"sub": subject, "exp": expire}
    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return {"token": token, "expires_in": int((expire - now).total_seconds())}


def validate_scoped_token(token: str | None, *, expected_subject: str) -> None:
    """Validate that *token* is a JWT for *expected_subject*.

    Raises ``HTTPException(status_code=401)`` if validation fails.
    """

    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError as exc:  # pragma: no cover - jose provides rich exceptions
        raise HTTPException(status_code=401, detail="Unauthorized") from exc

    if payload.get("sub") != expected_subject:
        raise HTTPException(status_code=401, detail="Unauthorized")

