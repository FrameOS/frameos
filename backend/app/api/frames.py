import requests
import json

from flask import jsonify, request, Response
from flask_login import login_required
from app import app, redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.tasks import deploy_frame, restart_frame

@app.route("/api/frames", methods=["GET"])
@login_required
def api_frames():
    frames = Frame.query.all()
    frames_list = [frame.to_dict() for frame in frames]
    return jsonify(frames=frames_list)


@app.route('/api/frames/<int:id>', methods=['GET'])
@login_required
def api_frame_get(id: int):
    frame = Frame.query.get_or_404(id)
    return jsonify(frame=frame.to_dict())


@app.route('/api/frames/<int:id>/logs', methods=['GET'])
@login_required
def api_frame_get_logs(id: int):
    frame = Frame.query.get_or_404(id)
    logs = [log.to_dict() for log in frame.logs]
    logs = logs[-1000:]
    return jsonify(logs=logs)


@app.route('/api/frames/<int:id>/image', methods=['GET'])
@login_required
def api_frame_get_image(id: int):
    frame = Frame.query.get_or_404(id)

    if request.args.get('t') == '-1':
        last_image = redis.get(f'frame:{id}:image')
        if last_image:
            return Response(last_image, content_type='image/png')

    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/image')
    if response.status_code == 200:
        redis.set(f'frame:{id}:image', response.content, ex=86400 * 30)
        return Response(response.content, content_type='image/png')
    else:
        last_image = redis.get(f'frame:{id}:image')
        if last_image:
            return Response(last_image, content_type='image/png')
        return jsonify({"error": "Unable to fetch image"}), response.status_code


@app.route('/api/frames/<int:id>/event/render', methods=['POST'])
@login_required
def api_frame_render_event(id: int):
    frame = Frame.query.get_or_404(id)
    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/event/render')

    if response.status_code == 200:
        return "OK", 200
    else:
        return jsonify({"error": "Unable to refresh frame"}), response.status_code


@app.route('/api/frames/<int:id>/reset', methods=['POST'])
@login_required
def api_frame_reset_event(id: int):
    reset_frame(id)
    return 'Success', 200


@app.route('/api/frames/<int:id>/restart', methods=['POST'])
@login_required
def api_frame_restart_event(id: int):
    restart_frame(id)
    return 'Success', 200


@app.route('/api/frames/<int:id>/deploy', methods=['POST'])
@login_required
def api_frame_deploy_event(id: int):
    deploy_frame(id)
    return 'Success', 200


@app.route('/api/frames/<int:id>', methods=['POST'])
@login_required
def api_frame_update(id: int):
    frame = Frame.query.get_or_404(id)
    # I have many years of engineering experience
    if 'scenes' in request.form:
        frame.scenes = json.loads(request.form['scenes'])
    if 'name' in request.form:
        frame.name = request.form['name']
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
        frame.width = int(request.form['width']) if request.form['width'] != '' and request.form[
            'width'] != 'null' else None
    if 'height' in request.form:
        frame.height = int(request.form['height']) if request.form['height'] != '' and request.form[
            'height'] != 'null' else None
    if 'rotate' in request.form:
        frame.rotate = int(request.form['rotate']) if request.form['rotate'] != '' and request.form[
            'rotate'] != 'null' else None
    if 'color' in request.form:
        frame.color = request.form['color'] if request.form['color'] != '' and request.form['color'] != 'null' else None
    if 'interval' in request.form:
        frame.interval = float(request.form['interval']) if request.form['interval'] != '' else None
    if 'metrics_interval' in request.form:
        frame.metrics_interval = float(request.form['metrics_interval']) if request.form[
                                                                                'metrics_interval'] != '' else None
    if 'scaling_mode' in request.form:
        frame.scaling_mode = request.form['scaling_mode']
    if 'background_color' in request.form:
        frame.background_color = request.form['background_color']
    if 'device' in request.form:
        frame.device = request.form['device']

    update_frame(frame)

    if request.form.get('next_action') == 'restart':
        restart_frame(frame.id)
    elif request.form.get('next_action') == 'deploy':
        deploy_frame(frame.id)

    return 'Success', 200


@app.route("/api/frames/new", methods=["POST"])
@login_required
def api_frame_new():
    name = request.form['name']
    frame_host = request.form['frame_host']
    server_host = request.form['server_host']
    device = request.form.get('device', 'web_only')
    frame = new_frame(name, frame_host, server_host, device)
    return jsonify(frame=frame.to_dict())


@app.route('/api/frames/<int:frame_id>', methods=['DELETE'])
@login_required
def api_frame_delete(frame_id):
    success = delete_frame(frame_id)
    if success:
        return jsonify({'message': 'Frame deleted successfully'}), 200
    else:
        return jsonify({'message': 'Frame not found'}), 404
