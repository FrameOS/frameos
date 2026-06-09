from typing import Any, Literal

from pydantic import BaseModel


class CloudAuthPublicStatus(BaseModel):
    provider_enabled: bool
    provider_url: str | None = None
    status: str = "provider_disabled"
    local_fallback_enabled: bool = True


class CloudMembershipResponse(BaseModel):
    cloud_account_id: str
    cloud_organization_id: str
    cloud_project_id: str | None = None
    role: str
    local_organization_id: int | None = None
    local_project_id: int | None = None
    updated_at: str | None = None
    synced_at: str | None = None


class CloudBackendLinkResponse(BaseModel):
    status: str
    provider_url: str
    provider_issuer: str | None = None
    user_code: str | None = None
    verification_uri: str | None = None
    verification_uri_complete: str | None = None
    expires_at: str | None = None
    interval_seconds: int = 5
    poll_error: str | None = None
    token_reference: str | None = None
    linked_client_id: str | None = None
    cloud_organization_id: str | None = None
    cloud_project_id: str | None = None
    local_project_id: int | None = None
    local_organization_id: int | None = None
    local_fallback_enabled: bool = True
    last_inventory_sync_at: str | None = None
    last_grant_sync_at: str | None = None
    revoked_at: str | None = None


class CloudAuthStatusResponse(CloudAuthPublicStatus):
    link: CloudBackendLinkResponse | None = None
    memberships: list[CloudMembershipResponse] = []
    current_user_cloud_identities: list[dict[str, Any]] = []


class CloudBackendLinkStartRequest(BaseModel):
    public_display_name: str | None = None
    local_origin: str | None = None


class CloudBackendLinkStartResponse(CloudAuthStatusResponse):
    pass


class CloudBackendLinkPollResponse(CloudAuthStatusResponse):
    pass


class CloudLocalFallbackUpdateRequest(BaseModel):
    enabled: bool


class CloudLinkSyncResponse(CloudAuthStatusResponse):
    inventory_synced: bool = False
    grants_synced: bool = False
    errors: list[str] = []


class CloudTokenRotateResponse(CloudAuthStatusResponse):
    rotated: bool = False


class CloudOidcIntentResponse(BaseModel):
    intent: Literal["login", "signup"] = "login"
