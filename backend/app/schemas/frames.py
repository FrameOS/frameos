from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator, model_validator
from typing import Any, Dict, List, Literal, Optional

from .common import ImageTokenResponse
from datetime import datetime


class FrameHttpsProxyCerts(BaseModel):
    server: Optional[str] = None
    server_key: Optional[str] = None
    client_ca: Optional[str] = None


class FrameHttpsProxy(BaseModel):
    enable: Optional[bool] = None
    port: Optional[int] = None
    expose_only_port: Optional[bool] = None
    certs: Optional[FrameHttpsProxyCerts] = None
    server_cert_not_valid_after: Optional[datetime] = None
    client_ca_cert_not_valid_after: Optional[datetime] = None


class FrameErrorBehavior(BaseModel):
    mode: Optional[Literal["safe_mode", "show_error_retry", "silent_retry"]] = None
    retry_seconds: Optional[int] = None
    silent_retry_seconds: Optional[int] = None
    silent_retry_forever: Optional[bool] = None
    silent_window_minutes: Optional[int] = None
    show_error_retry_seconds: Optional[int] = None

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_silent_window(cls, value: Any) -> Any:
        if isinstance(value, dict) and "silent_window_minutes" not in value and "silent_retry_minutes" in value:
            return {**value, "silent_window_minutes": value.get("silent_retry_minutes")}
        return value


class FrameTimezoneUpdater(BaseModel):
    enabled: Optional[bool] = None
    hour: Optional[int] = None
    url: Optional[str] = None

    @field_validator('hour')
    @classmethod
    def validate_hour(cls, value: Optional[int]) -> Optional[int]:
        if value is not None and (value < 0 or value > 23):
            raise ValueError('Timezone update hour must be between 0 and 23')
        return value


class FrameSyncHint(BaseModel):
    has_changes: bool
    checked_at: Optional[str] = None
    current_revision: Optional[str] = None
    deployed_revision: Optional[str] = None
    frame_config_modified_at: Optional[str] = None
    scenes_modified_at: Optional[str] = None
    last_successful_deploy_at: Optional[str] = None


class FrameBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    mode: Optional[str] = None
    frame_host: str
    frame_port: int
    frame_access_key: Optional[str]
    frame_access: Optional[str]
    frame_admin_auth: Optional[Dict[str, Any]] = None
    https_proxy: Optional[FrameHttpsProxy] = None
    ssh_user: Optional[str]
    ssh_pass: Optional[str]
    ssh_port: int
    ssh_keys: Optional[List[str]] = None
    server_host: Optional[str]
    server_port: int
    server_api_key: Optional[str]
    server_send_logs: Optional[bool]
    status: str
    archived: bool = False
    version: Optional[str]
    width: Optional[int]
    height: Optional[int]
    device: Optional[str]
    device_config: Optional[Dict[str, Any]] = None
    color: Optional[str]
    timezone: Optional[str] = None
    timezone_updater: Optional[FrameTimezoneUpdater] = None
    interval: float
    metrics_interval: float
    max_http_response_bytes: Optional[int] = None
    scaling_mode: Optional[str]
    image_engine: Optional[Literal["", "pixie", "imagemagick"]] = None
    rotate: Optional[int]
    flip: Optional[str]
    background_color: Optional[str]
    debug: Optional[bool]
    last_log_at: Optional[datetime]
    log_to_file: Optional[str]
    assets_path: Optional[str]
    save_assets: Any
    upload_fonts: Optional[str]
    reboot: Any
    control_code: Any
    scenes: Optional[List[Dict[str, Any]]]
    schedule: Optional[Dict[str, Any]]
    gpio_buttons: Optional[List[Dict[str, Any]]]
    network: Optional[Dict[str, Any]]
    agent: Optional[Dict[str, Any]]
    mountpoints: Optional[Dict[str, Any]]
    error_behavior: Optional[FrameErrorBehavior] = None
    palette: Optional[Dict[str, Any]]
    buildroot: Optional[Dict[str, Any]] = None
    embedded: Optional[Dict[str, Any]] = None
    rpios: Optional[Dict[str, Any]] = None
    terminal_history: Optional[List[str]] = None
    last_successful_deploy: Optional[Dict[str, Any]]
    last_successful_deploy_at: Optional[datetime]
    active_connections: Optional[int] = None
    active_scene_id: Optional[str] = None
    frame_sync_hint: Optional[FrameSyncHint] = None

class FrameResponse(BaseModel):
    frame: FrameBase

class FramesListResponse(BaseModel):
    frames: List[FrameBase]

class FrameCreateRequest(BaseModel):
    mode: Optional[Literal["rpios", "buildroot", "embedded"]] = None
    name: str
    frame_host: str
    server_host: str
    interval: Optional[float] = None
    device: Optional[str] = None
    device_config: Optional[Dict[str, Any]] = None
    ssh_pass: Optional[str] = None
    ssh_keys: Optional[List[str]] = None
    platform: Optional[str] = None
    network: Optional[Dict[str, Any]] = None
    gpio_buttons: Optional[List[Dict[str, Any]]] = None
    agent: Optional[Dict[str, Any]] = None
    embedded: Optional[Dict[str, Any]] = None
    timezone: Optional[str] = None

