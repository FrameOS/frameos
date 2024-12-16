import json
from datetime import timezone, datetime
from copy import deepcopy
from typing import Any, Optional

from .frame import Frame, update_frame
from .metrics import new_metrics
from app.database import Base
from sqlalchemy import Integer, String, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import relationship, backref, Session, mapped_column
from app.views.ws_broadcast import publish_message

class Log(Base):
    __tablename__ = 'log'
    id = mapped_column(Integer, primary_key=True)
    timestamp = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    type = mapped_column(String(10), nullable=False)
    line = mapped_column(Text, nullable=False)
    frame_id = mapped_column(Integer, ForeignKey('frame.id'), nullable=False)

    frame = relationship('Frame', backref=backref('logs', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.replace(tzinfo=timezone.utc).isoformat(),
            'type': self.type,
            'line': self.line,
            'frame_id': self.frame_id
        }


async def new_log(db: Session, frame_id: int, type: str, line: str, timestamp: Optional[datetime] = None) -> Log:
    log = Log(frame_id=frame_id, type=type, line=line, timestamp=timestamp or datetime.utcnow())
    db.add(log)
    db.commit()
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

    await publish_message("new_log", {**log.to_dict(), "timestamp": log.timestamp.replace(tzinfo=timezone.utc).isoformat()})
    return log


async def process_log(db: Session, frame: Frame, log: dict | list):
    if isinstance(log, list):
        timestamp = datetime.utcfromtimestamp(log[0])
        log = log[1]
    else:
        timestamp = datetime.utcnow()

    await new_log(db, int(frame.id), "webhook", json.dumps(log), timestamp)

    assert isinstance(log, dict), f"Log must be a dict, got {type(log)}"

    changes: dict[str, Any] = {}
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
        await update_frame(db, frame)

    if event == 'metrics':
        metrics_dict = deepcopy(log)
        if 'event' in metrics_dict:
            del metrics_dict['event']
        if 'timestamp' in metrics_dict:
            del metrics_dict['timestamp']
        await new_metrics(db, int(frame.id), metrics_dict)

