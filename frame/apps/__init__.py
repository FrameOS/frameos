from dataclasses import dataclass
from typing import Dict, Optional, Any, Callable, List
from PIL import Image

# NOTE: This file is read by both the frame and the controller. Don't import anything too funky.

@dataclass
class ConfigField:
    name: str
    type: str
    required: Optional[bool] = False
    secret: Optional[bool] = False
    options: Optional[List[str]] = None
    value: Optional[Any] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None

@dataclass
class AppConfig:
    keyword: str
    name: Optional[str]
    config: Optional[Dict]
    description: Optional[str]
    version: Optional[str]
    fields: Optional[List[ConfigField]]

@dataclass
class Edge:
    id: str
    source: str
    target: str
    sourceHandle: Optional[str] = None
    targetHandle: Optional[str] = None

@dataclass
class Node:
    id: str
    type: str
    data: Dict
    # skipping less relevant fields

@dataclass
class FrameScene:
  id: str
  nodes: List[Node]
  edges: List[Edge]


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
    background_color: str
    rotate: int
    scenes: List[FrameScene]

@dataclass
class ProcessImagePayload:
    next_image: Optional[Image.Image]
    current_image: Optional[Image.Image]


class App:
    def __init__(self, keyword: str, config: Dict, frame_config: FrameConfig, log_function: Callable[[Dict], Any]) -> None:
        self.frame_config = frame_config
        self.config = config
        self.keyword = keyword
        self.log_function = log_function

    def log(self, message: str):
        if self.log_function:
            self.log_function({ "event": f"{self.keyword}:log", "message": message })
        
    def error(self, message: str):
        if self.log_function:
            self.log_function({ "event": f"{self.keyword}:error", "message": message })

    def process_image(payload: ProcessImagePayload):
        pass