class FrameUpdateRequest(BaseModel):
    scenes: Optional[List[Any]] = None
    mode: Optional[Literal["rpios", "buildroot", "embedded"]] = None
    name: Optional[str] = None
    frame_host: Optional[str] = None
    frame_port: Optional[int] = None
    frame_access_key: Optional[str] = None
    frame_access: Optional[str] = None
    frame_admin_auth: Optional[Dict[str, Any]] = None
    https_proxy: Optional[FrameHttpsProxy] = None
    ssh_user: Optional[str] = None
    ssh_pass: Optional[str] = None
    ssh_port: Optional[int] = None
    ssh_keys: Optional[List[str]] = None
    server_host: Optional[str] = None
    server_port: Optional[int] = None
    server_api_key: Optional[str] = None
    server_send_logs: Optional[bool] = None
    archived: Optional[bool] = None
    width: Optional[int] = None
    height: Optional[int] = None
    rotate: Optional[int] = None
    flip: Optional[str] = None
    color: Optional[str] = None
    timezone: Optional[str] = None
    timezone_updater: Optional[FrameTimezoneUpdater] = None
    interval: Optional[float] = None
    metrics_interval: Optional[float] = None
    max_http_response_bytes: Optional[int] = None
    log_to_file: Optional[str] = None
    assets_path: Optional[str] = None
    save_assets: Any = None
    upload_fonts: Optional[str] = None
    scaling_mode: Optional[str] = None
    image_engine: Optional[Literal["", "pixie", "imagemagick"]] = None
    device: Optional[str] = None
    device_config: Optional[Dict[str, Any]] = None
    debug: Optional[bool] = None
    reboot: Any = None
    control_code: Any = None
    schedule: Optional[Dict[str, Any]] = None
    gpio_buttons: Optional[List[Dict[str, Any]]] = None
    network: Optional[Dict[str, Any]] = None
    agent: Optional[Dict[str, Any]] = None
    mountpoints: Optional[Dict[str, Any]] = None
    error_behavior: Optional[FrameErrorBehavior] = None
    palette: Optional[Dict[str, Any]] = None
    buildroot: Optional[Dict[str, Any]] = None
    embedded: Optional[Dict[str, Any]] = None
    rpios: Optional[Dict[str, Any]] = None
    terminal_history: Optional[List[str]] = None
    next_action: Optional[str] = None

    @field_validator('max_http_response_bytes')
    @classmethod
    def validate_max_http_response_bytes(cls, value: Optional[int]) -> Optional[int]:
        if value is not None and value < 1024:
            raise ValueError('Maximum HTTP response size must be at least 1024 bytes')
        return value

    @field_validator('frame_admin_auth')
    @classmethod
    def validate_frame_admin_auth(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not value:
            return value

        auth = dict(value)
        if auth.get('enabled'):
            user = str(auth.get('user', '')).strip()
            password = str(auth.get('pass', '')).strip()
            if not user or not password:
                raise ValueError('Username and password are required when frame admin is enabled')

        return value


class FrameSSHKeysUpdateRequest(BaseModel):
    ssh_keys: List[str]

class FrameLogsResponse(BaseModel):
    logs: List[Dict[str, Any]]

class FrameMetricsResponse(BaseModel):
    metrics: List[Dict[str, Any]]
    reboots: List[Dict[str, Any]] = Field(default_factory=list)

class FrameImageLinkResponse(ImageTokenResponse):
    pass

class FrameStateResponse(RootModel):
    # The state is returned as JSON
    pass

class FrameUploadedScenesResponse(BaseModel):
    scenes: List[Dict[str, Any]]


class FrameAssetsCacheResponse(BaseModel):
    cached: bool = False
    refreshing: bool = False
    fetched_at: Optional[float] = None
    refresh_after: Optional[int] = None
    retry_after: Optional[int] = None


class FrameAssetsResponse(BaseModel):
    assets: List[Dict[str, Any]]
    cache: Optional[FrameAssetsCacheResponse] = None


class FramePingResponse(BaseModel):
    ok: bool
    mode: Literal["icmp", "http"]
    target: str
    elapsed_ms: Optional[float] = None
    status: Optional[int] = None
    message: str


class FrameBootstrapResponse(BaseModel):
    script_url: str
    command: str


class FrameSetNextSceneRequest(BaseModel):
    sceneId: str
    state: Optional[Dict[str, Any]] = None
    fastDeploy: Optional[bool] = True


class FrameSyncApplyRequest(BaseModel):
    frame_json: Optional[Literal["backend", "frame", "ignore"]] = "ignore"
    scenes_json: Optional[Literal["backend", "frame", "ignore"]] = "ignore"
    frame_json_choices: Optional[Dict[str, Literal["backend", "frame", "ignore"]]] = None
    scenes_json_choices: Optional[Dict[str, Literal["backend", "frame", "both", "ignore"]]] = None
