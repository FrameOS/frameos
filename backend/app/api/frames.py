from datetime import datetime, timedelta
import subprocess
import tempfile
from uuid import uuid4
import asyncssh
import io
import json
import aiofiles
import os
import shlex
from jose import JWTError, jwt
from http import HTTPStatus
from tempfile import NamedTemporaryFile

import httpx
from fastapi import Depends, File, Form, Request, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from arq import ArqRedis as Redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.models.log import new_log as log
from app.models.metrics import Metrics
from app.codegen.scene_nim import write_scene_nim
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection
from app.schemas.frames import (
    FramesListResponse, FrameResponse, FrameLogsResponse,
    FrameMetricsResponse, FrameImageLinkResponse, FrameStateResponse,
    FrameAssetsResponse, FrameCreateRequest, FrameUpdateRequest
)
from app.api.auth import ALGORITHM, SECRET_KEY
from app.config import config
from app.utils.network import is_safe_host
from app.redis import get_redis
from . import api_with_auth, api_no_auth


@api_with_auth.get("/frames", response_model=FramesListResponse)
async def api_frames_list(db: Session = Depends(get_db)):
    frames = db.query(Frame).all()
    frames_list = [frame.to_dict() for frame in frames]
    return {"frames": frames_list}


@api_with_auth.get("/frames/{id:int}", response_model=FrameResponse)
async def api_frame_get(id: int, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    return {"frame": frame.to_dict()}


@api_with_auth.get("/frames/{id:int}/logs", response_model=FrameLogsResponse)
async def api_frame_get_logs(id: int, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    logs = [ll.to_dict() for ll in frame.logs][-1000:]
    return {"logs": logs}


@api_with_auth.get("/frames/{id:int}/image_link", response_model=FrameImageLinkResponse)
async def get_image_link(id: int):
    expire_minutes = 5
    now = datetime.utcnow()
    expire = now + timedelta(minutes=expire_minutes)
    to_encode = {"sub": f"frame={id}", "exp": expire}
    token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

    expires_in = int((expire - now).total_seconds())

    return {
        "url": config.ingress_path + f"/api/frames/{id}/image?token={token}",
        "expires_in": expires_in
    }

@api_no_auth.get("/frames/{id:int}/image")
async def api_frame_get_image(id: int, token: str, request: Request, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    if config.HASSIO_RUN_MODE != 'ingress':
        # All modes except ingress require a token in the url
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("sub") != f"frame={id}":
                raise HTTPException(status_code=401, detail="Unauthorized")
        except JWTError:
            raise HTTPException(status_code=401, detail="Unauthorized")

    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

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
            raise HTTPException(status_code=response.status_code, detail="Unable to fetch image")

    except httpx.ReadTimeout:
        raise HTTPException(status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Request Timeout to {url}")
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.get("/frames/{id:int}/state", response_model=FrameStateResponse)
async def api_frame_get_state(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:state'
    url = f'http://{frame.frame_host}:{frame.frame_port}/state'
    if frame.frame_access != "public" and frame.frame_access_key is not None:
        url += "?k=" + frame.frame_access_key

    try:
        last_state = await redis.get(cache_key)
        if last_state:
            return json.loads(last_state)

        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15.0)

        if response.status_code == 200:
            await redis.set(cache_key, response.content, ex=1)
            return response.json()
        else:
            last_state = await redis.get(cache_key)
            if last_state:
                return json.loads(last_state)
            raise HTTPException(status_code=response.status_code, detail="Unable to fetch state")
    except httpx.ReadTimeout:
        raise HTTPException(status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Request Timeout to {url}")
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.get("/frames/{id:int}/states", response_model=FrameStateResponse)
async def api_frame_get_states(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:states'
    url = f'http://{frame.frame_host}:{frame.frame_port}/states'
    if frame.frame_access != "public" and frame.frame_access_key is not None:
        url += "?k=" + frame.frame_access_key

    try:
        last_states = await redis.get(cache_key)
        if last_states:
            return json.loads(last_states)

        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15.0)

        if response.status_code == 200:
            await redis.set(cache_key, response.content, ex=1)
            return response.json()
        else:
            last_states = await redis.get(cache_key)
            if last_states:
                return json.loads(last_states)
            raise HTTPException(status_code=response.status_code, detail="Unable to fetch state")
    except httpx.ReadTimeout:
        raise HTTPException(status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Request Timeout to {url}")
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/event/{event}")
async def api_frame_event(id: int, event: str, request: Request, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

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
            return "OK"
        else:
            raise HTTPException(status_code=response.status_code, detail="Unable to reach frame")
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.get("/frames/{id:int}/scene_source/{scene}")
async def api_frame_scene_source(id: int, scene: str, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    for scene_json in frame.scenes or []:
        if scene_json.get('id') == scene:
            return {"source": write_scene_nim(frame, scene_json)}
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=f"Scene {scene} not found")


@api_with_auth.get("/frames/{id:int}/assets", response_model=FrameAssetsResponse)
async def api_frame_get_assets(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    assets_path = frame.assets_path or "/srv/assets"
    ssh = await get_ssh_connection(db, redis, frame)
    command = f"find {assets_path} -type f -exec stat --format='%s %Y %n' {{}} +"
    output: list[str] = []
    await exec_command(db, redis, frame, ssh, command, output, log_output=False)
    await remove_ssh_connection(db, redis, ssh, frame)

    assets = []
    for line in output:
        if line.strip():
            parts = line.split(' ', 2)
            size, mtime, path = parts
            assets.append({
                'path': path.strip(),
                'size': int(size.strip()),
                'mtime': int(mtime.strip()),
            })

    assets.sort(key=lambda x: x['path'])
    return {"assets": assets}


@api_with_auth.get("/frames/{id:int}/asset")
async def api_frame_get_asset(
    id: int,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis)
):
    """
    Download or stream an asset from the remote frame's filesystem using async SSH.
    Uses an MD5 of the remote file to cache the content in Redis.
    """
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    assets_path = frame.assets_path or "/srv/assets"
    path = request.query_params.get('path')
    mode = request.query_params.get('mode', 'download')
    filename = request.query_params.get('filename', os.path.basename(path or "."))

    if not path:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Path parameter is required")

    normalized_path = os.path.normpath(os.path.join(assets_path, path))
    # Ensure the requested asset is inside the assets_path directory
    if not normalized_path.startswith(os.path.normpath(assets_path)):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid asset path")

    try:
        ssh = await get_ssh_connection(db, redis, frame)
        try:
            # 1) Generate an MD5 sum of the remote file
            escaped_path = shlex.quote(normalized_path)
            command = f"md5sum {escaped_path}"

            # We'll read the MD5 from the command output
            md5_output: list[str] = []
            await exec_command(db, redis, frame, ssh, command, output=md5_output, log_output=False)
            md5sum_output = "".join(md5_output).strip()
            if not md5sum_output:
                raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")

            md5sum = md5sum_output.split()[0]
            cache_key = f'asset:{md5sum}'

            # 2) Check if we already have this asset cached in Redis
            cached_asset = await redis.get(cache_key)
            if cached_asset:
                return StreamingResponse(
                    io.BytesIO(cached_asset),
                    media_type='image/png' if mode == 'image' else 'application/octet-stream',
                    headers={
                        "Content-Disposition": (
                            f'{"attachment" if mode == "download" else "inline"}; filename={filename}'
                        )
                    }
                )

            # 3) No cache found. Use asyncssh.scp to copy the remote file into a local temp file.
            with NamedTemporaryFile(delete=False) as temp_file:
                local_temp_path = temp_file.name

            # scp from remote -> local
            #  Note: (ssh, normalized_path) means "download from 'normalized_path' on the remote `ssh` connection"
            await asyncssh.scp(
                (ssh, escaped_path),
                local_temp_path,
                recurse=False
            )

            # 4) Read file contents and store in Redis
            with open(local_temp_path, "rb") as f:
                asset_content = f.read()

            await redis.set(cache_key, asset_content, ex=86400 * 30)

            # Cleanup temp file
            os.remove(local_temp_path)

            # 5) Return the file to the user
            return StreamingResponse(
                io.BytesIO(asset_content),
                media_type='image/png' if mode == 'image' else 'application/octet-stream',
                headers={
                    "Content-Disposition": (
                        f'{"attachment" if mode == "download" else "inline"}; filename={filename}'
                    )
                }
            )
        except Exception as e:
            print(e)
            raise e

        finally:
            await remove_ssh_connection(db, redis, ssh, frame)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

@api_with_auth.post("/frames/{id:int}/assets/sync")
async def api_frame_assets_sync(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    try:
        from app.models.assets import sync_assets
        ssh = await get_ssh_connection(db, redis, frame)
        try:
            await sync_assets(db, redis, frame, ssh)
        finally:
            await remove_ssh_connection(db, redis, ssh, frame)
        return {"message": "Assets synced successfully"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

@api_with_auth.post("/frames/{id:int}/assets/upload")
async def api_frame_assets_upload(
    id: int,
    path: str = Form(..., description="Folder where to place this asset"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    if not path:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Path parameter is required")
    if "*" in path:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid character * in path")
    assets_path = frame.assets_path or "/srv/assets"
    combined_path = os.path.normpath(os.path.join(assets_path, path, file.filename))
    if not combined_path.startswith(os.path.normpath(assets_path) + '/'):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid asset path")

    # TODO: stream and reuse connections
    ssh = await get_ssh_connection(db, redis, frame)
    try:
        with NamedTemporaryFile(delete=True) as temp_file:
            local_temp_path = temp_file.name
            contents = await file.read()
            with open(local_temp_path, "wb") as f:
                f.write(contents)
            await log(db, redis, id, "stdout", f"Uploading: {combined_path}")
            scp_escaped_path = shlex.quote(combined_path)
            await asyncssh.scp(
                local_temp_path,
                (ssh, scp_escaped_path),
                recurse=False
            )
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

    finally:
        await remove_ssh_connection(db, redis, ssh, frame)

    path_without_combined = os.path.relpath(combined_path, assets_path)

    return {"path": path_without_combined, "size": len(contents), "mtime": int(datetime.now().timestamp())}

@api_with_auth.post("/frames/{id:int}/clear_build_cache")
async def api_frame_clear_build_cache(id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    try:
        ssh = await get_ssh_connection(db, redis, frame)
        try:
            command = "rm -rf /srv/frameos/build/cache"
            await exec_command(db, redis, frame, ssh, command)
        finally:
            await remove_ssh_connection(db, redis, ssh, frame)
        return {"message": "Build cache cleared successfully"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/build_pi_image")
async def api_frame_build_pi_image(id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    ssid = "testtest"
    wifi_password = "testtest"
    ssh_public_key = "testtest"
    download_url = "https://downloads.raspberrypi.org/raspios_lite_arm64/images/raspios_lite_arm64-2024-11-19/2024-11-19-raspios-bookworm-arm64-lite.img.xz"

    async def run(cmd):
        subprocess.run(cmd, check=True)

    with tempfile.TemporaryDirectory(prefix=f"pi_img_{uuid4()}_") as tmpdir:
        download_path = os.path.join(tmpdir, "raspios.img.xz")
        image_path = os.path.join(tmpdir, "raspios.img")

        # Download and decompress image
        await run(["wget", "-O", download_path, download_url])
        await run(["unxz", download_path])

        img_files = [f for f in os.listdir(tmpdir) if f.endswith(".img")]
        if not img_files:
            raise HTTPException(status_code=500, detail="Image file not found after decompression")

        os.rename(os.path.join(tmpdir, img_files[0]), image_path)

        mount_boot = os.path.join(tmpdir, "boot")
        mount_root = os.path.join(tmpdir, "root")
        os.makedirs(mount_boot, exist_ok=True)
        os.makedirs(mount_root, exist_ok=True)

        # Mount partitions (macOS compatibility: assuming hdiutil)
        if os.uname().sysname == "Darwin":
            await run(["hdiutil", "attach", "-nomount", image_path])
            boot_partition = "/dev/disk2s1"
            root_partition = "/dev/disk2s2"
        else:
            loop_output = subprocess.check_output(["sudo", "kpartx", "-av", image_path]).decode()
            loop_device = loop_output.split()[2].strip().replace("p1", "")
            boot_partition = f"/dev/mapper/{loop_device}p1"
            root_partition = f"/dev/mapper/{loop_device}p2"

        try:
            await run(["sudo", "mount", boot_partition, mount_boot])
            await run(["sudo", "mount", root_partition, mount_root])

            # Configure WiFi
            wpa_conf = (
                "country=US\n"
                "ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\n"
                "update_config=1\n\n"
                f"network={{\n    ssid=\"{ssid}\"\n    psk=\"{wifi_password}\"\n}}\n"
            )

            async with aiofiles.open(f"{mount_boot}/wpa_supplicant.conf", "w") as f:
                await f.write(wpa_conf)

            # Enable SSH
            open(f"{mount_boot}/ssh", "w").close()

            # Add SSH key
            ssh_dir = f"{mount_root}/home/pi/.ssh"
            os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
            async with aiofiles.open(f"{ssh_dir}/authorized_keys", "w") as f:
                await f.write(ssh_public_key + "\n")
            await run(["sudo", "chown", "-R", "1000:1000", ssh_dir])
            await run(["sudo", "chmod", "600", f"{ssh_dir}/authorized_keys"])

        finally:
            await run(["sudo", "umount", mount_boot])
            await run(["sudo", "umount", mount_root])
            if os.uname().sysname == "Darwin":
                await run(["hdiutil", "detach", boot_partition.replace("s1", "")])
            else:
                await run(["sudo", "kpartx", "-dv", image_path])

        return FileResponse(image_path, filename="custom_raspios.img", media_type="application/octet-stream")

@api_with_auth.post("/frames/{id:int}/reset")
async def api_frame_reset_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import reset_frame
        await reset_frame(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/restart")
async def api_frame_restart_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import restart_frame
        await restart_frame(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/stop")
async def api_frame_stop_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import stop_frame
        await stop_frame(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/deploy")
async def api_frame_deploy_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import deploy_frame
        await deploy_frame(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/fast_deploy")
async def api_frame_fast_deploy_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import fast_deploy_frame
        await fast_deploy_frame(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}")
async def api_frame_update_endpoint(
    id: int,
    data: FrameUpdateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id)
    if not frame:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    update_data = data.model_dump(exclude_unset=True)
    # If 'scenes' is a string, parse it as JSON
    if isinstance(update_data.get('scenes'), str):
        try:
            update_data['scenes'] = json.loads(update_data['scenes'])
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid input for scenes (must be JSON)")

    for field, value in update_data.items():
        setattr(frame, field, value)

    await update_frame(db, redis, frame)

    if data.next_action == 'restart':
        from app.tasks import restart_frame
        await restart_frame(id, redis)
    elif data.next_action == 'stop':
        from app.tasks import stop_frame
        await stop_frame(id, redis)
    elif data.next_action == 'deploy':
        from app.tasks import deploy_frame
        await deploy_frame(id, redis)

    return {"message": "Frame updated successfully"}


@api_with_auth.post("/frames/new", response_model=FrameResponse)
async def api_frame_new(data: FrameCreateRequest, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    try:
        frame = await new_frame(db, redis, data.name, data.frame_host, data.server_host, data.device, data.interval)
        return {"frame": frame.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.delete("/frames/{frame_id}")
async def api_frame_delete(
    frame_id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis)
):
    success = await delete_frame(db, redis, frame_id)
    if success:
        return {"message": "Frame deleted successfully"}
    else:
        raise HTTPException(status_code=404, detail="Frame not found")


@api_with_auth.get("/frames/{id:int}/metrics", response_model=FrameMetricsResponse)
async def api_frame_metrics(id: int, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
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
        return {"metrics": metrics_list}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))
