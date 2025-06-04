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


def capture_exception(exc: Exception) -> None:
    """Capture an exception with PostHog if initialized."""
    if posthog_client is None:
        return
    try:
        posthog_client.capture_exception(exc)
    except Exception:
        # Avoid raising exceptions from PostHog itself
        pass