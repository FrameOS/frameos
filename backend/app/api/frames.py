from __future__ import annotations

# stdlib ---------------------------------------------------------------------
from datetime import datetime, timedelta
from http import HTTPStatus
import asyncssh
import base64
import hashlib
import io
import json
import os
import shlex
from tempfile import NamedTemporaryFile
from typing import Any, Optional, Tuple

# third-party ---------------------------------------------------------------
import httpx
from jose import JWTError, jwt
from fastapi import Depends, File, Form, Request, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

# local ---------------------------------------------------------------------
from app.database import get_db
from arq import ArqRedis as Redis
from app.models.frame import Frame, new_frame, delete_frame, update_frame
from app.models.log import new_log as log
from app.models.metrics import Metrics
from app.codegen.scene_nim import write_scene_nim
from app.utils.ssh_utils import (
    get_ssh_connection,
    exec_command,
    remove_ssh_connection,
)
from app.schemas.frames import (
    FramesListResponse,
    FrameResponse,
    FrameLogsResponse,
    FrameMetricsResponse,
    FrameImageLinkResponse,
    FrameStateResponse,
    FrameAssetsResponse,
    FrameCreateRequest,
    FrameUpdateRequest,
)
from app.api.auth import ALGORITHM, SECRET_KEY
from app.config import config
from app.utils.network import is_safe_host
from app.redis import get_redis
from app.websockets import publish_message
from app.ws.agent_ws import (
    http_get_on_frame,
    number_of_connections_for_frame,
    file_md5_on_frame,
    file_read_on_frame,
    file_write_on_frame,
    assets_list_on_frame,
    exec_shell_on_frame,
)
from . import api_with_auth, api_no_auth

def _not_found():
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _bad_request(msg: str):
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=msg)


def _build_frame_path(frame: Frame, path: str) -> str:
    """
    Return a fully-qualified /path (adds ?k=… when the frame is not public).
    """
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    if frame.frame_access not in ("public", "protected") and frame.frame_access_key:
        sep = "&" if "?" in path else "?"
        path = f"{path}{sep}k={frame.frame_access_key}"
    return path


def _build_frame_url(frame: Frame, path: str) -> str:
    """Return full http://host:port/… URL (adds access key when required)."""
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    url = f"http://{frame.frame_host}:{frame.frame_port}{_build_frame_path(frame, path)}"
    return url


def _auth_headers(frame: Frame, hdrs: Optional[dict[str, str]] = None) -> dict[str, str]:
    """
    Inject HTTP Authorization header when the frame is not public.
    """
    hdrs = dict(hdrs or {})
    if frame.frame_access != "public" and frame.frame_access_key:
        hdrs.setdefault("Authorization", f"Bearer {frame.frame_access_key}")
    return hdrs


def _normalise_agent_response(resp: Any) -> tuple[int, Any]:
    """
    Agent “http” command returns {"status": int, "body": str}.
    Convert that (or a normal HTTPX Response) into (status-code, payload).
    """
    if isinstance(resp, dict) and {"status", "body"} <= resp.keys():
        status = int(resp.get("status", 0))
        body_raw = resp.get("body", "")
        try:
            payload = json.loads(body_raw)
        except (TypeError, json.JSONDecodeError):
            payload = body_raw
        return status, payload

    # already a JSON-payload (e.g. other agent commands)
    return 200, resp


async def _use_agent(frame: Frame, redis: Redis) -> bool:
    """
    Returns True when at least one websocket agent connection is live.
    """
    return (await number_of_connections_for_frame(redis, frame.id)) > 0

