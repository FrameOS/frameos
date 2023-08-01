from flask import Flask, jsonify, request, abort, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit
from paramiko import RSAKey, SSHClient, AutoAddPolicy
from scp import SCPClient
from io import StringIO
import requests

LOCAL_VERSION = "1.0.0"  # You should update this constant whenever you have a new version

app = Flask(__name__, static_folder='templates')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:////tmp/frameos.db'
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")  # Initializing SocketIO with the Flask app

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
    
@app.route('/frames', methods=['GET'])
def list_frames():
    frames = Frame.query.all()
    frames_list = [frame.to_dict() for frame in frames]
    return jsonify(frames_list)

@app.route('/frames', methods=['POST'])
def add_frame():
    ip = request.form['ip']
    port = request.form.get('port', 8999)
    if not port:
        port = 8999
    else:
        port = int(port)
    frame = Frame(ip=ip, port=port, status="uninitialized")
    db.session.add(frame)
    db.session.commit()
    return jsonify(frame.to_dict())

@app.route('/frames/<int:id>', methods=['DELETE'])
def remove_frame(id):
    frame = Frame.query.get_or_404(id)
    db.session.delete(frame)
    db.session.commit()
    return '', 204

@app.route('/frames/<int:id>/check_online', methods=['GET'])
def check_online(id):
    frame = Frame.query.get_or_404(id)
    try:
        response = requests.get(f"http://{frame.ip}:{frame.port}/version")
        if response.status_code == 200:
            frame.status = "online"
            frame.version = response.text
        else:
            frame.status = "offline"
        db.session.commit()
    except requests.exceptions.RequestException:
        frame.status = "offline"
        db.session.commit()
    return jsonify(frame.to_dict())

@app.route('/frames/<int:id>/check_update', methods=['GET'])
def check_update(id):
    frame = Frame.query.get_or_404(id)
    if frame.status != "online":
        abort(400, "Frame is not online.")
    frame.needs_update = frame.version != LOCAL_VERSION
    db.session.commit()
    return jsonify(frame.to_dict())

@app.route('/frames/<int:id>/initialize', methods=['POST'])
def initialize_frame(id):
    socketio.emit('initialize_frame_output', {'data': "Starting..."}, namespace='/test')
    frame = Frame.query.get_or_404(id)
    ssh_user = request.form['ssh_user']
    ssh_pass = request.form.get('ssh_pass')
    ssh_key = request.form.get('ssh_key', None)

    ssh = SSHClient()
    ssh.set_missing_host_key_policy(AutoAddPolicy())
    
    socketio.emit('initialize_frame_output', {'data': f"Connecting to {ssh_user}@{frame.ip}"}, namespace='/test')

    if ssh_key:
        ssh_key_obj = RSAKey.from_private_key(StringIO(ssh_key))
        ssh.connect(frame.ip, username=ssh_user, pkey=ssh_key_obj, timeout=10)
    else:
        ssh.connect(frame.ip, username=ssh_user, password=ssh_pass, timeout=10)

    with SCPClient(ssh.get_transport()) as scp:
        scp.put('../client/frame.py', 'frame.py')

    _, stdout, _ = ssh.exec_command('python frame.py')
    for line in stdout:
        socketio.emit('initialize_frame_output', {'data': line}, namespace='/test')

    frame.status = "initialized"
    db.session.commit()

    return jsonify(frame.to_dict())


@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, host='0.0.0.0', port=8080, debug=True)
    # app.run(host='0.0.0.0', port=8080, debug=True)
