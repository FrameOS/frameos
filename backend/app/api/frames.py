import io
import json
import shlex

import requests
import os

from http import HTTPStatus
from flask import jsonify, request, Response, send_file, g
from . import api
from app.redis import redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.models.log import new_log as log
from app.models.metrics import Metrics
from app.codegen.scene_nim import write_scene_nim
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection
from scp import SCPClient
from tempfile import NamedTemporaryFile


@api.route("/frames", methods=["GET"])
def api_frames():
    db = g.db
    try:
        frames = db.query(Frame).all()
        frames_list = [frame.to_dict() for frame in frames]
        return jsonify(frames=frames_list)
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>', methods=['GET'])
def api_frame_get(id: int):
    db = g.db
    try:
        frame = db.query(Frame).get(id)
        return jsonify(frame=frame.to_dict())
    except Exception as e:
        return jsonify({'error': 'Frame not found', 'message': str(e)}), HTTPStatus.NOT_FOUND

@api.route('/frames/<int:id>/logs', methods=['GET'])
def api_frame_get_logs(id: int):
    db = g.db
    try:
        frame = db.query(Frame).get(id)
        logs = [log.to_dict() for log in frame.logs]
        logs = logs[-1000:]  # limit the logs to the last 1000 entries
        return jsonify(logs=logs)
    except Exception as e:
        return jsonify({'error': 'Logs not found', 'message': str(e)}), HTTPStatus.NOT_FOUND

@api.route('/frames/<int:id>/image', methods=['GET'])
def api_frame_get_image(id: int):
    db = g.db
    frame = db.query(Frame).get(id)
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    url = f'http://{frame.frame_host}:{frame.frame_port}/image'
    if frame.frame_access != "public" and frame.frame_access != "protected" and frame.frame_access_key is not None:
        url += "?k=" + frame.frame_access_key

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

@api.route('/frames/<int:id>/state', methods=['GET'])
def api_frame_get_state(id: int):
    db = g.db
    frame = db.query(Frame).get(id)
    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:state'
    url = f'http://{frame.frame_host}:{frame.frame_port}/state'
    if frame.frame_access != "public" and frame.frame_access_key is not None:
        url += "?k=" + frame.frame_access_key

    try:
        last_state = redis.get(cache_key)
        if last_state:
            return Response(last_state, content_type='application/json')

        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            redis.set(cache_key, response.content, ex=1)  # cache for 1 second
            return Response(response.content, content_type='application/json')
        else:
            last_state = redis.get(cache_key)
            if last_state:
                return Response(last_state, content_type='application/json')
            return jsonify({"error": "Unable to fetch state"}), response.status_code
    except requests.exceptions.Timeout:
        return jsonify({'error': f'Request Timeout to {url}'}), HTTPStatus.REQUEST_TIMEOUT
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/event/<event>', methods=['POST'])
def api_frame_event(id: int, event: str):
    db = g.db
    frame = db.query(Frame).get(id)
    try:
        headers = {}
        if frame.frame_access != "public" and frame.frame_access_key is not None:
            headers["Authorization"] = f'Bearer {frame.frame_access_key}'
        if request.is_json:
            headers["Content-Type"] = "application/json"
            response = requests.post(f'http://{frame.frame_host}:{frame.frame_port}/event/{event}', json=request.json, headers=headers)
        else:
            response = requests.post(f'http://{frame.frame_host}:{frame.frame_port}/event/{event}', headers=headers)
        if response.status_code == 200:
            return "OK", 200
        else:
            return jsonify({"error": "Unable to reach frame"}), response.status_code
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/scene_source/<scene>', methods=['GET'])
def api_frame_scene_source(id: int, scene: str):
    db = g.db
    frame = db.query(Frame).get(id)
    for scene_json in frame.scenes:
         if scene_json.get('id') == scene:
            return jsonify({'source': write_scene_nim(frame, scene_json)})
    return jsonify({'error': f'Scene {scene} not found'}), HTTPStatus.NOT_FOUND

@api.route('/frames/<int:id>/assets', methods=['GET'])
async def api_frame_get_assets(id: int):
    db = g.db
    frame = db.query(Frame).get(id)
    assets_path = frame.assets_path or "/srv/assets"
    ssh = await get_ssh_connection(db, frame)
    command = f"find {assets_path} -type f -exec stat --format='%s %Y %n' {{}} +"
    output: list[str] = []
    await exec_command(db, frame, ssh, command, output, log_output=False)
    remove_ssh_connection(ssh)

    assets: list[dict] = []
    for line in output:
        parts = line.split(' ', 2)
        size, mtime, path = parts
        assets.append({
            'path': path.strip(),
            'size': int(size.strip()),
            'mtime': int(mtime.strip()),
        })

    assets.sort(key=lambda x: x['path'])
    return jsonify(assets=assets)

