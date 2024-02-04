import json
import uuid
import secrets
from datetime import timezone
from app import db, socketio
from typing import Optional
from sqlalchemy.dialects.sqlite import JSON

from app.models.apps import get_app_configs
from app.models.settings import get_settings_dict


# NB! Update frontend/src/types.tsx if you change this
class Frame(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(256), nullable=False)
    # sending commands to frame
    frame_host = db.Column(db.String(256), nullable=False)
    frame_port = db.Column(db.Integer, default=8787)
    ssh_user = db.Column(db.String(50), nullable=True)
    ssh_pass = db.Column(db.String(50), nullable=True)
    ssh_port = db.Column(db.Integer, default=22)
    # receiving logs, connection from frame to us
    server_host = db.Column(db.String(256), nullable=True)
    server_port = db.Column(db.Integer, default=8989)
    server_api_key = db.Column(db.String(64), nullable=True)
    # frame metadata
    status = db.Column(db.String(15), nullable=False)
    version = db.Column(db.String(50), nullable=True)
    width = db.Column(db.Integer, nullable=True)
    height = db.Column(db.Integer, nullable=True)
    device = db.Column(db.String(256), nullable=True)
    color = db.Column(db.String(256), nullable=True)
    interval = db.Column(db.Double, default=300)
    metrics_interval = db.Column(db.Double, default=60)
    scaling_mode = db.Column(db.String(64), nullable=True)  # contain (default), cover, stretch, center
    background_color = db.Column(db.String(64), nullable=True)
    rotate = db.Column(db.Integer, nullable=True)
    debug = db.Column(db.Boolean, nullable=True)
    last_log_at = db.Column(db.DateTime, nullable=True)
    # apps
    apps = db.Column(JSON, nullable=True)
    scenes = db.Column(JSON, nullable=True)

    # deprecated
    image_url = db.Column(db.String(256), nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'frame_host': self.frame_host,
            'frame_port': self.frame_port,
            'ssh_user': self.ssh_user,
            'ssh_pass': self.ssh_pass,
            'ssh_port': self.ssh_port,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_api_key': self.server_api_key,
            'status': self.status,
            'version': self.version,
            'width': self.width,
            'height': self.height,
            'device': self.device,
            'color': self.color,
            'interval': self.interval,
            'metrics_interval': self.metrics_interval,
            'scaling_mode': self.scaling_mode,
            'rotate': self.rotate,
            'background_color': self.background_color,
            'debug': self.debug,
            'scenes': self.scenes,
            'last_log_at': self.last_log_at.replace(tzinfo=timezone.utc).isoformat() if self.last_log_at else None,
        }


def new_frame(name: str, frame_host: str, server_host: str, device: Optional[str] = None, interval: Optional[float] = None) -> Frame:
    if '@' in frame_host:
        user_pass, frame_host = frame_host.split('@')
    else:
        user_pass, frame_host = 'pi', frame_host

    if ':' in frame_host:
        frame_host, ssh_port = frame_host.split(':')
        ssh_port = int(ssh_port or '22')
        if int(ssh_port) > 65535 or int(ssh_port) < 0:
            raise ValueError("Invalid frame port")
    else:
        ssh_port = 22

    if ':' in user_pass:
        user, password = user_pass.split(':')
    else:
        user, password = user_pass, None

    if ':' in server_host:
        server_host, server_port = server_host.split(':')
    else:
        server_port = 8989

    frame = Frame(
        name=name,
        ssh_user=user,
        ssh_pass=password,
        frame_host=frame_host,
        ssh_port=ssh_port,
        server_host=server_host,
        server_port=int(server_port),
        server_api_key=secrets.token_hex(32),
        interval=interval or 60,
        status="uninitialized",
        apps=[],
        scenes=[create_default_scene()],
        scaling_mode="contain",
        rotate=0,
        background_color="white",
        device=device or "web_only",
    )
    db.session.add(frame)
    db.session.commit()
    socketio.emit('new_frame', frame.to_dict())
    return frame


def update_frame(frame: Frame):
    db.session.add(frame)
    db.session.commit()
    socketio.emit('update_frame', frame.to_dict())


def delete_frame(frame_id: int):
    if frame := Frame.query.get(frame_id):
        # delete corresonding log and metric entries first
        from .log import Log
        Log.query.filter_by(frame_id=frame_id).delete()
        from .metrics import Metrics
        Metrics.query.filter_by(frame_id=frame_id).delete()

        db.session.delete(frame)
        db.session.commit()
        socketio.emit('delete_frame', {'id': frame_id})
        return True
    return False


def create_default_scene() -> dict:
    event_uuid = str(uuid.uuid4())
    unsplash_uuid = str(uuid.uuid4())
    edge_uuid = str(uuid.uuid4())
    return {
        "id": "default",
        "edges": [
            {
                "id": edge_uuid,
                "source": event_uuid,
                "sourceHandle": "next",
                "target": unsplash_uuid,
                "targetHandle": "prev"
            }
        ],
        "nodes": [
            {
                "id": event_uuid,
                "type": "event",
                "position": {
                    "x": 259.18108974358967,
                    "y": 379.3192307692308
                },
                "data": {
                    "keyword": "render"
                },
                "width": 132,
                "height": 72
            },
            {
                "id": unsplash_uuid,
                "type": "app",
                "position": {
                    "x": 598.6810897435896,
                    "y": 412.8192307692308
                },
                "data": {
                    "keyword": "unsplash",
                    "config": {}
                },
                "width": 133,
                "height": 102
            }
        ]
    }


def get_frame_json(frame: Frame) -> dict:
    frame_json = {
        "name": frame.name,
        "frameHost": frame.frame_host or "localhost",
        "framePort": frame.frame_port or 8787,
        "serverHost": frame.server_host or "localhost",
        "serverPort": frame.server_port or 8989,
        "serverApiKey": frame.server_api_key,
        "width": frame.width,
        "height": frame.height,
        "device": frame.device or "web_only",
        "color": frame.color or "black",
        "backgroundColor": frame.background_color or "white",
        "interval": frame.interval or 30.0,
        "metricsInterval": frame.metrics_interval or 60.0,
        "debug": frame.debug or False,
        "scalingMode": frame.scaling_mode or "contain",
        "rotate": frame.rotate or 0,
    }

    setting_keys = set()
    app_configs = get_app_configs()
    for scene in frame.scenes:
        for node in scene.get('nodes', []):
            if node.get('type', None) == 'app':
                sources = node.get('data', {}).get('sources', None)
                if sources and len(sources) > 0:
                    try:
                        config = sources.get('config.json', '{}')
                        config = json.loads(config)
                        settings = config.get('settings', [])
                        for key in settings:
                            setting_keys.add(key)
                    except:
                        pass
                else:
                    keyword = node.get('data', {}).get('keyword', None)
                    if keyword:
                        app_config = app_configs.get(keyword, None)
                        if app_config:
                            settings = app_config.get('settings', [])
                            for key in settings:
                                setting_keys.add(key)

    all_settings = get_settings_dict()
    final_settings = {}
    for key in setting_keys:
        final_settings[key] = all_settings.get(key, None)

    frame_json['settings'] = final_settings
    return frame_json
