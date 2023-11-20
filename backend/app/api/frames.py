import json

import requests

from http import HTTPStatus
from flask import jsonify, request, Response
from flask_login import login_required
from . import api
from app import redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.tasks import deploy_frame, restart_frame, reset_frame

@api.route("/frames", methods=["GET"])
@login_required
def api_frames():
    frames = Frame.query.all()
    frames_list = [frame.to_dict() for frame in frames]
    return jsonify(frames=frames_list)


@api.route('/frames/<int:id>', methods=['GET'])
@login_required
def api_frame_get(id: int):
    frame = Frame.query.get_or_404(id)
    return jsonify(frame=frame.to_dict())


@api.route('/frames/<int:id>/logs', methods=['GET'])
@login_required
def api_frame_get_logs(id: int):
    frame = Frame.query.get_or_404(id)
    logs = [log.to_dict() for log in frame.logs]
    logs = logs[-1000:]
    return jsonify(logs=logs)


@api.route('/frames/<int:id>/image', methods=['GET'])
@login_required
def api_frame_get_image(id: int):
    frame = Frame.query.get_or_404(id)
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'

    if request.args.get('t') == '-1':
        last_image = redis.get(cache_key)
        if last_image:
            return Response(last_image, content_type='image/png')

    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/image')
    if response.status_code == 200:
        redis.set(cache_key, response.content, ex=86400 * 30)
        return Response(response.content, content_type='image/png')
    else:
        last_image = redis.get(cache_key)
        if last_image:
            return Response(last_image, content_type='image/png')
        return jsonify({"error": "Unable to fetch image"}), response.status_code


@api.route('/frames/<int:id>/event/render', methods=['POST'])
@login_required
def api_frame_render_event(id: int):
    frame = Frame.query.get_or_404(id)
    response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/event/render')

    if response.status_code == 200:
        return "OK", 200
    else:
        return jsonify({"error": "Unable to refresh frame"}), response.status_code


@api.route('/frames/<int:id>/reset', methods=['POST'])
@login_required
def api_frame_reset_event(id: int):
    reset_frame(id)
    return 'Success', 200


@api.route('/frames/<int:id>/restart', methods=['POST'])
@login_required
def api_frame_restart_event(id: int):
    restart_frame(id)
    return 'Success', 200


@api.route('/frames/<int:id>/deploy', methods=['POST'])
@login_required
def api_frame_deploy_event(id: int):
    deploy_frame(id)
    return 'Success', 200


@api.route('/frames/<int:id>', methods=['POST'])
@login_required
def api_frame_update(id: int):
    frame = Frame.query.get_or_404(id)
    fields = ['scenes', 'name', 'frame_host', 'frame_port', 'ssh_user', 'ssh_pass', 'ssh_port', 'server_host',
              'server_port', 'server_api_key', 'width', 'height', 'rotate', 'color', 'interval', 'metrics_interval',
              'scaling_mode', 'background_color', 'device']
    defaults = {'frame_port': 8999, 'ssh_port': 22}
    try:
        for field in fields:
            if field in request.form:
                value = request.form[field]
                if value == '' or value == 'null':
                    value = defaults.get(field, None)
                elif field in ['frame_port', 'ssh_port', 'width', 'height', 'rotate']:
                    value = int(value)
                elif field in ['interval', 'metrics_interval']:
                    value = float(value)
                elif field in ['scenes']:
                    value = json.loads(value) if value is not None else None
                setattr(frame, field, value)
    except ValueError as e:
        return jsonify({'error': 'Invalid input', 'message': str(e)}), HTTPStatus.BAD_REQUEST

    update_frame(frame)

    if request.form.get('next_action') == 'restart':
        restart_frame(frame.id)
    elif request.form.get('next_action') == 'deploy':
        deploy_frame(frame.id)

    return jsonify({'message': 'Frame updated successfully'}), HTTPStatus.OK

@api.route("/frames/new", methods=["POST"])
@login_required
def api_frame_new():
    name = request.form['name']
    frame_host = request.form['frame_host']
    server_host = request.form['server_host']
    device = request.form.get('device', 'web_only')
    frame = new_frame(name, frame_host, server_host, device)
    return jsonify(frame=frame.to_dict())


@api.route('/frames/<int:frame_id>', methods=['DELETE'])
@login_required
def api_frame_delete(frame_id):
    success = delete_frame(frame_id)
    if success:
        return jsonify({'message': 'Frame deleted successfully'}), 200
    else:
        return jsonify({'message': 'Frame not found'}), 404
