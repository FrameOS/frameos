import json
import requests

from http import HTTPStatus
from flask import jsonify, request, Response
from flask_login import login_required
from . import api
from app import redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.codegen.scene_nim import write_scene_nim


@api.route("/frames", methods=["GET"])
@login_required
def api_frames():
    try:
        frames = Frame.query.all()
        frames_list = [frame.to_dict() for frame in frames]
        return jsonify(frames=frames_list)
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>', methods=['GET'])
@login_required
def api_frame_get(id: int):
    try:
        frame = Frame.query.get_or_404(id)
        return jsonify(frame=frame.to_dict())
    except Exception as e:
        return jsonify({'error': 'Frame not found', 'message': str(e)}), HTTPStatus.NOT_FOUND

@api.route('/frames/<int:id>/logs', methods=['GET'])
@login_required
def api_frame_get_logs(id: int):
    try:
        frame = Frame.query.get_or_404(id)
        logs = [log.to_dict() for log in frame.logs]
        logs = logs[-1000:]  # limit the logs to the last 1000 entries
        return jsonify(logs=logs)
    except Exception as e:
        return jsonify({'error': 'Logs not found', 'message': str(e)}), HTTPStatus.NOT_FOUND

@api.route('/frames/<int:id>/image', methods=['GET'])
@login_required
def api_frame_get_image(id: int):
    frame = Frame.query.get_or_404(id)
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    url = f'http://{frame.frame_host}:{frame.frame_port}/image'

    try:
        if request.args.get('t') == '-1':
            last_image = redis.get(cache_key)
            if last_image:
                return Response(last_image, content_type='image/png')

        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            redis.set(cache_key, response.content, ex=86400 * 30)  # cache for 30 days
            return Response(response.content, content_type='image/png')
        else:
            last_image = redis.get(cache_key)
            if last_image:
                return Response(last_image, content_type='image/png')
            return jsonify({"error": "Unable to fetch image"}), response.status_code
    except requests.exceptions.Timeout:
        return jsonify({'error': f'Request Timeout to {url}'}), HTTPStatus.REQUEST_TIMEOUT
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/event/render', methods=['POST'])
@login_required
def api_frame_render_event(id: int):
    frame = Frame.query.get_or_404(id)
    try:
        response = requests.get(f'http://{frame.frame_host}:{frame.frame_port}/event/render')
        if response.status_code == 200:
            return "OK", 200
        else:
            return jsonify({"error": "Unable to refresh frame"}), response.status_code
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/scene_source/<scene>', methods=['GET'])
@login_required
def api_frame_scene_source(id: int, scene: str):
    frame = Frame.query.get_or_404(id)
    scene = [scene for scene in frame.scenes if scene.get('id') == 'default'][0]
    if not scene:
        return jsonify({'error': f'Scene {scene} not found'}), HTTPStatus.NOT_FOUND
    return jsonify({'source': write_scene_nim(frame, scene)})

@api.route('/frames/<int:id>/reset', methods=['POST'])
@login_required
def api_frame_reset_event(id: int):
    try:
        from app.tasks import reset_frame
        reset_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/restart', methods=['POST'])
@login_required
def api_frame_restart_event(id: int):
    try:
        from app.tasks import restart_frame
        restart_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/deploy', methods=['POST'])
@login_required
def api_frame_deploy_event(id: int):
    try:
        from app.tasks import deploy_frame
        deploy_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>', methods=['POST'])
@login_required
def api_frame_update(id: int):
    frame = Frame.query.get_or_404(id)
    fields = ['scenes', 'name', 'frame_host', 'frame_port', 'ssh_user', 'ssh_pass', 'ssh_port', 'server_host',
              'server_port', 'server_api_key', 'width', 'height', 'rotate', 'color', 'interval', 'metrics_interval',
              'scaling_mode', 'background_color', 'device']
    defaults = {'frame_port': 8787, 'ssh_port': 22}
    try:
        payload = request.json
        for field in fields:
            if field in payload:
                value = payload[field]
                if value == '' or value == 'null':
                    value = defaults.get(field, None)
                elif field in ['frame_port', 'ssh_port', 'width', 'height', 'rotate'] and value is not None:
                    value = int(value)
                elif field in ['interval', 'metrics_interval'] and value is not None:
                    value = float(value)
                elif field in ['scenes']:
                    if type(value) == str:
                        value = json.loads(value) if value is not None else None
                setattr(frame, field, value)
        update_frame(frame)

        if payload.get('next_action') == 'restart':
            from app.tasks import restart_frame
            restart_frame(frame.id)
        elif payload.get('next_action') == 'deploy':
            from app.tasks import deploy_frame
            deploy_frame(frame.id)

        return jsonify({'message': 'Frame updated successfully'}), HTTPStatus.OK
    except ValueError as e:
        return jsonify({'error': 'Invalid input', 'message': str(e)}), HTTPStatus.BAD_REQUEST
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route("/frames/new", methods=["POST"])
@login_required
def api_frame_new():
    try:
        name = request.json['name']
        frame_host = request.json['frame_host']
        server_host = request.json['server_host']
        device = request.json.get('device', 'web_only')
        frame = new_frame(name, frame_host, server_host, device)
        return jsonify(frame=frame.to_dict())
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:frame_id>', methods=['DELETE'])
@login_required
def api_frame_delete(frame_id):
    try:
        success = delete_frame(frame_id)
        if success:
            return jsonify({'message': 'Frame deleted successfully'}), 200
        else:
            return jsonify({'message': 'Frame not found'}), 404
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR
