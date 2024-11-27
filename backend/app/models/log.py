import json
from datetime import timezone, datetime
#from copy import deepcopy
from typing import Optional, Dict, Any

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, func
from sqlalchemy.orm import relationship, Session

from .frame import Frame, update_frame
# from .metrics import new_metrics

from ..database import Base  # Adjust this import based on your project structure


class Log(Base):
    __tablename__ = 'log'

    id = Column(Integer, primary_key=True)
    timestamp = Column(DateTime, nullable=False, default=func.current_timestamp())
    type = Column(String(10), nullable=False)
    line = Column(Text, nullable=False)
    frame_id = Column(Integer, ForeignKey('frame.id'), nullable=False)

    frame = relationship('Frame', back_populates='logs')

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'timestamp': self.timestamp.replace(tzinfo=timezone.utc).isoformat(),
            'type': self.type,
            'line': self.line,
            'frame_id': self.frame_id
        }


# Ensure the Frame model has the corresponding relationship
Frame.logs = relationship('Log', order_by=Log.id, back_populates='frame')


def new_log(db: Session, frame_id: int, type: str, line: str, timestamp: Optional[datetime] = None) -> Log:
    log = Log(frame_id=frame_id, type=type, line=line, timestamp=timestamp or datetime.utcnow())
    db.add(log)
    db.commit()

    # Clean up old logs if necessary
    frame_logs_count = db.query(Log).filter_by(frame_id=frame_id).count()
    if frame_logs_count > 1100:
        oldest_logs = (db.query(Log)
                       .filter_by(frame_id=frame_id)
                       .order_by(Log.timestamp)
                       .limit(100)
                       .all())
        for old_log in oldest_logs:
            db.delete(old_log)
        db.commit()

    # Implement socketio.emit or use an alternative if needed
    # socketio.emit('new_log', {**log.to_dict(), 'timestamp': log.timestamp.replace(tzinfo=timezone.utc).isoformat()})

    return log


def process_log(db: Session, frame: Frame, log: dict | list):
    if isinstance(log, list):
        timestamp = datetime.utcfromtimestamp(log[0])
        log = log[1]
    else:
        timestamp = datetime.utcnow()

    new_log(db, frame.id, "webhook", json.dumps(log), timestamp)

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
        for key in ['width', 'height', 'color']:
            if key in log and log[key] is not None and log[key] != getattr(frame, key):
                changes[key] = log[key]
            if 'config' in log and key in log['config'] and log['config'][key] is not None and log['config'][key] != getattr(frame, key):
                changes[key] = log['config'][key]
    if len(changes) > 0:
        if frame.last_log_at is None or timestamp > frame.last_log_at:
            changes['last_log_at'] = timestamp
        for key, value in changes.items():
            setattr(frame, key, value)
        update_frame(db, frame)

    # if event == 'metrics':
    #     metrics_dict = deepcopy(log)
    #     metrics_dict.pop('event', None)
    #     metrics_dict.pop('timestamp', None)
    #     new_metrics(db, frame.id, metrics_dict)
