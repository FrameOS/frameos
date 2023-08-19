from . import db, socketio
from typing import Dict
from sqlalchemy.dialects.sqlite import JSON
import secrets
import json
import os

def get_app_configs() -> Dict[str, Dict]:
    local_apps_path = "./apps"
    configs = {}
    for app_name in os.listdir(local_apps_path):
        local_app_path = os.path.join(local_apps_path, app_name)
        if os.path.isdir(local_app_path):
            config_path = os.path.join(local_app_path, "config.json")
            if os.path.exists(config_path):
                with open(config_path, 'r') as f:
                    config = json.load(f)
                    if 'name' in config:
                        configs[app_name] = config
    return configs

# NB! Update frontend/src/types.tsx if you change this
class Frame(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    # sending commands to frame
    frame_host = db.Column(db.String(256), unique=True, nullable=False)
    frame_port = db.Column(db.Integer, default=8999)
    ssh_user = db.Column(db.String(50), nullable=True)
    ssh_pass = db.Column(db.String(50), nullable=True)
    ssh_port = db.Column(db.Integer, default=22)
    # receiving logs, connection from frame to us
    server_host = db.Column(db.String(256), nullable=True)
    server_port = db.Column(db.Integer, default=8999)
    server_api_key = db.Column(db.String(64), nullable=True)
    # frame metadata
    status = db.Column(db.String(15), nullable=False)
    version = db.Column(db.String(50), nullable=True)    
    width = db.Column(db.Integer, nullable=True)
    height = db.Column(db.Integer, nullable=True)
    device = db.Column(db.String(256), nullable=True)
    color = db.Column(db.String(256), nullable=True)
    image_url = db.Column(db.String(256), nullable=True)
    interval = db.Column(db.Double, default=300)
    # apps
    apps = db.Column(JSON, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
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
            'image_url': self.image_url,
            'interval': self.interval,
            'apps': self.apps,
        }

def new_frame(frame_host: str, server_host: str) -> Frame:
    if '@' in frame_host:
        user_pass, frame_host = frame_host.split('@')
    else:
        user_pass, frame_host = 'pi', frame_host
    
    if ':' in frame_host:
        frame_host, frame_port = frame_host.split(':')
    else:
        frame_port = 8999

    if ':' in user_pass:
        user, password = user_pass.split(':')
    else:
        user, password = user_pass, None

    if password is None and user == 'pi':
        password = 'raspberry'

    if ':' in server_host:
        server_host, server_port = server_host.split(':')
    else:
        server_port = 8999

    app_configs = get_app_configs()
    frame = Frame(
        ssh_user=user, 
        ssh_pass=password, 
        frame_host=frame_host, 
        frame_port=int(frame_port), 
        server_host=server_host, 
        server_port=int(server_port), 
        server_api_key=secrets.token_hex(32), 
        status="uninitialized",
        apps=[{ **app_configs['unsplash'], 'keyword': 'unsplash', 'config': {} }],
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
    frame = Frame.query.get(frame_id)
    if frame:
        Log.query.filter_by(frame_id=frame_id).delete()
        db.session.delete(frame)
        db.session.commit()
        socketio.emit('delete_frame', {'id': frame_id})
        return True
    return False

class Log(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, default=db.func.current_timestamp())
    type = db.Column(db.String(10), nullable=False)
    line = db.Column(db.Text, nullable=False)
    frame_id = db.Column(db.Integer, db.ForeignKey('frame.id'), nullable=False)

    frame = db.relationship('Frame', backref=db.backref('logs', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat(),
            'type': self.type,
            'line': self.line,
            'frame_id': self.frame_id
}

def new_log(frame_id: int, type: str, line: str) -> Log:
    log = Log(frame_id=frame_id, type=type, line=line)
    db.session.add(log)
    db.session.commit()
    frame_logs_count = Log.query.filter_by(frame_id=frame_id).count()
    if frame_logs_count > 1100:
        oldest_logs = (Log.query
                       .filter_by(frame_id=frame_id)
                       .order_by(Log.timestamp)
                       .limit(100)
                       .all())
        for old_log in oldest_logs:
            db.session.delete(old_log)        
        db.session.commit()

    socketio.emit('new_log', {**log.to_dict(), 'timestamp': str(log.timestamp)})
    return log


def process_log(frame: Frame, log: dict):
    new_log(frame.id, "webhook", json.dumps(log))
    
    changes = {}
    event = log.get('event', 'log')
    if event == '@frame:refresh_image':
        changes['status'] = 'fetching'
    if event == '@frame:refreshing_screen':
        changes['status'] = 'refreshing'
    if event == '@frame:refresh_done' or event == '@frame:refresh_skipped_no_change':
        changes['status'] = 'ready'
    if event == 'config':
        if frame.status != 'ready':
            changes['status'] = 'ready'

        for key in ['width', 'height', 'device', 'color', 'image_url', 'interval']:
            if key in log and log[key] is not None and log[key] != getattr(frame, key):
                changes[key] = log[key]

    if len(changes) > 0:
        for key, value in changes.items():
            setattr(frame, key, value)
        update_frame(frame)