async def _forward_frame_request(
    frame: Frame,
    redis: Redis,
    *,
    path: str,
    method: str = "GET",
    json_body: Any | None = None,
    cache_key: str | None = None,
    cache_ttl: int = 1,
) -> Any:
    """
    Send HTTP-like request to the frame – first via the agent websocket (“http”
    command), otherwise plain HTTP. A small Redis cache (1 s default) is used
    for very chatty endpoints like /state.
    """

    # 0) maybe serve from cache
    if cache_key and (cached := await redis.get(cache_key)):
        return json.loads(cached)

    # JSON body must be encoded as *string* when travelling through the agent
    body_for_agent: str | None = None
    if json_body is not None:
        body_for_agent = json.dumps(json_body)

    # 1) agent first --------------------------------------------------------
    if await _use_agent(frame, redis):
        agent_resp = await http_get_on_frame(
            frame.id,
            _build_frame_path(frame, path),
            method=method.upper(),
            body=body_for_agent,
        )
        status, payload = _normalise_agent_response(agent_resp)
        if status == 200:
            if cache_key:
                await redis.set(cache_key, json.dumps(payload).encode(), ex=cache_ttl)
            return payload

        raise HTTPException(status_code=400, detail=f"Agent error: {status} {payload}")

    # 2) plain HTTP fallback -------------------------------------------------
    url  = _build_frame_url(frame, path)
    hdrs = _auth_headers(frame)
    async with httpx.AsyncClient() as client:
        try:
            response = await client.request(
                method, url, json=json_body, headers=hdrs, timeout=15.0
            )
        except httpx.ReadTimeout:
            raise HTTPException(status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Timeout to {url}")
        except Exception as exc:
            raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc))

    if response.status_code == 200:
        if cache_key:
            await redis.set(cache_key, response.content, ex=cache_ttl)
        if response.headers.get("content-type", "").startswith("application/json"):
            return response.json()
        return response.text

    # last-ditch: stale cache ----------------------------------------------
    if cache_key and (cached := await redis.get(cache_key)):
        return json.loads(cached)

    raise HTTPException(status_code=response.status_code, detail="Unable to reach frame")


async def _remote_file_md5(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
) -> Tuple[str, bool]:
    """
    Return (md5, exists). Prefer the websocket agent, fall back to SSH.
    """
    if await _use_agent(frame, redis):
        resp = await file_md5_on_frame(frame.id, remote_path)
        return resp.get("md5", ""), bool(resp.get("exists", False))

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        md5_out: list[str] = []
        await exec_command(
            db,
            redis,
            frame,
            ssh,
            f"md5sum {shlex.quote(remote_path)}",
            output=md5_out,
            log_output=False,
        )
        txt = "".join(md5_out).strip()
        if not txt:
            return "", False
        return txt.split()[0], True
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def _remote_download_file(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
) -> bytes:
    """
    Download *remote_path* – agent first, SSH SCP otherwise.
    """
    if await _use_agent(frame, redis):
        return await file_read_on_frame(frame.id, remote_path)

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        with NamedTemporaryFile(delete=False) as tmp:
            tmp_name = tmp.name
        await asyncssh.scp((ssh, shlex.quote(remote_path)), tmp_name, recurse=False)
        with open(tmp_name, "rb") as fh:
            data = fh.read()
        os.remove(tmp_name)
        return data
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)

# ---------------------------------------------------------------------------
#   📡  Endpoints
# ---------------------------------------------------------------------------