@api.route('/frames/<int:id>/asset', methods=['GET'])
async def api_frame_get_asset(id: int):
    db = g.db
    frame = db.query(Frame).get(id)
    assets_path = frame.assets_path or "/srv/assets"
    path = request.args.get('path')
    mode = request.args.get('mode', 'download')  # Default mode is 'download'
    filename: str = request.args.get('filename', os.path.basename(path or "."))

    if not path:
        return jsonify({'error': 'Path parameter is required'}), HTTPStatus.BAD_REQUEST

    # Normalize and validate the path
    normalized_path = os.path.normpath(os.path.join(assets_path, path))
    if not normalized_path.startswith(os.path.normpath(assets_path)):
        return jsonify({'error': 'Invalid asset path'}), HTTPStatus.BAD_REQUEST

    try:
        ssh = await get_ssh_connection(db, frame)
        try:
            escaped_path = shlex.quote(normalized_path)
            # Check if the asset exists and get its MD5 hash
            command = f"md5sum {escaped_path}"
            await log(db, frame.id, "stdinfo", f"> {command}")
            stdin, stdout, stderr = ssh.exec_command(command)
            md5sum_output = stdout.read().decode().strip()
            if not md5sum_output:
                return jsonify({'error': 'Asset not found'}), HTTPStatus.NOT_FOUND

            md5sum = md5sum_output.split()[0]
            cache_key = f'asset:{md5sum}'

            cached_asset = redis.get(cache_key)
            if cached_asset:
                return send_file(
                    io.BytesIO(cached_asset),
                    download_name=filename,
                    as_attachment=(mode == 'download'),
                    mimetype='image/png' if mode == 'image' else 'application/octet-stream'
                )

            # Download the file to a temporary file
            with NamedTemporaryFile(delete=True) as temp_file:
                with SCPClient(ssh.get_transport()) as scp:
                    scp.get(normalized_path, temp_file.name)
                temp_file.seek(0)
                asset_content = temp_file.read()
                redis.set(cache_key, asset_content, ex=86400 * 30)  # Cache for 30 days
                return send_file(
                    io.BytesIO(asset_content),
                    download_name=filename,
                    as_attachment=(mode == 'download'),
                    mimetype='image/png' if mode == 'image' else 'application/octet-stream'
                )
        finally:
            remove_ssh_connection(ssh)
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR


@api.route('/frames/<int:id>/reset', methods=['POST'])
def api_frame_reset_event(id: int):
    try:
        from app.tasks import reset_frame
        reset_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/restart', methods=['POST'])
def api_frame_restart_event(id: int):
    try:
        from app.tasks import restart_frame
        restart_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/stop', methods=['POST'])
def api_frame_stop_event(id: int):
    try:
        from app.tasks import stop_frame
        stop_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/deploy', methods=['POST'])
def api_frame_deploy_event(id: int):
    try:
        from app.tasks import deploy_frame
        deploy_frame(id)
        return 'Success', 200
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>', methods=['POST'])
async def api_frame_update(id: int):
    db = g.db
    frame = db.query(Frame).get(id)
    fields = ['scenes', 'name', 'frame_host', 'frame_port', 'frame_access_key', 'frame_access', 'ssh_user', 'ssh_pass', 'ssh_port', 'server_host',
              'server_port', 'server_api_key', 'width', 'height', 'rotate', 'color', 'interval', 'metrics_interval', 'log_to_file',
              'assets_path', 'save_assets', 'scaling_mode', 'device', 'debug', 'reboot', 'control_code']
    defaults = {'frame_port': 8787, 'ssh_port': 22}
    try:
        payload = request.json
        assert payload, 'No input provided'
        for field in fields:
            if field in payload:
                value = payload[field]
                if value == '' or value == 'null':
                    value = defaults.get(field, None)
                elif field in ['frame_port', 'ssh_port', 'width', 'height', 'rotate'] and value is not None:
                    value = int(value)
                elif field in ['interval', 'metrics_interval'] and value is not None:
                    value = float(value)
                elif field in ['debug']:
                    value = value == 'true' or value is True
                elif field in ['scenes', 'reboot', 'control_code']:
                    if isinstance(value, str):
                        value = json.loads(value) if value is not None else None
                elif field in ['save_assets']:
                    if value == 'true' or value is True:
                        value = True
                    elif value == 'false' or value is False:
                        value = False
                    elif isinstance(value, str):
                        value = json.loads(value) if value is not None else None
                    elif isinstance(value, dict):
                        pass
                    else:
                        value = None
                setattr(frame, field, value)
        await update_frame(db, frame)

        if payload.get('next_action') == 'restart':
            from app.tasks import restart_frame
            restart_frame(frame.id)
        if payload.get('next_action') == 'stop':
            from app.tasks import stop_frame
            stop_frame(frame.id)
        elif payload.get('next_action') == 'deploy':
            from app.tasks import deploy_frame
            deploy_frame(frame.id)

        return jsonify({'message': 'Frame updated successfully'}), HTTPStatus.OK
    except ValueError as e:
        return jsonify({'error': 'Invalid input', 'message': str(e)}), HTTPStatus.BAD_REQUEST
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route("/frames/new", methods=["POST"])
def api_frame_new():
    db = g.db
    try:
        name = request.json['name']
        frame_host = request.json['frame_host']
        server_host = request.json['server_host']
        interval = request.json.get('interval', 60)
        device = request.json.get('device', 'web_only')
        frame = new_frame(db, name, frame_host, server_host, device, interval)
        return jsonify(frame=frame.to_dict())
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:frame_id>', methods=['DELETE'])
def api_frame_delete(frame_id):
    try:
        success = delete_frame(frame_id)
        if success:
            return jsonify({'message': 'Frame deleted successfully'}), 200
        else:
            return jsonify({'message': 'Frame not found'}), 404
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR

@api.route('/frames/<int:id>/metrics', methods=['GET'])
def api_frame_metrics(id: int):
    db = g.db
    db.query(Frame).get(id)
    try:
        metrics = db.query(Metrics).filter_by(frame_id=id).all()
        metrics = [
            {
                'id': metric.id,
                'timestamp': metric.timestamp.isoformat(),
                'frame_id': metric.frame_id,
                'metrics': metric.metrics,
            }
            for metric in metrics
        ]
        return jsonify({"metrics": metrics}), HTTPStatus.OK
    except Exception as e:
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), HTTPStatus.INTERNAL_SERVER_ERROR
