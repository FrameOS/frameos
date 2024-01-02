from datetime import datetime
from flask_socketio import SocketIO
from typing import Optional, List, Dict, Any

from .config import Config
from .webhook import Webhook

def convert_to_json_serializable(data):
    """
    Recursively converts non-JSON serializable objects like sets into JSON serializable formats.
    """
    if isinstance(data, set):
        return list(data)
    elif isinstance(data, dict):
        return {k: convert_to_json_serializable(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [convert_to_json_serializable(elem) for elem in data]
    else:
        return data

class Logger:
    def __init__(self, config: Config, limit: int, socketio: Optional[SocketIO] = None):
        self.config = config
        self.logs: List[Dict[str, Any]] = []
        self.limit = limit
        self.socketio = socketio
        self.webhook = Webhook(config)

    def set_socketio(self, socketio: SocketIO):
        self.socketio = socketio

    def log(self, payload: Dict[str, Any]):
        payload = {'timestamp': datetime.now().isoformat(), **payload}
        payload = convert_to_json_serializable(payload)

        self.logs.append(payload)
        if self.socketio:
            self.socketio.emit('log_event', {'log': payload})
        self.webhook.add_log(payload)
        if len(self.logs) > self.limit:
            self.logs.pop(0)

    def get(self):
        return self.logs

    def stop(self):
        self.webhook.stop()