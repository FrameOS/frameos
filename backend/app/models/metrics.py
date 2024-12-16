import uuid
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import Integer, String, ForeignKey, DateTime, func
from app.database import Base
from sqlalchemy.orm import relationship, backref, Session, mapped_column
from app.views.ws_broadcast import publish_message

class Metrics(Base):
    __tablename__ = 'metrics'
    id = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    frame_id = mapped_column(Integer, ForeignKey('frame.id'), nullable=False)
    metrics = mapped_column(JSON, nullable=False)
    frame = relationship('Frame', backref=backref('metrics', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat(),
            'frame_id': self.frame_id,
            'metrics': self.metrics,
        }


async def new_metrics(db: Session, frame_id: int, metrics: dict) -> Metrics:
    metrics = Metrics(frame_id=frame_id, metrics=metrics)
    db.add(metrics)
    db.commit()
    metrics_count = db.query(Metrics).filter_by(frame_id=frame_id).count()
    if metrics_count > 1100:
        oldest_metrics = (db.query(Metrics)
                          .filter_by(frame_id=frame_id)
                          .order_by(Metrics.timestamp)
                          .limit(10)
                          .all())
        for old_metric in oldest_metrics:
            db.delete(old_metric)
        db.commit()

    await publish_message("new_metrics", {**metrics.to_dict(), "timestamp": str(metrics.timestamp)})
    return metrics
