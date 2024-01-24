import uuid
from app import db, socketio
from sqlalchemy.dialects.sqlite import JSON

class Metrics(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = db.Column(db.DateTime, nullable=False, default=db.func.current_timestamp())
    frame_id = db.Column(db.Integer, db.ForeignKey('frame.id'), nullable=False)
    metrics = db.Column(JSON, nullable=False)
    frame = db.relationship('Frame', backref=db.backref('metrics', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat(),
            'frame_id': self.frame_id,
            'metrics': self.metrics,
        }


def new_metrics(frame_id: int, metrics: dict) -> Metrics:
    metrics = Metrics(frame_id=frame_id, metrics=metrics)
    db.session.add(metrics)
    db.session.commit()
    metrics_count = Metrics.query.filter_by(frame_id=frame_id).count()
    if metrics_count > 1100:
        oldest_metrics = (Metrics.query
                          .filter_by(frame_id=frame_id)
                          .order_by(Metrics.timestamp)
                          .limit(10)
                          .all())
        for old_metric in oldest_metrics:
            db.session.delete(old_metric)
        db.session.commit()

    socketio.emit('new_metrics', {**metrics.to_dict(), 'timestamp': str(metrics.timestamp)})
    return metrics
