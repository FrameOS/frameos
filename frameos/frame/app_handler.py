import json
import traceback
import os
import importlib.util
import inspect
import zipfile
import zipimport

from dacite import from_dict
from typing import Optional, List, Dict, Type, Any, TYPE_CHECKING
from PIL.Image import Image

from apps import AppConfig, App, Node, Edge, FrameConfigScene, ExecutionContext, BreakExecution
from .config import Config
from .logger import Logger

if TYPE_CHECKING:
    from .image_handler import ImageHandler

class SceneHandler:
    def __init__(self, frame_config_scene: FrameConfigScene, app_handler: "AppHandler", logger: Logger):
        self.app_handler = app_handler
        self.logger = logger
        self.id = frame_config_scene.id
        self.nodes: List[Node] = frame_config_scene.nodes
        self.edges: List[Edge] = frame_config_scene.edges
        self.nodes_dict: Dict[str, Node] = {node.id: node for node in self.nodes}
        self.edges_dict: Dict[str, Node] = {edge.source: edge.target for edge in self.edges}
        self.apps_dict: Dict[str, App] = app_handler.apps
        self.event_start_nodes: Dict[str, List[str]] = {}
        self.state = {}

        for node in self.nodes:
            if node.type == 'event':
                keyword = node.data.get('keyword', None)
                if keyword is not None:
                    if not keyword in self.event_start_nodes:
                        self.event_start_nodes[keyword] = []
                    self.event_start_nodes[keyword].append(node.id)

    def run(self, context: ExecutionContext):
        try:
            context.state = self.state
            if context.event in self.event_start_nodes:
                for node_id in self.event_start_nodes[context.event]:
                    start_node = self.nodes_dict[node_id]
                    node = start_node
                    while node is not None:
                        if node != start_node and (node.type == 'app' or node.type == 'event'):
                            self.run_node(node, context)
                        if node.id in self.edges_dict:
                            node = self.nodes_dict[self.edges_dict[node.id]]
                        else:
                            break
        except BreakExecution as e:
            return

    def run_node(self, node: Node, context: ExecutionContext):
        if node.type == 'app':
            if not node.id in self.apps_dict:
                raise Exception(f'App with id {node.id} not initialized')
            app = self.apps_dict[node.id]
            try:
                app._last_context = context
                app.run(context)
                context.apps_ran.append(node.id)
            except BreakExecution as e:
                self.app_handler.logger.log(
                    {'event': f'@frame:break_execution', 'info': "Execution halted", 'app': node.id, 'message': str(e)})
                raise
            except Exception as e:
                context.apps_errored.append(node.id)
                self.app_handler.logger.log(
                    {'event': f'@frame:error:run_node', 'error': str(e), 'stacktrace': traceback.format_exc()})
        elif node.type == 'event':
            keyword = node.data.get('keyword', None)
            if keyword == 'render':
                self.app_handler.image_handler.refresh_image('dispatch:render')
            else:
                raise Exception(f"Can't yet dispatch events with keyword: {keyword}")
        else:
            raise Exception(f'Unknown execution node type: {node.type}')


