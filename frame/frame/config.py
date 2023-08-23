import json
import logging

from typing import Optional

from apps import FrameConfig, AppConfig, ConfigField

from .version import VERSION

class Config:
    def __init__(self, filename='frame.json'):
        self._data = self._load(filename)
        self.server_host: Optional[str] = self._data.get('server_host', None)
        self.server_port: Optional[int] = self._data.get('server_port', None)
        self.server_api_key: Optional[str] = self._data.get('server_api_key', None)
        self.width: int = self._data.get('width', 1920)
        self.height: int = self._data.get('height', 1080)
        self.device: str = self._data.get('device', "kiosk")
        self.color: Optional[str] = self._data.get('color', None)
        self.interval: Optional[int] = self._data.get('interval', 300)
        self.scaling_mode: Optional[str] = self._data.get('scaling_mode', 'cover')
        self.background_color: Optional[str] = self._data.get('background_color', 'white')
        apps_data = self._data.pop('apps', [])
        self.apps = []
        for app in apps_data:
            fields = app.pop('fields', [])
            app_config = AppConfig(
                fields=[ConfigField(**field) for field in fields],
                **app
            )
            self.apps.append(app_config)

    def to_dict(self):
        return {
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_api_key': self.server_api_key,
            'width': self.width,
            'height': self.height,
            'device': self.device,
            'color': self.color,
            'interval': self.interval,
            'scaling_mode': self.scaling_mode,
            'background_color': self.background_color,
            'apps': self.apps,
        }
    
    def to_frame_config(self):
        return FrameConfig(
            status='OK',
            version=VERSION,
            width=self.width,
            height=self.height,
            device=self.device,
            color=self.color,
            interval=self.interval,
            scaling_mode=self.scaling_mode,
            background_color=self.background_color,
            apps=self.apps,
        )

    def _load(self, filename):
        try:
            with open(filename, 'r') as file:
                return json.load(file)
        except Exception as e:
            logging.error(f"Error loading configuration: {e}")
            return {}

    def get(self, key, default=None):
        return self._data.get(key, default)
    