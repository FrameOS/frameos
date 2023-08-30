import json
import traceback
import os
import importlib.util
import inspect

from typing import Optional, List
from PIL import Image

from apps import App, ProcessImagePayload

from .config import Config
from .logger import Logger

class AppHandler:
    def __init__(self, config: Config, logger: Logger):
        self.config = config
        self.logger = logger
        self.apps: List[(str, App)] = []

        try:
            apps_folders = os.listdir('apps/')
            for app in self.config.apps:
                folder = app.keyword
                if folder not in apps_folders:
                    continue
                if os.path.isdir(f'apps/{folder}') and os.path.isfile(f'apps/{folder}/frame.py') and os.path.isfile(f'apps/{folder}/config.json'): 
                    try:
                        with open(f'apps/{folder}/config.json', 'r') as file:
                            config = json.load(file)
                       
                        if config.get('version', None) != app.version:
                            self.logger.log({ 'event': f'{folder}:version_mismatch', 'app': folder, 'installed_version': config.get('version', None), 'requested_version': app.version })
                            continue
                        
                        spec = importlib.util.spec_from_file_location(f"apps.{folder}", f"apps/{folder}/frame.py")
                        module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(module)
                        for name, obj in inspect.getmembers(module):
                            if inspect.isclass(obj) and issubclass(obj, App) and obj is not App:
                                app_instance = obj(name=name, app_config=app, frame_config=self.config.to_frame_config(), log_function=self.logger.log)
                                self.register(folder, app_instance)
                    except Exception as e:
                        self.logger.log({ 'event': f'{folder}:error_initializing', 'error': str(e), 'stacktrace': traceback.format_exc() })
        except Exception as e:
            self.logger.log({ 'event': f'@frame:error_initializing_apps', 'error': str(e), 'stacktrace': traceback.format_exc() })
    
    def register(self, name, app: App):
        self.apps.append((name, app))
        features = []
        if app.process_image is not App.process_image:
            features.append('process_image')
        self.logger.log({ 'event': f'@frame:register_app', 'name': name, 'features': features })

    def process_image(self, next_image: Optional[Image.Image], current_image: Optional[Image.Image]) -> (Optional[Image.Image], List[str], List[str]):
        apps_ran=[]
        apps_errored=[]
        payload = ProcessImagePayload(next_image=next_image, current_image=current_image)
        for (keyword, app) in self.apps:
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