class AppHandler:
    def __init__(self, config: Config, logger: Logger):
        self.config = config
        self.logger = logger
        self.app_classes: Dict[str, Type[App]] = {}
        self.app_configs: Dict[str, AppConfig] = {}
        self.apps: Dict[str, App] = {}
        self.scene_handlers: Dict[str, SceneHandler] = {}
        self.current_scene_id: Optional[str] = None
        self.image_handler: Optional["ImageHandler"] = None

    def init(self):
        try:
            self.init_apps()
        except Exception as e:
            self.logger.log({'event': f'@frame:error:init_apps', 'error': str(e), 'stacktrace': traceback.format_exc()})
        try:
            self.init_scenes()
        except Exception as e:
            self.logger.log(
                {'event': f'@frame:error:init_apps', 'error': str(e), 'stacktrace': traceback.format_exc()})

    def init_apps(self):
        all_apps_keywords = set()
        app_node_ids = set()
        for scene in self.config.scenes:
            for node in scene.nodes:
                if node.type == 'app' and node.data.get('keyword'):
                    if node.data.get('sources') is None:
                        all_apps_keywords.add(node.data.get('keyword'))
                    else:
                        app_node_ids.add(node.id)
        self.logger.log({'event': f'@frame:apps', 'apps': list(all_apps_keywords)})

        apps_folders = os.listdir('apps/')
        for folder in all_apps_keywords:
            if folder not in apps_folders:
                self.logger.log({'event': f'@frame:error_no_app', 'error': f"folder '{folder}' not present under apps/",
                                 'stacktrace': traceback.format_exc()})
                continue

            if os.path.isdir(f'apps/{folder}') and os.path.isfile(f'apps/{folder}/frame.py') and os.path.isfile(f'apps/{folder}/config.json'):
                self.init_system_app(folder)

        for node_id in app_node_ids:
            app_id = "node_" + node_id.replace('-', '_')
            if os.path.isfile(f'apps/{app_id}.zip'):
                self.init_custom_app(app_id)

        for scene in self.config.scenes:
            for node in scene.nodes:
                if node.data.get('sources') is not None:
                    keyword = "node_" + node.id.replace('-', '_')
                else:
                    keyword = node.data.get('keyword')
                if node.type == 'app' and keyword:
                    self.apps[node.id] = self.get_app_for_node(name=keyword, node=node, node_config=node.data.get('config'))

    def init_system_app(self, folder: str):
        try:
            with open(f'apps/{folder}/config.json', 'r') as file:
                config = from_dict(data_class=AppConfig, data={
                    **json.load(file),
                    'keyword': folder
                })

            spec = importlib.util.spec_from_file_location(f"apps.{folder}", f"apps/{folder}/frame.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            for name, obj in inspect.getmembers(module):
                if inspect.isclass(obj) and issubclass(obj, App) and obj is not App:
                    self.register_app(folder, obj, config)
        except Exception as e:
            self.logger.log(
                {'event': f'{folder}:error_initializing', 'error': str(e), 'stacktrace': traceback.format_exc()})

    def init_custom_app(self, app_id: str):
        try:
            with zipfile.ZipFile(f'apps/{app_id}.zip', 'r') as zip_ref:
                with zip_ref.open(f'config.json') as file:
                    config = from_dict(data_class=AppConfig, data={
                        **json.load(file),
                        'keyword': app_id
                    })
            importer = zipimport.zipimporter(f'apps/{app_id}.zip')
            frame_module = importer.load_module(f'frame')
            for name, obj in inspect.getmembers(frame_module):
                if inspect.isclass(obj) and issubclass(obj, App) and obj is not App:
                    self.register_app(app_id, obj, config)

        except Exception as e:
            self.logger.log(
                {'event': f'node:error_initializing', 'id': app_id, 'error': str(e), 'stacktrace': traceback.format_exc()})

    def register_app(self, name: str, app: Type[App], config: AppConfig):
        self.app_classes[name] = app
        self.app_configs[name] = config
        self.logger.log({ 'event': f'@frame:register_app', 'name': name })

    def init_scenes(self):
        for frame_config_scene in self.config.scenes:
            scene_handler = SceneHandler(frame_config_scene=frame_config_scene, app_handler=self, logger=self.logger)
            self.scene_handlers[scene_handler.id] = scene_handler
        self.dispatch_event('init')

    def get_app_for_node(self, name: str, node: Node, node_config: Optional[Dict[str, Any]]) -> App:
        if name not in self.app_classes or name not in self.app_configs:
            raise Exception(f"App '{name}' not registered")

        app_config = self.app_configs[name]
        AppClass = self.app_classes[name]
        config = {}
        for field in app_config.fields:
            if node_config and field.name in node_config:
                config[field.name] = node_config[field.name]
            else:
                config[field.name] = field.value

        return AppClass(
            keyword=name,
            config=config,
            frame_config=self.config.to_frame_config(),
            app_handler=self,
            node=node,
        )

    def run(self, context: ExecutionContext) -> ExecutionContext:
        if self.current_scene_id is None:
            if len(self.scene_handlers) == 0:
                raise Exception('No scenes registered')
            self.current_scene_id = list(self.scene_handlers.keys())[0]
        current_scene = self.scene_handlers[self.current_scene_id]
        if current_scene is None:
            raise Exception(f'Scene {self.current_scene_id} not found')
        current_scene.run(context)
        return context

    def dispatch_event(self, event: str, payload: Optional[Dict] = None, image: Optional[Image] = None):
        context = ExecutionContext(
            event=event,
            payload=payload or {},
            image=image,
            apps_ran=[],
            apps_errored=[],
            state={},
        )
        self.run(context)
        return context

    def register_image_handler(self, image_handler: "ImageHandler"):
        self.image_handler = image_handler