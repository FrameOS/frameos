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
    