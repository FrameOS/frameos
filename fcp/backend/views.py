from flask import jsonify, request, send_from_directory
from . import app, db, tasks, models, socketio

@app.errorhandler(404)
def not_found(e):
    return app.send_static_file('index.html')

@app.route("/", methods=["GET"])
def home():
    return app.send_static_file('index.html')

@app.route("/api/frames", methods=["GET"])
def frames():
    frames = models.Frame.query.all()
    frames_list = [frame.to_dict() for frame in frames]
    return jsonify(frames=frames_list)

@app.route('/api/frames/<int:id>', methods=['GET'])
def get_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    return jsonify(frame=frame.to_dict())

@app.route('/api/frames/<int:id>/logs', methods=['GET'])
def get_logs(id: int):
    frame = models.Frame.query.get_or_404(id)
    logs = [log.to_dict() for log in frame.logs]
    return jsonify(logs=logs)


@app.route('/api/frames/<int:id>/reset', methods=['POST'])
def reset_frame(id: int):
    tasks.reset_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/initialize', methods=['POST'])
def initialize_frame(id: int):
    tasks.initialize_frame(id)
    return 'Success', 200

@app.route("/api/frames/new", methods=["POST"])
def new_frame():
    host = request.form['host']
    api_host = request.form['api_host']
    frame = models.new_frame(host, api_host)
    return jsonify(frame=frame.to_dict())

@app.route('/images/<path:filename>')
def custom_static(filename: str):
    return send_from_directory(app.static_folder + '/images', filename)
