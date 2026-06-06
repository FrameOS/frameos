from __future__ import annotations

from typing import Literal

from sqlalchemy.orm import Session

from app.models.settings import get_settings_dict

BuildEnvironmentProvider = Literal["none", "docker", "buildHost", "modal"]
BUILD_ENVIRONMENT_PROVIDERS: set[str] = {"none", "docker", "buildHost", "modal"}


def normalize_build_environment_provider(value: object) -> BuildEnvironmentProvider | None:
    if value in BUILD_ENVIRONMENT_PROVIDERS:
        return value  # type: ignore[return-value]
    return None


def selected_build_environment_provider(settings: dict | None) -> BuildEnvironmentProvider:
    settings = settings or {}
    raw = settings.get("buildEnvironment")
    if isinstance(raw, dict):
        provider = normalize_build_environment_provider(raw.get("provider"))
        if provider:
            return provider

    # Backward-compatible inference for existing installations before the
    # provider became a single explicit choice.
    modal = settings.get("modalSandbox")
    if isinstance(modal, dict) and modal.get("enabled"):
        return "modal"
    build_host = settings.get("buildHost")
    if isinstance(build_host, dict) and build_host.get("enabled"):
        return "buildHost"
    return "docker"


def get_selected_build_environment_provider(
    db: Session | None,
    project_id: int | None = None,
) -> BuildEnvironmentProvider:
    if db is None or project_id is None:
        return "docker"
    return selected_build_environment_provider(get_settings_dict(db, project_id=project_id))


def server_side_compilation_enabled(settings: dict | None) -> bool:
    return selected_build_environment_provider(settings) != "none"
