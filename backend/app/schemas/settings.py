from typing import Any, Dict, List, Optional

from pydantic import ConfigDict, RootModel, BaseModel


class SettingsResponse(RootModel):
    pass


class SettingsUpdateRequest(BaseModel):
    """The groups `POST /api/settings` stores — exactly the ones the settings
    form and its helpers post (frontend/src/types.tsx `FrameOSSettings`).
    Anything else is a 422: the row store used to take any key, so a stray
    field became a permanent, unreadable, unremovable settings row."""

    model_config = ConfigDict(extra="forbid")

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

    def to_dict(self) -> Dict[str, Any]:
        return self.model_dump(exclude_unset=True)
