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

@app.route("/api/apps", methods=["GET"])
def apps():
    return jsonify(apps=models.get_app_configs())

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

@app.route('/api/frames/<int:id>/restart', methods=['POST'])
def restart_frame(id: int):
    tasks.restart_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>/initialize', methods=['POST'])
def deploy_frame(id: int):
    tasks.deploy_frame(id)
    return 'Success', 200

@app.route('/api/frames/<int:id>', methods=['POST'])
def update_frame(id: int):
    frame = models.Frame.query.get_or_404(id)
    # I have many years of engineering experience
    if 'scenes' in request.form:
        frame.scenes = json.loads(request.form['scenes'])
    if 'frame_host' in request.form:
        frame.frame_host = request.form['frame_host']
    if 'frame_port' in request.form:
        frame.frame_port = int(request.form['frame_port'] or '8999')
    if 'ssh_user' in request.form:
        frame.ssh_user = request.form['ssh_user']
    if 'ssh_pass' in request.form:
        frame.ssh_pass = request.form['ssh_pass'] if request.form['ssh_pass'] != '' else None
    if 'ssh_port' in request.form:
        frame.ssh_port = int(request.form['ssh_port'] or '22')
    if 'server_host' in request.form:
        frame.server_host = request.form['server_host']
    if 'server_port' in request.form:
        frame.server_port = int(request.form['server_port'] or '8999')
    if 'server_api_key' in request.form:
        frame.server_api_key = request.form['server_api_key']
    if 'width' in request.form:
        frame.width = int(request.form['width']) if request.form['width'] != '' and request.form['width'] != 'null' else None
    if 'height' in request.form:
        frame.height = int(request.form['height']) if request.form['height'] != '' and request.form['height'] != 'null' else None
    if 'color' in request.form:
        frame.color = request.form['color'] if request.form['color'] != '' and request.form['color'] != 'null' else None
    if 'interval' in request.form:
        frame.interval = int(request.form['interval']) if request.form['interval'] != '' else None
    if 'scaling_mode' in request.form:
        frame.scaling_mode = request.form['scaling_mode']
    if 'background_color' in request.form:
        frame.background_color = request.form['background_color']
    if 'device' in request.form:
        frame.device = request.form['device']

    models.update_frame(frame)

    if request.form.get('next_action') == 'restart':
        tasks.restart_frame(frame.id)
    elif request.form.get('next_action') == 'redeploy':
        tasks.deploy_frame(frame.id)
    elif request.form.get('next_action') == 'refresh':
        refresh_frame(frame.id)

    return 'Success', 200

@app.route("/api/frames/new", methods=["POST"])
def new_frame():
    frame_host = request.form['frame_host']
    server_host = request.form['server_host']
    device = request.form['device']
    frame = models.new_frame(frame_host, server_host, device)
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
