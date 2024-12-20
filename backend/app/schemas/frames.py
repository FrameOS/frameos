from pydantic import BaseModel, RootModel
from typing import Any, Dict, List, Optional
from datetime import datetime

class FrameBase(BaseModel):
    id: int
    name: str
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
    color: Optional[str]
    interval: float
    metrics_interval: float
    scaling_mode: Optional[str]
    rotate: Optional[int]
    background_color: Optional[str]
    debug: Optional[bool]
    last_log_at: Optional[datetime]
    log_to_file: Optional[str]
    assets_path: Optional[str]
    save_assets: Any
    reboot: Any
    control_code: Any
    scenes: Optional[List[Dict[str, Any]]]

    class Config:
        orm_mode = True

class FrameResponse(BaseModel):
    frame: FrameBase

class FramesListResponse(BaseModel):
    frames: List[FrameBase]

class FrameCreateRequest(BaseModel):
    name: str
    frame_host: str
    server_host: str
    interval: Optional[float] = None
    device: Optional[str] = None

class FrameUpdateRequest(BaseModel):
    scenes: Optional[List[Any]] = None
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
    color: Optional[str] = None
    interval: Optional[float] = None
    metrics_interval: Optional[float] = None
    log_to_file: Optional[str] = None
    assets_path: Optional[str] = None
    save_assets: Any = None
    scaling_mode: Optional[str] = None
    device: Optional[str] = None
    debug: Optional[bool] = None
    reboot: Any = None
    control_code: Any = None
    next_action: Optional[str] = None

class FrameLogsResponse(BaseModel):
    logs: List[Dict[str, Any]]

class FrameMetricsResponse(BaseModel):
    metrics: List[Dict[str, Any]]

class FrameImageLinkResponse(BaseModel):
    url: str
    expires_in: int

class FrameStateResponse(RootModel):
    # The state is returned as JSON
    pass

class FrameAssetsResponse(BaseModel):
    assets: List[Dict[str, Any]]
