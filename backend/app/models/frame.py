import json
import os
from datetime import timezone
from typing import Optional, Dict, Any, Set

from sqlalchemy import Column, Integer, String, Boolean, DateTime, Float, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import Session

# from .apps import get_app_configs
# from .settings import get_settings_dict
# from ..utils.token import secure_token

def secure_token(length: int) -> str:
    return "token" # TODO
def get_app_configs() -> Dict[str, Any]:
    return {} # TODO
def get_settings_dict() -> Dict[str, Any]:
    return {} # TODO

# SQLAlchemy Base
Base = declarative_base()


class Frame(Base):
    __tablename__ = "frame"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(256), nullable=False)
    # Sending commands to frame
    frame_host = Column(String(256), nullable=False)
    frame_port = Column(Integer, default=8787)
    frame_access_key = Column(String(256), nullable=True)
    frame_access = Column(String(50), nullable=True)
    ssh_user = Column(String(50), nullable=True)
    ssh_pass = Column(String(50), nullable=True)
    ssh_port = Column(Integer, default=22)
    # Receiving logs, connection from frame to us
    server_host = Column(String(256), nullable=True)
    server_port = Column(Integer, default=8989)
    server_api_key = Column(String(64), nullable=True)
    # Frame metadata
    status = Column(String(15), nullable=False)
    version = Column(String(50), nullable=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    device = Column(String(256), nullable=True)
    color = Column(String(256), nullable=True)
    interval = Column(Float, default=300)
    metrics_interval = Column(Float, default=60)
    scaling_mode = Column(String(64), nullable=True)  # contain (default), cover, stretch, center
    rotate = Column(Integer, nullable=True)
    log_to_file = Column(String(256), nullable=True)
    assets_path = Column(String(256), nullable=True)
    save_assets = Column(JSON, nullable=True)
    debug = Column(Boolean, nullable=True)
    last_log_at = Column(DateTime, nullable=True)
    reboot = Column(JSON, nullable=True)
    control_code = Column(JSON, nullable=True)
    # Apps
    apps = Column(JSON, nullable=True)
    scenes = Column(JSON, nullable=True)

    # Deprecated
    image_url = Column(String(256), nullable=True)
    background_color = Column(String(64), nullable=True)  # still used as fallback in frontend

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'name': self.name,
            'frame_host': self.frame_host,
            'frame_port': self.frame_port,
            'frame_access_key': self.frame_access_key,
            'frame_access': self.frame_access,
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
            'log_to_file': self.log_to_file,
            'assets_path': self.assets_path,
            'save_assets': self.save_assets,
            'reboot': self.reboot,
            'control_code': self.control_code,
        }


def new_frame(
    db: Session,
    name: str,
    frame_host: str,
    server_host: str,
    device: Optional[str] = None,
    interval: Optional[float] = None
) -> Frame:
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
        ssh_port=ssh_port,
        frame_host=frame_host,
        frame_access_key=secure_token(20),
        frame_access="private",
        server_host=server_host,
        server_port=int(server_port),
        server_api_key=secure_token(32),
        interval=interval or 60,
        status="uninitialized",
        apps=[],
        scenes=[],
        scaling_mode="contain",
        rotate=0,
        device=device or "web_only",
        log_to_file=None,  # Spare the SD card from load
        assets_path='/srv/assets',
        save_assets=True,
        control_code={"enabled": "true", "position": "top-right"},
        reboot={"enabled": "true", "crontab": "4 0 * * *"},
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    # You may need to implement socketio.emit in FastAPI
    # socketio.emit('new_frame', frame.to_dict())

    # Implement your own logging mechanism or use a logger
    # new_log(frame.id, "welcome", f"The frame \"{frame.name}\" has been created!")

    return frame


def update_frame(db: Session, frame: Frame):
    db.add(frame)
    db.commit()
    db.refresh(frame)
    # You may need to implement socketio.emit in FastAPI
    # socketio.emit('update_frame', frame.to_dict())


def delete_frame(db: Session, frame_id: int):
    frame = db.query(Frame).get(frame_id)
    if frame:
        # Delete corresponding log and metric entries first
        from .log import Log
        db.query(Log).filter_by(frame_id=frame_id).delete()
        from .metrics import Metrics
        db.query(Metrics).filter_by(frame_id=frame_id).delete()

        # cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
        # Adjust Redis usage as needed in FastAPI
        # redis.delete(cache_key)

        db.delete(frame)
        db.commit()
        # You may need to implement socketio.emit in FastAPI
        # socketio.emit('delete_frame', {'id': frame_id})
        return True
    return False


def get_templates_json() -> Dict[str, Any]:
    templates_schema_path = os.path.join("..", "frontend", "schema", "templates.json")
    if os.path.exists(templates_schema_path):
        with open(templates_schema_path, 'r') as file:
            return json.load(file)
    else:
        return {}


def get_frame_json(db: Session, frame: Frame) -> Dict[str, Any]:
    frame_json = {
        "name": frame.name,
        "frameHost": frame.frame_host or "localhost",
        "framePort": frame.frame_port or 8787,
        "frameAccessKey": frame.frame_access_key,
        "frameAccess": frame.frame_access,
        "serverHost": frame.server_host or "localhost",
        "serverPort": frame.server_port or 8989,
        "serverApiKey": frame.server_api_key,
        "width": frame.width,
        "height": frame.height,
        "device": frame.device or "web_only",
        "metricsInterval": frame.metrics_interval or 60.0,
        "debug": frame.debug or False,
        "scalingMode": frame.scaling_mode or "contain",
        "rotate": frame.rotate or 0,
        "logToFile": frame.log_to_file,
        "assetsPath": frame.assets_path,
        "saveAssets": frame.save_assets,
    }

    setting_keys: Set[str] = set()
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
