from . import db, socketio
from sqlalchemy.dialects.sqlite import JSON
import secrets
import json

# NB! Update frontend/src/types.tsx if you change this
class Frame(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    host = db.Column(db.String(256), unique=True, nullable=False)
    # sending commands
    ssh_user = db.Column(db.String(50), nullable=True)
    ssh_pass = db.Column(db.String(50), nullable=True)
    ssh_port = db.Column(db.Integer, default=22)
    # receiving logs
    api_host = db.Column(db.String(256), nullable=True)
    api_key = db.Column(db.String(64), nullable=True)
    api_port = db.Column(db.Integer, default=8999)
    status = db.Column(db.String(15), nullable=False)
    version = db.Column(db.String(50), nullable=True)
    # frame metadata
    width = db.Column(db.Integer, nullable=True)
    height = db.Column(db.Integer, nullable=True)
    device = db.Column(db.String(256), nullable=True)


    def to_dict(self):
        return {
            'id': self.id,
            'host': self.host,
            'ssh_user': self.ssh_user,
            'ssh_pass': self.ssh_pass,
            'ssh_port': self.ssh_port,
            'api_host': self.api_host,
            'api_key': self.api_key,
            'api_port': self.api_port,
            'status': self.status,
            'version': self.version,
            'width': self.width,
            'height': self.height,
            'device': self.device,
        }

def new_frame(user_host: str, api_host: str) -> Frame:
    if '@' in user_host:
        user_pass, host = user_host.split('@')
    else:
        user_pass, host = 'pi', user_host

    if ':' in user_pass:
        user, password = user_pass.split(':')
    else:
        user, password = user_pass, None

    if password is None and user == 'pi':
        password = 'raspberry'

    if ':' in api_host:
        api_host, api_port = api_host.split(':')
    else:
        api_port = 8999

    api_key = secrets.token_hex(32)
    frame = Frame(ssh_user=user, ssh_pass=password, host=host, api_host=api_host, api_port=int(api_port), api_key=api_key, status="uninitialized")
    db.session.add(frame)
    db.session.commit()
    socketio.emit('new_frame', frame.to_dict())
    return frame

def update_frame(frame: Frame):
    db.session.add(frame)
    db.session.commit()
    socketio.emit('update_frame', frame.to_dict())

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
    if event == 'refresh_image':
        changes['status'] = 'fetching'
    if event == 'refresh_begin':
        changes['status'] = 'refreshing'
    if event == 'refresh_end' or event == 'refresh_skip_no_change':
        changes['status'] = 'ready'
    if event == 'device_info':
        if frame.status != 'ready':
            changes['status'] = 'ready'
        if log.get('width', None) is not None and log['width'] != frame.width:
            changes['width'] = log['width']
        if log.get('height', None) is not None and log['height'] != frame.height:
            changes['height'] = log['height']
        if log.get('device', None) is not None and log['device'] != frame.device:
            changes['device'] = log['device']

    if len(changes) > 0:
        for key, value in changes.items():
            setattr(frame, key, value)
        update_frame(frame)
