import json
import traceback
import os
import importlib.util
import inspect

from typing import Optional, List, Dict, Type, Any
from PIL import Image

from apps import AppConfig, App, ProcessImagePayload, FrameScene, Node
from dacite import from_dict

from .config import Config
from .logger import Logger

class AppHandler:
    def __init__(self, config: Config, logger: Logger):
        self.config = config
        self.logger = logger
        self.app_classes: Dict[str, Type[App]] = {}
        self.app_configs: Dict[str, AppConfig] = {}
        self.rendering_apps: List[(str, App)] = []

        try:
            apps_folders = os.listdir('apps/')
            all_apps_keywords = set()
            for scene in self.config.scenes:
                for node in scene.nodes:
                    if node.type == 'app' and node.data.get('keyword'):
                        all_apps_keywords.add(node.data.get('keyword'))
            self.logger.log({'event': f'@frame:apps', 'apps': list(all_apps_keywords)})

            for folder in all_apps_keywords:
                if folder not in apps_folders:
                    self.logger.log({'event': f'@frame:error_no_app', 'error': f"folder '{folder}' not present under apps/",
                                     'stacktrace': traceback.format_exc()})
                    continue

                if os.path.isdir(f'apps/{folder}') and os.path.isfile(f'apps/{folder}/frame.py') and os.path.isfile(f'apps/{folder}/config.json'):
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
                                self.register(folder, obj, config)
                    except Exception as e:
                        self.logger.log({ 'event': f'{folder}:error_initializing', 'error': str(e), 'stacktrace': traceback.format_exc() })

            for scene in self.config.scenes:
                if scene.id == 'default':
                    render_chain = self.find_chains(scene, 'render')
                    for node in render_chain:
                        if node.type == 'event':
                            if node.data.get('keyword') == 'render':
                                # starting point
                                pass
                            else:
                                self.logger.log({ 'event': f'@frame:error_invalid_event', 'error': f"event '{node.data.get('keyword')}' is not a valid starting point for the render chain"})
                        elif node.type == 'app':
                            keyword = node.data.get('keyword')
                            if keyword in self.app_classes:
                                app_instance = self.get_app_node(keyword, node.data.get('config'))
                                self.rendering_apps.append((keyword, app_instance))

        except Exception as e:
            self.logger.log({ 'event': f'@frame:error_initializing_apps', 'error': str(e), 'stacktrace': traceback.format_exc() })
    
    def register(self, name: str, app: Type[App], config: AppConfig):
        self.app_classes[name] = app
        self.app_configs[name] = config
        self.logger.log({ 'event': f'@frame:register_app', 'name': name })

    def get_app_node(self, name: str, node_config: Optional[Dict[str, Any]]) -> App:
        if name not in self.app_classes or name not in self.app_configs:
            self.logger.log({'event': f'@frame:error_get_app_node', 'name': name, 'error': f"App '{name}' not registered"})
            return None
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
            log_function=self.logger.log
        )

    def find_chains(self, scene: FrameScene, event_keyword = 'render') -> List[Node]:
        nodes_dict = {node.id: node for node in scene.nodes}
        edges_dict = {edge.source: edge.target for edge in scene.edges}
        chains: List[Node] = []

        next_node = next(
            (node for node in scene.nodes if node.type == 'event' and node.data.get('keyword') == event_keyword), None)

        while next_node is not None:
            chains.append(next_node)
            if next_node.id in edges_dict:
                next_node = nodes_dict[edges_dict[next_node.id]]
            else:
                break

        return chains

    def process_image(self, next_image: Optional[Image.Image], current_image: Optional[Image.Image]) -> (Optional[Image.Image], List[str], List[str]):
        apps_ran=[]
        apps_errored=[]
        payload = ProcessImagePayload(
            next_image=next_image,
            current_image=current_image,
        )
        for (keyword, app) in self.rendering_apps:
            if app is None:
                self.logger.log({ 'event': f'{keyword}:app_not_found' })
                apps_errored.append(keyword)
                continue
            if app.process_image is not App.process_image:
                try:
                    self.logger.log({ 'event': f'{keyword}:process_image' })
                    app.process_image(payload)
                    apps_ran.append(keyword)
                except Exception as e:
                    stacktrace = traceback.format_exc()
                    self.logger.log({
                        'event': f'{keyword}:error_processing_image',
                        'app': keyword,
                        'apps_ran': apps_ran,
                        'error': str(e),
                        'stacktrace': stacktrace
                    })
                    apps_errored.append(keyword)
        return payload.next_image, apps_ran, apps_errored
