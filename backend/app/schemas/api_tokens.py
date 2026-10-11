from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.models.api_token import MAX_API_TOKEN_NAME_LENGTH, MAX_API_TOKEN_TTL_DAYS


class ApiTokenPayload(BaseModel):
    id: str
    name: str
    hint: str
    access: str
    expires_at: Optional[str] = None
    last_used_at: Optional[str] = None
    revoked_at: Optional[str] = None
    created_at: Optional[str] = None


class ApiTokensListResponse(BaseModel):
    api_tokens: list[ApiTokenPayload]
    live_count: int
    max_tokens: int
    default_ttl_days: int
    max_ttl_days: int
    # Whether the caller may mint one: a browser session (not a token), and
    # local account management available (not Home Assistant ingress).
    can_create: bool
    mcp_url: str


class ApiTokenCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_API_TOKEN_NAME_LENGTH)
    access: Literal["full", "read_only"] = "full"
    # Omitted means the default TTL; every token expires, so `null` is a 400.
    expires_in_days: Optional[int] = Field(default=None, ge=1, le=MAX_API_TOKEN_TTL_DAYS)
    # The session is being turned into a durable credential, so the owner
    # proves it is them — the same gate the email and password changes have.
    current_password: Optional[str] = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Give the token a name")
        return value


class ApiTokenCreateResponse(BaseModel):
    token: str
    api_token: ApiTokenPayload
