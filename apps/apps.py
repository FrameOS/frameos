from dataclasses import dataclass
from typing import Dict, Optional, Any, Callable, List
from PIL import Image

@dataclass
class ConfigField:
    name: str
    type: str
    required: bool = False

@dataclass
class FrameApp:
    keyword: str
    name: str
    config: Dict
    description: str
    version: str
    fields: List[ConfigField]

@dataclass
class FrameConfig:
    status: str
    version: str
    width: int
    height: int
    device: str
    color: str
    image_url: str
    interval: float
    apps: List[FrameApp]

@dataclass
class ProcessImagePayload:
    next_image: Optional[Image.Image]
    current_image: Optional[Image.Image]


class App:
    def __init__(self, name: str, frame_config: FrameConfig, app_config: Optional[Dict[str, None]], log_function: Callable[[Dict], Any]) -> None:
        self.name = name
        self.frame_config = frame_config
        self.app_config = app_config or {}
        self.log_function = log_function
    
    def log(self, message: str):
        if self.log_function:
            self.log_function({ "event": "app_log", "app": self.name, "message": message })
        
    def error(self, message: str):
        if self.log_function:
            self.log_function({ "event": "app_error", "app": self.name, "message": message })

    def process_image(payload: ProcessImagePayload):
        pass
