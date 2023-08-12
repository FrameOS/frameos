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
    response = requests.get(f'http://{frame.host}:8999/image')
        
    if response.status_code == 200:
        return Response(response.content, content_type='image/png')
    else:
        return jsonify({"error": "Unable to fetch image"}), response.status_code

@app.route('/api/frames/<int:id>/refresh', methods=['POST'])
def refresh_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    response = requests.get(f'http://{frame.host}:8999/refresh')
        
    if response.status_code == 200:
        return "OK", 200
    else:
        return jsonify({"error": "Unable to refresh frame"}), response.status_code

@app.route('/api/frames/<int:id>/reset', methods=['POST'])
def reset_frame(id: int):
    tasks.reset_frame(id)
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
    host = request.form['host']
    api_host = request.form['api_host']
    frame = models.new_frame(host, api_host)
    return jsonify(frame=frame.to_dict())

@app.route('/images/<path:filename>')
def custom_static(filename: str):
    return send_from_directory(app.static_folder + '/images', filename)

@app.route('/api/log', methods=["POST"])
def api_log():
    auth_header = request.headers.get('Authorization')
    api_key = auth_header.split(' ')[1]
    frame = models.Frame.query.filter_by(api_key=api_key).first_or_404()

    data = request.json
    log = data.get('log', None)
    if log is not None:
        event = log.get('event', 'log')
        models.new_log(frame.id, "webhook", json.dumps(log))
        
        changes = {}
        if event == 'refresh_image':
            changes['status'] = 'fetching'
        if event == 'refresh_begin':
            changes['status'] = 'refreshing'
        if event == 'refresh_end' or event == 'refresh_skip_no_change':
            changes['status'] = 'ready'
        if event == 'device_info':
            if frame.status != 'ready':
                changes['status'] = 'ready'
            if log.get('width', None) is not None and log['width'] != frame.width:
                changes['width'] = log['width']
            if log.get('height', None) is not None and log['height'] != frame.height:
                changes['height'] = log['height']
            if log.get('device', None) is not None and log['device'] != frame.device:
                changes['device'] = log['device']
        if event == 'error_device':
            changes['device'] = 'web_only'
    
        if len(changes) > 0:
            print(changes)
            for key, value in changes.items():
                setattr(frame, key, value)
            models.update_frame(frame)


    return 'OK', 200
