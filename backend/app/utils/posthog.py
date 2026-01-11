from typing import Optional, Any
from fastapi import Request
from jose import jwt, JWTError
from posthog import Posthog

from app.config import config

posthog_client: Posthog | None = None
posthog_settings: dict[str, bool] = {
    "enable_error_tracking": False,
    "enable_llm_analytics": False,
}
DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"


def _resolve_posthog_settings(settings: Optional[dict[str, Any]]) -> dict[str, Any]:
    posthog_config = (settings or {}).get("posthog") or {}
    api_key = posthog_config.get("backendApiKey")
    host = posthog_config.get("backendHost") or DEFAULT_POSTHOG_HOST
    enable_error_tracking = posthog_config.get("backendEnableErrorTracking")
    enable_llm_analytics = posthog_config.get("backendEnableLlmAnalytics")
    if enable_error_tracking is None:
        enable_error_tracking = bool(api_key)
    if enable_llm_analytics is None:
        enable_llm_analytics = False
    return {
        "api_key": api_key,
        "host": host,
        "enable_error_tracking": enable_error_tracking,
        "enable_llm_analytics": enable_llm_analytics,
    }


def initialize_posthog(settings: Optional[dict[str, Any]] = None) -> None:
    """Initialize PostHog client from settings."""
    global posthog_client
    global posthog_settings
    resolved = _resolve_posthog_settings(settings)
    token = resolved["api_key"]
    host = resolved["host"]
    posthog_settings = {
        "enable_error_tracking": bool(resolved["enable_error_tracking"]),
        "enable_llm_analytics": bool(resolved["enable_llm_analytics"]),
    }
    if host and token and (posthog_settings["enable_error_tracking"] or posthog_settings["enable_llm_analytics"]):
        posthog_client = Posthog(project_api_key=token, host=host)
    else:
        posthog_client = None


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
    if posthog_client is None or not posthog_settings.get("enable_error_tracking"):
        return

    kwargs: dict[str, Any] = {}
    if request is not None:
        email = _get_email_from_request(request)
        if email:
            kwargs["distinct_id"] = email
            kwargs["properties"] = {"email": email}  # TODO: decouple
    try:
        posthog_client.capture_exception(exc, **kwargs)
    except Exception:
        # Avoid raising exceptions from PostHog itself
        pass


def llm_analytics_enabled() -> bool:
    return posthog_client is not None and posthog_settings.get("enable_llm_analytics", False)


def capture_llm_event(event: str, properties: Optional[dict[str, Any]] = None) -> None:
    if not llm_analytics_enabled():
        return
    try:
        posthog_client.capture(
            distinct_id=config.INSTANCE_ID,
            event=event,
            properties=properties or {},
        )
    except Exception:
        # Avoid raising exceptions from PostHog itself
        pass
