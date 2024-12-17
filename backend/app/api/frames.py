import io
import json
import os
import shlex
import asyncio
from http import HTTPStatus
from tempfile import NamedTemporaryFile

import httpx
from fastapi import Depends, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.redis import redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.models.log import new_log as log
from app.models.metrics import Metrics
from app.codegen.scene_nim import write_scene_nim
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection
from scp import SCPClient
from . import api


@api.get("/frames")
async def api_frames_list(db: Session = Depends(get_db)):
    try:
        frames = db.query(Frame).all()
        frames_list = [frame.to_dict() for frame in frames]
        return JSONResponse(content={"frames": frames_list}, status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.get("/frames/{id}")
async def api_frame_get(id: int, db: Session = Depends(get_db)):
    try:
        frame = db.query(Frame).get(id)
        if frame is None:
            return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
        return JSONResponse(content={"frame": frame.to_dict()}, status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Frame not found', 'message': str(e)},
                            status_code=HTTPStatus.NOT_FOUND)


@api.get("/frames/{id}/logs")
async def api_frame_get_logs(id: int, db: Session = Depends(get_db)):
    try:
        frame = db.query(Frame).get(id)
        if frame is None:
            return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
        logs = [ll.to_dict() for ll in frame.logs][-1000:]
        return JSONResponse(content={"logs": logs}, status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Logs not found', 'message': str(e)},
                            status_code=HTTPStatus.NOT_FOUND)


@api.get("/frames/{id}/image")
async def api_frame_get_image(id: int, request: Request, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)

    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
    url = f'http://{frame.frame_host}:{frame.frame_port}/image'
    if frame.frame_access not in ["public", "protected"] and frame.frame_access_key is not None:
        url += "?k=" + frame.frame_access_key

    try:
        if request.query_params.get('t') == '-1':
            last_image = await redis.get(cache_key)
            if last_image:
                return Response(content=last_image, media_type='image/png')

        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15.0)

        if response.status_code == 200:
            await redis.set(cache_key, response.content, ex=86400 * 30)
            return Response(content=response.content, media_type='image/png')
        else:
            last_image = await redis.get(cache_key)
            if last_image:
                return Response(content=last_image, media_type='image/png')
            return JSONResponse(content={"error": "Unable to fetch image"}, status_code=response.status_code)

    except httpx.ReadTimeout:
        return JSONResponse(content={'error': f'Request Timeout to {url}'},
                            status_code=HTTPStatus.REQUEST_TIMEOUT)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.get("/frames/{id}/state")
async def api_frame_get_state(id: int, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)

    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:state'
    url = f'http://{frame.frame_host}:{frame.frame_port}/state'
    if frame.frame_access != "public" and frame.frame_access_key is not None:
        url += "?k=" + frame.frame_access_key

    try:
        last_state = await redis.get(cache_key)
        if last_state:
            return Response(content=last_state, media_type='application/json')

        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15.0)

        if response.status_code == 200:
            await redis.set(cache_key, response.content, ex=1)
            return Response(content=response.content, media_type='application/json')
        else:
            last_state = await redis.get(cache_key)
            if last_state:
                return Response(content=last_state, media_type='application/json')
            return JSONResponse(content={"error": "Unable to fetch state"}, status_code=response.status_code)
    except httpx.ReadTimeout:
        return JSONResponse(content={'error': f'Request Timeout to {url}'},
                            status_code=HTTPStatus.REQUEST_TIMEOUT)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/{id}/event/{event}")
