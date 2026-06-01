import uuid
from datetime import timezone
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import Integer, String, ForeignKey, DateTime, event, func
from arq import ArqRedis as Redis
from app.database import Base
from app.models.frame import Frame
from sqlalchemy.orm import relationship, backref, Session, mapped_column
from app.websockets import publish_message

METRICS_RETAINED_PER_FRAME = 11000


class Metrics(Base):
    __tablename__ = 'metrics'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    timestamp = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    frame_id = mapped_column(Integer, ForeignKey('frame.id'), nullable=False)
    metrics = mapped_column(JSON, nullable=False)
    frame = relationship('Frame', backref=backref('metrics', lazy=True))

    def to_dict(self):
        timestamp = self.timestamp
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        else:
            timestamp = timestamp.astimezone(timezone.utc)
        return {
            'id': self.id,
            'project_id': self.project_id,
            'timestamp': timestamp.isoformat(),
            'frame_id': self.frame_id,
            'metrics': self.metrics,
        }


@event.listens_for(Metrics, "before_insert")
def _set_metrics_project_id(_mapper, connection, target: Metrics):
    if target.project_id is not None or target.frame_id is None:
        return
    project_id = connection.execute(
        Frame.__table__.select().with_only_columns(Frame.__table__.c.project_id).where(Frame.__table__.c.id == target.frame_id)
    ).scalar()
    target.project_id = project_id


async def new_metrics(db: Session, redis: Redis, frame_id: int, metrics: dict) -> Metrics:
    frame = db.get(Frame, frame_id)
    if frame is None:
        raise ValueError(f"Frame {frame_id} not found")

    metrics = Metrics(project_id=frame.project_id, frame_id=frame_id, metrics=metrics)
    db.add(metrics)
    db.commit()
    metrics_count = db.query(Metrics).filter_by(project_id=frame.project_id, frame_id=frame_id).count()
    payload = metrics.to_dict()
    if metrics_count > METRICS_RETAINED_PER_FRAME:
        trim_count = metrics_count - METRICS_RETAINED_PER_FRAME
        oldest_metrics = (db.query(Metrics)
                          .filter_by(frame_id=frame_id)
                          .filter(Metrics.project_id == frame.project_id)
                          .order_by(Metrics.timestamp)
                          .limit(trim_count)
                          .all())
        for old_metric in oldest_metrics:
            db.delete(old_metric)
    db.commit()

    await publish_message(redis, "new_metrics", payload)
    return metrics
