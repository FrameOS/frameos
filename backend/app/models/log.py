import json
from datetime import timezone, datetime
from copy import deepcopy
from app import db, socketio
from .frame import Frame, update_frame
from .metrics import new_metrics

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
            'timestamp': self.timestamp.replace(tzinfo=timezone.utc).isoformat(),
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

    socketio.emit('new_log', {**log.to_dict(), 'timestamp': log.timestamp.replace(tzinfo=timezone.utc).isoformat()})
    return log


def process_log(frame: Frame, log: dict):
    new_log(frame.id, "webhook", json.dumps(log))

    changes = {}
    event = log.get('event', 'log')
    if event == 'render':
        changes['status'] = 'preparing'
    if event == 'render:device':
        changes['status'] = 'rendering'
    if event == 'render:done':
        changes['status'] = 'ready'
    if event == 'bootup':
        if frame.status != 'ready':
            changes['status'] = 'ready'
        for key in ['frame_port', 'width', 'height', 'color', 'interval', 'metrics_interval', 'scaling_mode', 'rotate', 'background_color']:
            if key in log and log[key] is not None and log[key] != getattr(frame, key):
                changes[key] = log[key]
            if 'config' in log and key in log['config'] and log['config'][key] is not None and log['config'][key] != getattr(frame, key):
                changes[key] = log['config'][key]
    if len(changes) > 0:
        changes['last_log_at'] = datetime.utcnow()
        for key, value in changes.items():
            setattr(frame, key, value)
        update_frame(frame)

    if event == 'metrics':
        metrics_dict = deepcopy(log)
        if 'event' in metrics_dict:
            del metrics_dict['event']
        if 'timestamp' in metrics_dict:
            del metrics_dict['timestamp']
        new_metrics(frame.id, metrics_dict)