@api_with_auth.get("/frames", response_model=FramesListResponse)
async def api_frames_list(db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frames = db.query(Frame).all()
    return {
        "frames": [
            {
                **f.to_dict(),
                "active_connections": await number_of_connections_for_frame(redis, f.id),
            }
            for f in frames
        ]
    }


@api_with_auth.get("/frames/{id:int}/state", response_model=FrameStateResponse)
async def api_frame_get_state(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id) or _not_found()
    state = await _forward_frame_request(
        frame,
        redis,
        path="/state",
        cache_key=f"frame:{frame.frame_host}:{frame.frame_port}:state",
    )
    if isinstance(state, dict) and state.get("sceneId"):
        await redis.set(f"frame:{frame.id}:active_scene", state["sceneId"])
    return state


@api_with_auth.get("/frames/{id:int}/states", response_model=FrameStateResponse)
async def api_frame_get_states(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id) or _not_found()
    states = await _forward_frame_request(
        frame,
        redis,
        path="/states",
        cache_key=f"frame:{frame.frame_host}:{frame.frame_port}:states",
    )
    if isinstance(states, dict) and states.get("sceneId"):
        await redis.set(f"frame:{frame.id}:active_scene", states["sceneId"])
    return states


@api_with_auth.post("/frames/{id:int}/event/{event}")
async def api_frame_event(id: int, event: str, request: Request, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    frame = db.get(Frame, id) or _not_found()
    body = await (
        request.json() if request.headers.get("content-type") == "application/json" else request.body()
    )
    await _forward_frame_request(frame, redis, path=f"/event/{event}", method="POST", json_body=body)
    return "OK"



@api_with_auth.get("/frames/{id:int}/asset")
async def api_frame_get_asset(
    id: int,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    assets_path = frame.assets_path or "/srv/assets"
    rel_path    = request.query_params.get("path") or _bad_request("Path parameter is required")
    mode        = request.query_params.get("mode", "download")
    filename    = request.query_params.get("filename", os.path.basename(rel_path))

    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    if not full_path.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    if await _use_agent(frame, redis):
        try:
            data = await file_read_on_frame(frame.id, full_path)
        except Exception:  # file_read returns RuntimeError on missing file
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")

        md5 = hashlib.md5(data).hexdigest()
        cache_key = f"asset:{md5}"
        await redis.set(cache_key, data, ex=86400 * 30)

    else:
        md5, exists = await _remote_file_md5(db, redis, frame, full_path)
        if not exists:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Asset not found")

        cache_key = f"asset:{md5}"
        if cached := await redis.get(cache_key):
            data = cached
        else:
            data = await _remote_download_file(db, redis, frame, full_path)
            await redis.set(cache_key, data, ex=86400 * 30)

    return StreamingResponse(
        io.BytesIO(data),
        media_type="image/png" if mode == "image" else "application/octet-stream",
        headers={
            "Content-Disposition": f"{'attachment' if mode == 'download' else 'inline'}; filename={filename}",
        },
    )


@api_with_auth.get("/frames/{id:int}", response_model=FrameResponse)
async def api_frame_get(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    data = frame.to_dict()
    active = await redis.get(f"frame:{frame.id}:active_connections")
    data["active_connections"] = int(active or 0)
    return {"frame": data}


@api_with_auth.get("/frames/{id:int}/logs", response_model=FrameLogsResponse)
async def api_frame_get_logs(id: int, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    logs = [ll.to_dict() for ll in frame.logs][-1000:]
    return {"logs": logs}


@api_with_auth.get("/frames/{id:int}/image_token", response_model=FrameImageLinkResponse)
async def get_image_token(id: int):
    expire_minutes = 5
    now    = datetime.utcnow()
    expire = now + timedelta(minutes=expire_minutes)
    to_encode = {"sub": f"frame={id}", "exp": expire}
    token     = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return {"token": token, "expires_in": int((expire - now).total_seconds())}


@api_no_auth.get("/frames/{id:int}/image")
async def api_frame_get_image(
    id: int,
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if config.HASSIO_RUN_MODE != 'ingress':
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
    if frame.frame_access not in ["public", "protected"] and frame.frame_access_key:
        url += "?k=" + frame.frame_access_key

    if request.query_params.get('t') == '-1':
        last_image = await redis.get(cache_key)
        if last_image:
            return Response(content=last_image, media_type='image/png')

    # Use shared semaphore and client
    try:
        async with request.app.state.http_semaphore:
            response = await request.app.state.http_client.get(url, timeout=10.0)

        if response.status_code == 200:
            await redis.set(cache_key, response.content, ex=86400 * 30)
            scene_id = response.headers.get('x-scene-id')
            if not scene_id:
                scene_id = await redis.get(f"frame:{id}:active_scene")
                if scene_id:
                    scene_id = scene_id.decode('utf-8')
            if scene_id:
                # dimensions (best‑effort – don’t crash if Pillow missing)
                width = height = None
                try:
                    from PIL import Image
                    import io
                    img = Image.open(io.BytesIO(response.content))
                    width, height = img.width, img.height
                except Exception:
                    pass

                # upsert into SceneImage
                from app.models.scene_image import SceneImage
                from app.api.scene_images import _generate_thumbnail
                now = datetime.utcnow()
                img_row = (
                    db.query(SceneImage)
                      .filter_by(frame_id=id, scene_id=scene_id)
                      .first()
                )
                thumb, t_width, t_height = _generate_thumbnail(response.content)
                if img_row:
                    img_row.image      = response.content
                    img_row.timestamp  = now
                    img_row.width      = width
                    img_row.height     = height
                    img_row.thumb_image = thumb
                    img_row.thumb_width = t_width
                    img_row.thumb_height = t_height
                else:
                    img_row = SceneImage(
                        frame_id    = id,
                        scene_id    = scene_id,
                        image       = response.content,
                        timestamp   = now,
                        width       = width,
                        height      = height,
                        thumb_image = thumb,
                        thumb_width = t_width,
                        thumb_height = t_height
                    )
                    db.add(img_row)
                db.commit()

            await publish_message(redis, "new_scene_image", {"frameId": id, "sceneId": scene_id, "timestamp": now.isoformat(), "width": width, "height": height})

            return Response(content=response.content, media_type='image/png')
        else:
            raise HTTPException(status_code=response.status_code, detail="Unable to fetch image")

    except httpx.ReadTimeout:
        raise HTTPException(status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Request Timeout to {url}")
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
    # 1) prefer the WebSocket agent
    if await _use_agent(frame, redis):
        assets = await assets_list_on_frame(frame.id, assets_path)
        assets.sort(key=lambda a: a["path"])
        return {"assets": assets}

    # 2) legacy SSH fall-back (unchanged)
    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"find {assets_path} -type f -exec stat --format='%s %Y %n' {{}} +"
        output: list[str] = []
        await exec_command(db, redis, frame, ssh, cmd, output, log_output=False)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)

    assets = [
        {"path": p.strip(), "size": int(s), "mtime": int(m)}
        for line in output if (parts := line.split(" ", 2)) and len(parts) == 3
        for s, m, p in [parts]
    ]
    assets.sort(key=lambda a: a["path"])
    return {"assets": assets}

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
    frame = db.get(Frame, id) or _not_found()
    if not path:
        _bad_request("Path parameter is required")
    if "*" in path:
        _bad_request("Invalid character * in path")

    assets_path = frame.assets_path or "/srv/assets"
    combined_path = os.path.normpath(os.path.join(assets_path, path, file.filename or "uploaded_file"))
    if not combined_path.startswith(os.path.normpath(assets_path) + '/'):
        _bad_request("Invalid asset path")

    contents = await file.read()

    # ---------- 1) try agent upload ---------------------------------------
    if (await _use_agent(frame, redis)):
        await log(db, redis, id, "stdout", f"Agent upload: {combined_path}")
        await file_write_on_frame(frame.id, combined_path, base64.b64encode(contents).decode())
        path_relative = os.path.relpath(combined_path, assets_path)
        return {"path": path_relative, "size": len(contents), "mtime": int(datetime.now().timestamp())}

    # ---------- 2) SSH fallback -------------------------------------------
    ssh = await get_ssh_connection(db, redis, frame)
    try:
        with NamedTemporaryFile(delete=True) as temp_file:
            local_temp_path = temp_file.name
            with open(local_temp_path, "wb") as f:
                f.write(contents)
            await log(db, redis, id, "stdout", f"SCP upload: {combined_path}")
            scp_escaped_path = shlex.quote(combined_path)
            await asyncssh.scp(
                local_temp_path,
                (ssh, scp_escaped_path),
                recurse=False
            )
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)

    path_relative = os.path.relpath(combined_path, assets_path)
    return {"path": path_relative, "size": len(contents), "mtime": int(datetime.now().timestamp())}

@api_with_auth.post("/frames/{id:int}/clear_build_cache")
async def api_frame_clear_build_cache(id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    if await _use_agent(frame, redis):
        try:
            await exec_shell_on_frame(
                frame.id,
                "rm -rf /srv/frameos/build/cache && echo DONE"
            )
            return {"message": "Build cache cleared successfully"}
        except Exception as e:
            raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

    try:
        ssh = await get_ssh_connection(db, redis, frame)
        try:
            command = "rm -rf /srv/frameos/build/cache && echo 'Build cache cleared'"
            await exec_command(db, redis, frame, ssh, command)
        finally:
            await remove_ssh_connection(db, redis, ssh, frame)
        return {"message": "Build cache cleared successfully"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

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

@api_with_auth.post("/frames/{id:int}/reboot")
async def api_frame_reboot_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import reboot_frame
        await reboot_frame(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

@api_with_auth.post("/frames/{id:int}/deploy_agent")
async def api_frame_deploy_agent_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import deploy_agent
        await deploy_agent(id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

@api_with_auth.post("/frames/{id:int}/restart_agent")
async def api_frame_restart_agent_event(id: int, redis: Redis = Depends(get_redis)):
    try:
        from app.tasks import restart_agent
        await restart_agent(id, redis)
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
    elif data.next_action == 'reboot':
        from app.tasks import reboot_frame
        await reboot_frame(id, redis)
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
