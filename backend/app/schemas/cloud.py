from pydantic import BaseModel, RootModel


class CloudStatusResponse(RootModel):
    pass


class CloudConnectRequest(BaseModel):
    provider_url: str | None = None
    scopes: list[str] | None = None


class CloudProviderUpdateRequest(BaseModel):
    provider_url: str
