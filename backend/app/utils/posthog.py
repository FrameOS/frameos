from typing import Optional, Any
from fastapi import Request
from jose import jwt, JWTError
from posthog import Posthog

from app.config import config

posthog_client: Posthog | None = None


def initialize_posthog() -> None:
    """Initialize PostHog client from settings."""
    global posthog_client
    token = config.POSTHOG_API_KEY
    host = config.POSTHOG_HOST
    if host and token:
        posthog_client = Posthog(project_api_key=token, host=host)


def _get_email_from_request(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization")
    if not auth or not auth.startswith("Bearer ") or not config.SECRET_KEY:
        return None
    token = auth.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, config.SECRET_KEY, algorithms=["HS256"])
    except JWTError:
        return None
    return payload.get("sub")


def capture_exception(exc: Exception, request: Optional[Request] = None) -> None:
    """Capture an exception with PostHog if initialized."""
    if posthog_client is None:
        return

    kwargs: dict[str, Any] = {}
    if request is not None:
        email = _get_email_from_request(request)
        if email:
            kwargs["distinct_id"] = email
            kwargs["properties"] = {"email": email} # TODO: decouple
    try:
        posthog_client.capture_exception(exc, **kwargs)
    except Exception:
        # Avoid raising exceptions from PostHog itself
        pass
