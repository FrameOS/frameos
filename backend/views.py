from flask import jsonify, request, send_from_directory, Response
from . import app, db, tasks, models, socketio
import requests
import json

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

@app.route('/api/frames/<int:id>/image', methods=['GET'])
def get_image(id: int):
    frame = models.Frame.query.get_or_404(id)
    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/image')
        
    if response.status_code == 200:
        return Response(response.content, content_type='image/png')
    else:
        return jsonify({"error": "Unable to fetch image"}), response.status_code

@app.route('/api/frames/<int:id>/refresh', methods=['POST'])
def refresh_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/refresh')
        
    if response.status_code == 200:
        return "OK", 200
    else:
        return jsonify({"error": "Unable to refresh frame"}), response.status_code

@app.route('/api/frames/<int:id>/reset', methods=['POST'])
def reset_frame(id: int):
    tasks.reset_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/update', methods=['POST'])
def update_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    frame.frame_host = request.form['frame_host']
    frame.frame_port = request.form['frame_port']
    frame.ssh_user = request.form['ssh_user']
    frame.ssh_pass = request.form['ssh_pass']
    frame.ssh_port = request.form['ssh_port']
    frame.server_host = request.form['server_host']
    frame.server_port = request.form['server_port']
    frame.server_api_key = request.form['server_api_key']
    frame.image_url = request.form['image_url']
    frame.interval = request.form['interval']
    models.update_frame(frame)
    tasks.restart_frame(frame.id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/restart', methods=['POST'])
def restart_frame(id: int):
    tasks.restart_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/initialize', methods=['POST'])
def initialize_frame(id: int):
    tasks.initialize_frame(id)
    return 'Success', 200

@app.route("/api/frames/new", methods=["POST"])
def new_frame():
    frame_host = request.form['frame_host']
    server_host = request.form['server_host']
    frame = models.new_frame(frame_host, server_host)
    return jsonify(frame=frame.to_dict())

@app.route('/api/frames/<int:frame_id>', methods=['DELETE'])
def delete_frame_route(frame_id):
    success = models.delete_frame(frame_id)
    if success:
        return jsonify({'message': 'Frame deleted successfully'}), 200
    else:
        return jsonify({'message': 'Frame not found'}), 404

@app.route('/images/<path:filename>')
def custom_static(filename: str):
    return send_from_directory(app.static_folder + '/images', filename)

@app.route('/api/log', methods=["POST"])
def api_log():
    auth_header = request.headers.get('Authorization')
    server_api_key = auth_header.split(' ')[1]
    frame = models.Frame.query.filter_by(server_api_key=server_api_key).first_or_404()

    data = request.json
    if log := data.get('log', None):
        models.process_log(frame, log)
    
    if logs := data.get('logs', None):
        for log in logs:
            models.process_log(frame, log)

    return 'OK', 200
