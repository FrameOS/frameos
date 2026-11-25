from typing import Any, Dict, List, Optional

from pydantic import ConfigDict, RootModel, BaseModel, model_validator

from app.utils.service_keys import SERVICE_FIELD_PATTERN, is_service_id, read_service_credentials


class SettingsResponse(RootModel):
    pass


class SettingsUpdateRequest(BaseModel):
    """The groups `POST /api/settings` stores — the ones the settings form
    and its helpers post (frontend/src/types.tsx `FrameOSSettings`), plus the
    default key of ANY service (docs/service-keys.md: a group named after a
    service id, its values strings) and the further keys
    (`serviceCredentials`). Anything else is a 422: the row store used to
    take any key, so a stray field became a permanent, unreadable,
    unremovable settings row."""

    model_config = ConfigDict(extra="allow")

    defaults: Optional[Dict[str, Any]] = None
    homeAssistant: Optional[Dict[str, Any]] = None
    frameOS: Optional[Dict[str, Any]] = None
    github: Optional[Dict[str, Any]] = None
    immich: Optional[Dict[str, Any]] = None
    openAI: Optional[Dict[str, Any]] = None
    posthog: Optional[Dict[str, Any]] = None
    repositories: Optional[List[Any]] = None
    personal: Optional[Dict[str, Any]] = None
    ssh_keys: Optional[Dict[str, Any]] = None
    unsplash: Optional[Dict[str, Any]] = None
    buildEnvironment: Optional[Dict[str, Any]] = None
    buildHost: Optional[Dict[str, Any]] = None
    modalSandbox: Optional[Dict[str, Any]] = None
    serviceCredentials: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def _extra_groups_are_services(self):
        """An undeclared group is a service's default key: a service id, a
        map of field name to string (or null, cleared)."""
        for key, value in (self.model_extra or {}).items():
            if not is_service_id(key):
                raise ValueError(f"Unknown settings group {key!r}")
            if value is None:
                continue
            if not isinstance(value, dict) or not all(
                isinstance(name, str) and SERVICE_FIELD_PATTERN.fullmatch(name) and (v is None or isinstance(v, str))
                for name, v in value.items()
            ):
                raise ValueError(f"Settings group {key!r} must map field names to strings")
        if self.serviceCredentials is not None:
            # Only well-formed keys are kept: an id `k_…`, a service id, string values.
            self.serviceCredentials = read_service_credentials(self.serviceCredentials)
        return self

    def to_dict(self) -> Dict[str, Any]:
        return self.model_dump(exclude_unset=True)
