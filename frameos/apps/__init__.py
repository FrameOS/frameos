import re
import subprocess
from dataclasses import dataclass
from typing import Dict, Optional, Any, Callable, List, Union, TYPE_CHECKING
from PIL.Image import Image

if TYPE_CHECKING:
    from frameos.frame.app_handler import AppHandler

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
    rows: Optional[int] = None
    placeholder: Optional[str] = None

@dataclass
class MarkdownField:
    markdown: str

@dataclass
class AppConfig:
    keyword: str
    name: Optional[str]
    description: Optional[str]
    version: Optional[str]
    settings: Optional[List[str]]
    fields: Optional[List[Union[ConfigField, MarkdownField]]]

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
class FrameConfigScene:
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
    scenes: List[FrameConfigScene]
    settings: Dict

@dataclass
class ExecutionContext:
    event: str
    payload: Dict
    image: Optional[Image]
    state: Dict
    apps_ran: List[str]
    apps_errored: List[str]

class BreakExecution(Exception):
    pass

class App:
    def __init__(
            self,
            keyword: str,
            config: Dict,
            frame_config: FrameConfig,
            node: Node,
            app_handler: "AppHandler",
    ) -> None:
        self.keyword = keyword
        self.config = config
        self.frame_config = frame_config
        self.node: Node = node
        self.app_handler = app_handler
        self._log: Callable[[Dict], Any] = app_handler.logger.log
        self._last_context: Optional[ExecutionContext] = None
        self.__post_init__()

    def __post_init__(self):
        pass

    def rerender(self, trigger = None):
        self.app_handler.image_handler.render_image(self.keyword if trigger is None else trigger)

    def is_rendering(self):
        return self.app_handler.image_handler.image_update_in_progress

    def break_execution(self, message: Optional[str] = None):
        raise BreakExecution(message)

    def log(self, message: str):
        self._log({ "event": f"app:{self.keyword}", "message": message })
        
    def error(self, message: str):
        self._log({ "event": f"app:{self.keyword}:error", "message": message })

    def run(self, context: ExecutionContext):
        pass

    def get_config(self, key: str, default = None):
        text = self.config.get(key, default)
        return self.parse_str(text, self._last_context.state if self._last_context else {})

    def get_setting(self, key: Union[str, List[str]], default = None):
        key_list = (key if isinstance(key, list) else [key])
        start = self.frame_config.settings
        for i, k in enumerate(key_list):
            if start is not None:
                start = start.get(k, default if i == len(key_list) - 1 else {})
        return start

    def parse_str(self, text: str, state: Dict):
        def replace_with_state_value(match):
            keys = match.group(1).split('.')
            value = state
            for key in keys:
                try:
                    if isinstance(value, list):
                        value = value[int(key)]
                    else:
                        value = value[key]
                except (KeyError, TypeError):
                    return ''
            return str(value)
        return re.sub(r'{([^}]+)}', replace_with_state_value, text)

    def dispatch(self, event: str, payload: Optional[Dict] = None, image: Optional[Image] = None) -> ExecutionContext:
        self._log({ "event": f"{self.keyword}:{event}", "payload": payload, "image": bool(image) })
        return self.app_handler.dispatch_event(event, payload, image)

    def render_node(self, node_id: str, context: ExecutionContext):
        self.app_handler.run_node(node_id, context)

    def shell(self, command: str):
        with subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True) as proc:
            for line in proc.stdout:
                self.log(line.rstrip("\n"))
            for line in proc.stderr:
                self.error(line.rstrip("\n"))

    def apt(self, package: str):
        self.shell(f"dpkg -l | grep -q \"^ii  {package}\" || sudo apt -y install {package}")
