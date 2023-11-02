import json
import logging

from typing import Optional, List, Dict

from apps import FrameConfig, FrameConfigScene, Node, Edge

from version import VERSION

class Config:
    def __init__(self, filename='frame.json'):
        self._data = self._load(filename)
        self.server_host: Optional[str] = self._data.get('server_host', None)
        self.server_port: Optional[int] = self._data.get('server_port', None)
        self.server_api_key: Optional[str] = self._data.get('server_api_key', None)
        self.width: int = self._data.get('width', 1920)
        self.height: int = self._data.get('height', 1080)
        self.device: str = self._data.get('device', "web_only")
        self.color: Optional[str] = self._data.get('color', None)
        self.interval: Optional[int] = self._data.get('interval', 300)
        self.metrics_interval: Optional[int] = self._data.get('metrics_interval', 60)
        self.scaling_mode: Optional[str] = self._data.get('scaling_mode', 'cover')
        self.rotate: Optional[int] = self._data.get('rotate', 0)
        self.background_color: Optional[str] = self._data.get('background_color', 'white')
        self.settings: Optional[Dict] = self._data.get('settings', {})

        scenes_data = self._data.pop('scenes', [])
        self.scenes: List[FrameConfigScene] = []
        for scene in scenes_data:
            nodes = [Node(id=node.get('id'), type=node.get('type'), data=node.get('data')) for node in scene.pop('nodes', [])]
            edges = [Edge(id=edge.get('id'), source=edge.get('source'), target=edge.get('target'), sourceHandle=edge.get('sourceHandle'), targetHandle=edge.get('targetHandle')) for edge in scene.pop('edges', [])]
            self.scenes.append(FrameConfigScene(id=scene.get('id'), nodes=nodes, edges=edges))

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
            'metrics_interval': self.metrics_interval,
            'scaling_mode': self.scaling_mode,
            'rotate': self.rotate,
            'background_color': self.background_color,
            'scenes': self.scenes,
            'settings': self.settings,
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
            rotate=self.rotate,
            background_color=self.background_color,
            scenes=self.scenes,
            settings=self.settings,
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
    