async def api_frame_event(id: int, event: str, request: Request, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
    try:
        headers = {}
        if frame.frame_access != "public" and frame.frame_access_key is not None:
            headers["Authorization"] = f'Bearer {frame.frame_access_key}'

        async with httpx.AsyncClient() as client:
            if request.headers.get('content-type') == 'application/json':
                body = await request.json()
                response = await client.post(
                    f'http://{frame.frame_host}:{frame.frame_port}/event/{event}',
                    json=body, headers=headers, timeout=15.0
                )
            else:
                response = await client.post(
                    f'http://{frame.frame_host}:{frame.frame_port}/event/{event}',
                    headers=headers, timeout=15.0
                )

        if response.status_code == 200:
            return Response(content="OK", status_code=200)
        else:
            return JSONResponse(content={"error": "Unable to reach frame"}, status_code=response.status_code)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.get("/frames/{id}/scene_source/{scene}")
async def api_frame_scene_source(id: int, scene: str, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
    for scene_json in frame.scenes:
        if scene_json.get('id') == scene:
            return JSONResponse(content={'source': write_scene_nim(frame, scene_json)}, status_code=200)
    return JSONResponse(content={'error': f'Scene {scene} not found'}, status_code=HTTPStatus.NOT_FOUND)


@api.get("/frames/{id}/assets")
async def api_frame_get_assets(id: int, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
    assets_path = frame.assets_path or "/srv/assets"
    ssh = await get_ssh_connection(db, frame)
    command = f"find {assets_path} -type f -exec stat --format='%s %Y %n' {{}} +"
    output: list[str] = []
    await exec_command(db, frame, ssh, command, output, log_output=False)
    remove_ssh_connection(ssh)

    assets = []
    for line in output:
        parts = line.split(' ', 2)
        size, mtime, path = parts
        assets.append({
            'path': path.strip(),
            'size': int(size.strip()),
            'mtime': int(mtime.strip()),
        })

    assets.sort(key=lambda x: x['path'])
    return JSONResponse(content={"assets": assets}, status_code=200)


@api.get("/frames/{id}/asset")
async def api_frame_get_asset(id: int, request: Request, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
    assets_path = frame.assets_path or "/srv/assets"
    path = request.query_params.get('path')
    mode = request.query_params.get('mode', 'download')
    filename = request.query_params.get('filename', os.path.basename(path or "."))

    if not path:
        return JSONResponse(content={'error': 'Path parameter is required'},
                            status_code=HTTPStatus.BAD_REQUEST)

    normalized_path = os.path.normpath(os.path.join(assets_path, path))
    if not normalized_path.startswith(os.path.normpath(assets_path)):
        return JSONResponse(content={'error': 'Invalid asset path'},
                            status_code=HTTPStatus.BAD_REQUEST)

    try:
        ssh = await get_ssh_connection(db, frame)
        try:
            escaped_path = shlex.quote(normalized_path)
            command = f"md5sum {escaped_path}"
            await log(db, frame.id, "stdinfo", f"> {command}")
            stdin, stdout, stderr = ssh.exec_command(command)
            md5sum_output = stdout.read().decode().strip()
            if not md5sum_output:
                return JSONResponse(content={'error': 'Asset not found'},
                                    status_code=HTTPStatus.NOT_FOUND)

            md5sum = md5sum_output.split()[0]
            cache_key = f'asset:{md5sum}'

            cached_asset = await redis.get(cache_key)
            if cached_asset:
                return StreamingResponse(
                    io.BytesIO(cached_asset),
                    media_type='image/png' if mode == 'image' else 'application/octet-stream',
                    headers={
                        "Content-Disposition": f'{"attachment" if mode == "download" else "inline"}; filename={filename}'
                    }
                )

            # TODO: SCP is synchronous; wrap it with threads
            with NamedTemporaryFile(delete=True) as temp_file:
                with SCPClient(ssh.get_transport()) as scp:
                    scp.get(normalized_path, temp_file.name)
                temp_file.seek(0)
                asset_content = temp_file.read()
                await redis.set(cache_key, asset_content, ex=86400 * 30)
                return StreamingResponse(
                    io.BytesIO(asset_content),
                    media_type='image/png' if mode == 'image' else 'application/octet-stream',
                    headers={
                        "Content-Disposition": f'{"attachment" if mode == "download" else "inline"}; filename={filename}'
                    }
                )
        finally:
            remove_ssh_connection(ssh)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/{id}/reset")
async def api_frame_reset_event(id: int):
    try:
        from app.tasks import reset_frame
        asyncio.create_task(reset_frame(id))
        return Response(content='Success', status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/{id}/restart")
async def api_frame_restart_event(id: int):
    try:
        from app.tasks import restart_frame
        asyncio.create_task(restart_frame(id))
        return Response(content='Success', status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/{id}/stop")
async def api_frame_stop_event(id: int):
    try:
        from app.tasks import stop_frame
        asyncio.create_task(stop_frame(id))
        return Response(content='Success', status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/{id}/deploy")
async def api_frame_deploy_event(id: int):
    try:
        from app.tasks import deploy_frame
        asyncio.create_task(deploy_frame(id))
        return Response(content='Success', status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/{id}")
async def api_frame_update(id: int, request: Request, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
    fields = ['scenes', 'name', 'frame_host', 'frame_port', 'frame_access_key', 'frame_access', 'ssh_user', 'ssh_pass',
              'ssh_port', 'server_host', 'server_port', 'server_api_key', 'width', 'height', 'rotate', 'color',
              'interval', 'metrics_interval', 'log_to_file', 'assets_path', 'save_assets', 'scaling_mode', 'device',
              'debug', 'reboot', 'control_code']
    defaults = {'frame_port': 8787, 'ssh_port': 22}
    try:
        payload = await request.json()
        for field in fields:
            if field in payload:
                value = payload[field]
                if value == '' or value == 'null':
                    value = defaults.get(field, None)
                elif field in ['frame_port', 'ssh_port', 'width', 'height', 'rotate'] and value is not None:
                    value = int(value)
                elif field in ['interval', 'metrics_interval'] and value is not None:
                    value = float(value)
                elif field == 'debug':
                    value = value == 'true' or value is True
                elif field in ['scenes', 'reboot', 'control_code'] and isinstance(value, str):
                    value = json.loads(value) if value is not None else None
                elif field == 'save_assets':
                    if value in ['true', True]:
                        value = True
                    elif value in ['false', False]:
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
            asyncio.create_task(restart_frame(frame.id))
        elif payload.get('next_action') == 'stop':
            from app.tasks import stop_frame
            asyncio.create_task(stop_frame(frame.id))
        elif payload.get('next_action') == 'deploy':
            from app.tasks import deploy_frame
            asyncio.create_task(deploy_frame(frame.id))

        return JSONResponse(content={'message': 'Frame updated successfully'}, status_code=200)
    except ValueError as e:
        return JSONResponse(content={'error': 'Invalid input', 'message': str(e)},
                            status_code=HTTPStatus.BAD_REQUEST)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.post("/frames/new")
async def api_frame_new(request: Request, db: Session = Depends(get_db)):
    try:
        payload = await request.json()
        name = payload['name']
        frame_host = payload['frame_host']
        server_host = payload['server_host']
        interval = payload.get('interval', 60)
        device = payload.get('device', 'web_only')
        frame = await new_frame(db, name, frame_host, server_host, device, interval)
        return JSONResponse(content={"frame": frame.to_dict()}, status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.delete("/frames/{frame_id}")
async def api_frame_delete(frame_id: int, db: Session = Depends(get_db)):
    try:
        success = await delete_frame(db, frame_id)
        if success:
            return JSONResponse(content={'message': 'Frame deleted successfully'}, status_code=200)
        else:
            return JSONResponse(content={'message': 'Frame not found'}, status_code=404)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


@api.get("/frames/{id}/metrics")
async def api_frame_metrics(id: int, db: Session = Depends(get_db)):
    frame = db.query(Frame).get(id)
    if frame is None:
        return JSONResponse(content={'error': 'Frame not found'}, status_code=HTTPStatus.NOT_FOUND)
    try:
        metrics = db.query(Metrics).filter_by(frame_id=id).all()
        metrics_list = [
            {
                'id': metric.id,
                'timestamp': metric.timestamp.isoformat(),
                'frame_id': metric.frame_id,
                'metrics': metric.metrics,
            }
            for metric in metrics
        ]
        return JSONResponse(content={"metrics": metrics_list}, status_code=200)
    except Exception as e:
        return JSONResponse(content={'error': 'Internal Server Error', 'message': str(e)},
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR)
