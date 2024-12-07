from typing import Optional, List, Any
from datetime import datetime
from pydantic import BaseModel

class FrameBase(BaseModel):
    name: str
    frame_host: str
    frame_port: Optional[int] = 8787
    frame_access_key: Optional[str]
    frame_access: Optional[str]
    ssh_user: Optional[str]
    ssh_pass: Optional[str]
    ssh_port: Optional[int] = 22
    server_host: Optional[str]
    server_port: Optional[int] = 8989
    server_api_key: Optional[str]
    status: str
    version: Optional[str]
    width: Optional[int]
    height: Optional[int]
    device: Optional[str]
    color: Optional[str]
    interval: float = 300
    metrics_interval: float = 60
    scaling_mode: Optional[str]
    rotate: Optional[int]
    log_to_file: Optional[str]
    assets_path: Optional[str]
    save_assets: Optional[Any]
    debug: Optional[bool]
    last_log_at: Optional[datetime]
    reboot: Optional[Any]
    control_code: Optional[Any]
    apps: Optional[List[Any]]
    scenes: Optional[List[Any]]
    image_url: Optional[str]
    background_color: Optional[str]

class FrameCreate(BaseModel):
    name: str
    frame_host: str
    server_host: str
    device: Optional[str] = "web_only"
    interval: Optional[float] = 60

class FrameUpdate(BaseModel):
    # Include fields that can be updated
    name: Optional[str]
    frame_host: Optional[str]
    # ... and so on for other fields
    # For simplicity, just showing a few:
    scenes: Optional[List[Any]]
    next_action: Optional[str]

class FrameOut(FrameBase):
    id: int

    class Config:
        orm_mode = True
