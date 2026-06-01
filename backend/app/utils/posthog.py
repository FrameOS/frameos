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
posthog_clients_by_project: dict[int, Posthog] = {}
posthog_settings_by_project: dict[int, dict[str, bool]] = {}
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


def initialize_posthog(settings: Optional[dict[str, Any]] = None, project_id: int | None = None) -> None:
    """Initialize PostHog client from settings.

    Project-scoped settings are kept separate so one tenant's PostHog key cannot
    receive another tenant's backend error or LLM analytics events.
    """
    global posthog_client
    global posthog_settings
    resolved = _resolve_posthog_settings(settings)
    token = resolved["api_key"]
    host = resolved["host"]
    resolved_flags = {
        "enable_error_tracking": bool(resolved["enable_error_tracking"]),
        "enable_llm_analytics": bool(resolved["enable_llm_analytics"]),
    }

    if project_id is not None:
        posthog_settings_by_project[project_id] = resolved_flags
        if host and token and (resolved_flags["enable_error_tracking"] or resolved_flags["enable_llm_analytics"]):
            posthog_clients_by_project[project_id] = Posthog(project_api_key=token, host=host)
        else:
            posthog_clients_by_project.pop(project_id, None)
        return

    posthog_settings = resolved_flags
    if host and token and (resolved_flags["enable_error_tracking"] or resolved_flags["enable_llm_analytics"]):
        posthog_client = Posthog(project_api_key=token, host=host)
    else:
        posthog_client = None


def _active_project_id() -> int | None:
    try:
        from app.tenancy import current_project_id

        return current_project_id()
    except RuntimeError:
        return None


def get_posthog_client(project_id: int | None = None) -> Posthog | None:
    project_id = project_id if project_id is not None else _active_project_id()
    if project_id is not None:
        return posthog_clients_by_project.get(project_id)
    return posthog_client


def posthog_project_initialized(project_id: int) -> bool:
    return project_id in posthog_settings_by_project


def llm_analytics_enabled(project_id: int | None = None) -> bool:
    project_id = project_id if project_id is not None else _active_project_id()
    if project_id is not None:
        return (
            posthog_clients_by_project.get(project_id) is not None
            and posthog_settings_by_project.get(project_id, {}).get("enable_llm_analytics", False)
        )
    return posthog_client is not None and posthog_settings.get("enable_llm_analytics", False)


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
    project_id = _active_project_id()
    client = get_posthog_client(project_id)
    if project_id is not None:
        enable_error_tracking = posthog_settings_by_project.get(project_id, {}).get("enable_error_tracking", False)
    else:
        enable_error_tracking = posthog_settings.get("enable_error_tracking", False)
    if client is None or not enable_error_tracking:
        return

    kwargs: dict[str, Any] = {}
    if request is not None:
        email = _get_email_from_request(request)
        if email:
            kwargs["distinct_id"] = email
            kwargs["properties"] = {"email": email}  # TODO: decouple
    try:
        client.capture_exception(exc, **kwargs)
    except Exception:
        # Avoid raising exceptions from PostHog itself
        pass
