from flask import jsonify, request
from . import app, db, tasks, models, socketio

@app.route('/logs/new', methods=['GET'])
def new_log():
    tasks.initialize_frame()
    return 'Success', 200
    
@app.route('/')
def index():
    logs = models.SSHLog.query.all()
    return app.send_static_file('index.html')

@app.errorhandler(404)
def not_found(e):
    return app.send_static_file('index.html')

@app.route("/api/frames", methods=["GET"])
def home():
    frames = models.Frame.query.all()
    frames_list = [frame.to_dict() for frame in frames]
    return jsonify(frames=frames_list)

@app.route("/frames/new", methods=["POST"])
def new_frame():
    ip = request.form['ip']
    frame = models.Frame(ip=ip, port=8999, status="uninitialized")
    db.session.add(frame)
    db.session.commit()
    return jsonify(frame=frame.to_dict())
