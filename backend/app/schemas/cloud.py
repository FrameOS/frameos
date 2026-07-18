from pydantic import BaseModel, RootModel


class CloudStatusResponse(RootModel):
    pass


class CloudConnectRequest(BaseModel):
    provider_url: str | None = None
    scopes: list[str] | None = None


class CloudProviderUpdateRequest(BaseModel):
    provider_url: str


class CloudLoginStartRequest(BaseModel):
    # Same-origin path to land on after a successful cloud login.
    next: str | None = None


class CloudLoginStartResponse(BaseModel):
    authorization_url: str


class CloudLoginOptionsResponse(BaseModel):
    # True when "Continue with FrameOS Cloud" can be offered on the login page.
    available: bool
    provider_url: str | None = None
    # False when local password login has been disabled in favor of cloud login.
    local_login_enabled: bool = True
    # True while no local user exists yet (first-run setup).
    setup_mode: bool = False


class CloudLocalFallbackRequest(BaseModel):
    enabled: bool


class CloudFeaturesRequest(BaseModel):
    # The full desired set of feature scopes (base link scopes are implied).
    scopes: list[str]


class CloudBackupFeaturesRequest(BaseModel):
    # Local on/off switches for what actually gets uploaded; omitted fields
    # stay unchanged. The backup scopes themselves come with the account.
    scenes: bool | None = None
    frames: bool | None = None


class CloudBackupSaveTemplateRequest(BaseModel):
    template_id: str


class CloudBackupSaveFrameRequest(BaseModel):
    frame_id: int


class CloudBackupRestoreRequest(BaseModel):
    backup_id: str
    project_id: int
