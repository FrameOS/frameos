from app import db

class Frame(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ip = db.Column(db.String(15), unique=True, nullable=False)
    port = db.Column(db.Integer, default=8999)
    status = db.Column(db.String(15), nullable=False)
    version = db.Column(db.String(50), nullable=True)
    ssh_user = db.Column(db.String(50), nullable=True)
    ssh_pass = db.Column(db.String(50), nullable=True)
    update_key = db.Column(db.String(64), nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'ip': self.ip,
            'port': self.port,
            'status': self.status,
            'version': self.version,
            'ssh_user': self.ssh_user,
            'ssh_pass': self.ssh_pass,
            'update_key': self.update_key
        }

class FrameLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, default=db.func.current_timestamp())
    type = db.Column(db.String(10), nullable=False)
    line = db.Column(db.Text, nullable=False)
    frame_id = db.Column(db.Integer, db.ForeignKey('frame.id'), nullable=False)

    frame = db.relationship('Frame', backref=db.backref('logs', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp,
            'type': self.type,
            'line': self.line,
            'frame_id': self.frame_id
}
