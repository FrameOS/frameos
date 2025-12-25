from pydantic import BaseModel, ConfigDict, RootModel
from typing import Any, Dict, List, Literal, Optional

from .common import ImageTokenResponse
from datetime import datetime

class FrameBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    mode: Optional[str] = None
    frame_host: str
    frame_port: int
    frame_access_key: Optional[str]
    frame_access: Optional[str]
    ssh_user: Optional[str]
    ssh_pass: Optional[str]
    ssh_port: int
    server_host: Optional[str]
    server_port: int
    server_api_key: Optional[str]
    status: str
    version: Optional[str]
    width: Optional[int]
    height: Optional[int]
    device: Optional[str]
    device_config: Optional[Dict[str, Any]] = None
    color: Optional[str]
    interval: float
    metrics_interval: float
    scaling_mode: Optional[str]
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
    palette: Optional[Dict[str, Any]]
    nix: Optional[Dict[str, Any]] = None
    buildroot: Optional[Dict[str, Any]] = None
    rpios: Optional[Dict[str, Any]] = None
    last_successful_deploy: Optional[Dict[str, Any]]
    last_successful_deploy_at: Optional[datetime]
    active_connections: Optional[int] = None

class FrameResponse(BaseModel):
    frame: FrameBase

class FramesListResponse(BaseModel):
    frames: List[FrameBase]

class FrameCreateRequest(BaseModel):
    mode: Optional[str] = None
    name: str
    frame_host: str
    server_host: str
    interval: Optional[float] = None
    device: Optional[str] = None
    platform: Optional[str] = None

class FrameUpdateRequest(BaseModel):
    scenes: Optional[List[Any]] = None
    mode: Optional[str] = None
    name: Optional[str] = None
    frame_host: Optional[str] = None
    frame_port: Optional[int] = None
    frame_access_key: Optional[str] = None
    frame_access: Optional[str] = None
    ssh_user: Optional[str] = None
    ssh_pass: Optional[str] = None
    ssh_port: Optional[int] = None
    server_host: Optional[str] = None
    server_port: Optional[int] = None
    server_api_key: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    rotate: Optional[int] = None
    flip: Optional[str] = None
    color: Optional[str] = None
    interval: Optional[float] = None
    metrics_interval: Optional[float] = None
    log_to_file: Optional[str] = None
    assets_path: Optional[str] = None
    save_assets: Any = None
    upload_fonts: Optional[str] = None
    scaling_mode: Optional[str] = None
    device: Optional[str] = None
    device_config: Optional[Dict[str, Any]] = None
    debug: Optional[bool] = None
    reboot: Any = None
    control_code: Any = None
    schedule: Optional[Dict[str, Any]] = None
    gpio_buttons: Optional[List[Dict[str, Any]]] = None
    network: Optional[Dict[str, Any]] = None
    agent: Optional[Dict[str, Any]] = None
    palette: Optional[Dict[str, Any]] = None
    nix: Optional[Dict[str, Any]] = None
    buildroot: Optional[Dict[str, Any]] = None
    rpios: Optional[Dict[str, Any]] = None
    next_action: Optional[str] = None

class FrameLogsResponse(BaseModel):
    logs: List[Dict[str, Any]]

class FrameMetricsResponse(BaseModel):
    metrics: List[Dict[str, Any]]

class FrameImageLinkResponse(ImageTokenResponse):
    pass

class FrameStateResponse(RootModel):
    # The state is returned as JSON
    pass

class FrameAssetsResponse(BaseModel):
    assets: List[Dict[str, Any]]


class FramePingResponse(BaseModel):
    ok: bool
    mode: Literal["icmp", "http"]
    target: str
    elapsed_ms: Optional[float] = None
    status: Optional[int] = None
    message: str
