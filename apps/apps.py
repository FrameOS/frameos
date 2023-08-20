from dataclasses import dataclass
from typing import Dict, Optional, Any, Callable, List
from PIL import Image

@dataclass
class ConfigField:
    name: str
    type: str
    required: Optional[bool] = False
    options: Optional[List[str]] = None
    value: Optional[Any] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None

@dataclass
class AppConfig:
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
    interval: float
    scaling_mode: str
    apps: List[AppConfig]

@dataclass
class ProcessImagePayload:
    next_image: Optional[Image.Image]
    current_image: Optional[Image.Image]


class App:
    def __init__(self, name: str, frame_config: FrameConfig, app_config: AppConfig, log_function: Callable[[Dict], Any]) -> None:
        self.name = name
        self.frame_config = frame_config
        self.app_config = app_config
        self.log_function = log_function
        self.config: Dict = self.app_config.config or {}
    
    def log(self, message: str):
        if self.log_function:
            self.log_function({ "event": f"{self.app_config.keyword}:log", "message": message })
        
    def error(self, message: str):
        if self.log_function:
            self.log_function({ "event": f"{self.name}:error", "message": message })

    def process_image(payload: ProcessImagePayload):
        pass
