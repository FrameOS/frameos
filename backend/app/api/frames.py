from __future__ import annotations

# stdlib ---------------------------------------------------------------------
from datetime import datetime, timedelta
from http import HTTPStatus
import aiofiles
import asyncssh
import hashlib
import io
import json
import os
import re
import tempfile
import shlex
import zipfile
from tempfile import NamedTemporaryFile
from typing import Any, Optional, Tuple
from urllib.parse import quote

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
from app.utils.remote_exec import (
    upload_file,
    delete_path,
    rename_path,
    make_dir,
    _use_agent,
)
from app.tasks.utils import find_nim_v2
from app.tasks.deploy_frame import (
    FrameDeployer,
    create_build_folders,
    make_local_modifications,
)
from app.redis import get_redis
from app.websockets import publish_message
from app.ws.agent_ws import (
    http_get_on_frame,
    number_of_connections_for_frame,
    file_md5_on_frame,
    file_read_on_frame,
    assets_list_on_frame,
    exec_shell_on_frame,
)
from . import api_with_auth, api_no_auth


def _not_found():
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _bad_request(msg: str):
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=msg)


_ascii_re = re.compile(r"[^A-Za-z0-9._-]")


def _ascii_safe(name: str) -> str:
    """Return a stripped ASCII fallback (for very old clients)."""
    return _ascii_re.sub("_", name)[:150] or "download"


def _build_frame_path(
    frame: Frame,
    path: str,
    method: str = "GET",
) -> str:
    """
    Build the relative path used when talking to the device.

    * For **GET** we keep the historical `?k=` query parameter so the
      WebSocket agent (which cannot add headers) can authenticate.
    * For **POST** and every other verb we **omit** the query parameter
      – the plain-HTTP fallback is able to use the `Authorization`
      header instead.
    """
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    if (
        method == "GET"
        and frame.frame_access not in ("public", "protected")
        and frame.frame_access_key
    ):
        sep = "&" if "?" in path else "?"
        path = f"{path}{sep}k={frame.frame_access_key}"
    return path


def _build_frame_url(frame: Frame, path: str, method: str) -> str:
    """Return full http://host:port/… URL (adds access key when required)."""
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    scheme = "https" if frame.frame_port % 1000 == 443 else "http"
    url = f"{scheme}://{frame.frame_host}:{frame.frame_port}{_build_frame_path(frame, path, method)}"
    return url


def _auth_headers(
    frame: Frame, hdrs: Optional[dict[str, str]] = None
) -> dict[str, str]:
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


def _bytes_or_json(blob: bytes | str):
    """
    • If *blob* is str → return it as-is (already JSON-decoded upstream).
    • If bytes → try UTF-8 → json.loads() → dict.
      - valid JSON  → dict/list/…           (good for /state, /states)
      - invalid JSON → leave as raw bytes   (needed for /image etc.)
    """
    if isinstance(blob, (bytes, bytearray)):
        try:
            return json.loads(blob.decode())  # UTF-8 is the JSON default
        except Exception:
            return blob  # truly binary
    return blob


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
    if cache_key and (cached := await redis.get(cache_key)):
        return _bytes_or_json(cached)

    # The agent HTTP command wants a *string* while httpx needs either
    #   • json=<obj>   for real JSON payloads
    #   • content=<bytes> for arbitrary binary bodies.
    body_for_agent: str | None = None
    if json_body is not None:
        if isinstance(json_body, (bytes, bytearray)):
            # keep the bytes unchanged – use latin-1 for a 1-to-1 mapping
            body_for_agent = json_body.decode("latin1")
        else:
            body_for_agent = json.dumps(json_body)

    if await _use_agent(frame, redis):
        agent_resp = await http_get_on_frame(
            frame.id,
            _build_frame_path(frame, path, method),
            method=method.upper(),
            body=body_for_agent,
            headers=_auth_headers(frame),
        )
        status, payload = _normalise_agent_response(agent_resp)
        if status == 200:
            if cache_key:
                if isinstance(payload, (bytes, bytearray)):
                    await redis.set(cache_key, payload, ex=cache_ttl)
                else:
                    try:
                        await redis.set(
                            cache_key, json.dumps(payload).encode(), ex=cache_ttl
                        )
                    except TypeError:
                        pass
            return payload

        raise HTTPException(status_code=400, detail=f"Agent error: {status} {payload}")

    url = _build_frame_url(frame, path, method)
    hdrs = _auth_headers(frame)
    async with httpx.AsyncClient() as client:
        try:
            if isinstance(json_body, (bytes, bytearray)):
                # binary/event bodies
                response = await client.request(
                    method,
                    url,
                    content=json_body,
                    headers=hdrs,
                    timeout=60.0,
                )
            elif json_body is not None:
                # normal JSON payload
                response = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=hdrs,
                    timeout=60.0,
                )
            else:
                # no body at all
                response = await client.request(
                    method,
                    url,
                    headers=hdrs,
                    timeout=60.0,
                )
        except httpx.ReadTimeout:
            raise HTTPException(
                status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Timeout to {url}"
            )
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc)
            )

    if response.status_code == 200:
        if cache_key:
            await redis.set(cache_key, response.content, ex=cache_ttl)
        if response.headers.get("content-type", "").startswith("application/json"):
            return response.json()
        return response.text

    # last-ditch: serve stale cache (JSON or bytes) ------------------------
    if cache_key and (cached := await redis.get(cache_key)):
        return _bytes_or_json(cached)

    raise HTTPException(
        status_code=400, detail="Unable to reach frame"
    )


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


async def _fetch_frame_http_bytes(
    frame: Frame,
    redis: Redis,
    *,
    path: str,
    method: str = "GET",
) -> tuple[int, bytes, dict[str, str]]:
    """Fetch *path* from the frame returning (status, body-bytes, headers)."""

    if await _use_agent(frame, redis):
        resp = await http_get_on_frame(frame.id, _build_frame_path(frame, path, method))
        if isinstance(resp, dict):
            status = int(resp.get("status", 0))
            if resp.get("binary"):
                body = resp.get("body", b"")  # already bytes
            else:
                raw = resp.get("body", "")
                body = raw.encode("latin1") if isinstance(raw, str) else raw
            hdrs = {
                str(k).lower(): str(v) for k, v in (resp.get("headers") or {}).items()
            }
            return status, body, hdrs
        else:
            raise HTTPException(status_code=500, detail="Bad agent response")

    url = _build_frame_url(frame, path, method)
    hdrs = _auth_headers(frame)
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=hdrs, timeout=60.0)
        except httpx.ReadTimeout:
            raise HTTPException(
                status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Timeout to {url}"
            )
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc)
            )

    return response.status_code, response.content, dict(response.headers)


# ---------------------------------------------------------------------------
#   📡  Endpoints
# ---------------------------------------------------------------------------


@api_with_auth.get("/frames", response_model=FramesListResponse)
async def api_frames_list(
    db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frames = db.query(Frame).all()
    return {
        "frames": [
            {
                **f.to_dict(),
                "active_connections": await number_of_connections_for_frame(
                    redis, f.id
                ),
            }
            for f in frames
        ]
    }


@api_with_auth.get("/frames/{id:int}/state", response_model=FrameStateResponse)
async def api_frame_get_state(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
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
async def api_frame_get_states(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
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
async def api_frame_event(
    id: int,
    event: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()
    body = await (
        request.json()
        if request.headers.get("content-type") == "application/json"
        else request.body()
    )
    try:
        await _forward_frame_request(
            frame, redis, path=f"/event/{event}", method="POST", json_body=body
        )
        return "OK"
    except HTTPException as exc:
        await log(
            db, redis, id, "stderr", f"Error on frame event {event}: {exc.detail}"
        )
        raise exc
    except RuntimeError as exc:
        await log(db, redis, id, "stderr", f"Error on frame event {event}: {str(exc)}")
        raise exc


@api_with_auth.post("/frames/{id:int}/download_build_zip")
async def api_frame_local_build_zip(                 # noqa: D401
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """
    Return a **zip archive** containing the locally‑generated sources
    produced by ``make_local_modifications`` for this frame.

    The archive includes:
    * every scene/app file produced for the frame
    * the generated ``drivers.nim`` / ``waveshare`` driver (if any)
    * a ready‑to‑compile C/Makefile tree (no heavy cross‑build step)
    """
    frame = db.get(Frame, id) or _not_found()

    # Locate Nim (needed only for path checks inside helpers)
    try:
        nim_path = find_nim_v2()
    except Exception as exc:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Unable to locate Nim installation: {exc}",
        )

    # Workspace ────────────────────────────────────────────────────────────
    with tempfile.TemporaryDirectory() as tmp:
        deployer = FrameDeployer(db, redis, frame, nim_path, tmp)
        build_dir, source_dir = create_build_folders(tmp, deployer.build_id)

        # Apply all frame‑specific code generation (scenes, drivers, …)
        await make_local_modifications(deployer, source_dir)

        # Package → .zip
        zip_path = os.path.join(tmp, f"frameos_{deployer.build_id}.zip")
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            strict_timestamps=False,   # 🚩 allow < 1980 timestamps
        ) as zf:
            for root, _dirs, files in os.walk(source_dir):
                for file in files:
                    full = os.path.join(root, file)
                    arc  = os.path.relpath(full, source_dir)
                    zf.write(full, arc)

        # --- read once *before* tmp dir vanishes ---------------------------
        async with aiofiles.open(zip_path, "rb") as fh:
            zip_bytes = await fh.read()

        async def sender():
            # stream from an in‑memory view – no filesystem dependency
            yield zip_bytes

        safe_name = (frame.name or "frame").replace(" ", "_").replace("/", "_")
        filename  = f"{safe_name}_{deployer.build_id}.zip"
        headers   = {
            "Content-Disposition": (
                f'attachment; filename="{_ascii_safe(filename)}"'
            )
        }
        return StreamingResponse(sender(), headers=headers, media_type="application/zip")


@api_with_auth.get("/frames/{id:int}/asset")
async def api_frame_get_asset(
    id: int,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    assets_path = frame.assets_path or "/srv/assets"
    rel_path = request.query_params.get("path") or _bad_request(
        "Path parameter is required"
    )
    mode = request.query_params.get("mode", "download")
    filename = request.query_params.get("filename", os.path.basename(rel_path))

    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    if not full_path.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    if await _use_agent(frame, redis):
        try:
            data = await file_read_on_frame(frame.id, full_path)
        except Exception:  # file_read returns RuntimeError on missing file
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="Asset not found"
            )

        md5 = hashlib.md5(data).hexdigest()
        cache_key = f"asset:{md5}"
        await redis.set(cache_key, data, ex=86400 * 30)

    else:
        md5, exists = await _remote_file_md5(db, redis, frame, full_path)
        if not exists:
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="Asset not found"
            )

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
            "Content-Disposition": (
                f"{'attachment' if mode == 'download' else 'inline'}; "
                f'filename="{_ascii_safe(filename)}"; '
                f"filename*=UTF-8''{quote(filename, safe='')}"
            ),
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


@api_with_auth.get(
    "/frames/{id:int}/image_token", response_model=FrameImageLinkResponse
)
async def get_image_token(id: int):
    expire_minutes = 5
    now = datetime.utcnow()
    expire = now + timedelta(minutes=expire_minutes)
    to_encode = {"sub": f"frame={id}", "exp": expire}
    token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return {"token": token, "expires_in": int((expire - now).total_seconds())}


@api_no_auth.get("/frames/{id:int}/image")
async def api_frame_get_image(
    id: int,
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if config.HASSIO_RUN_MODE != "ingress":
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("sub") != f"frame={id}":
                raise HTTPException(status_code=401, detail="Unauthorized")
        except JWTError:
            raise HTTPException(status_code=401, detail="Unauthorized")

    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    cache_key = f"frame:{frame.frame_host}:{frame.frame_port}:image"
    path = "/image"

    if request.query_params.get("t") == "-1":
        last_image = await redis.get(cache_key)
        if last_image:
            return Response(content=last_image, media_type="image/png")
        else:
            # When asking for the cached image, raise instead of trying to fetch a real one
            # Somehow we get stuck when trying to fetch a lot of new images.
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="No cached image available"
            )

    # Use shared semaphore and client
    status = 0
    body = b""
    try:
        status, body, headers = await _fetch_frame_http_bytes(frame, redis, path=path)

        if status == 200:
            await redis.set(cache_key, body, ex=86400 * 30)
            scene_id = headers.get("x-scene-id")
            if not scene_id:
                encoded_scene_id = await redis.get(f"frame:{id}:active_scene")
                if encoded_scene_id:
                    scene_id = encoded_scene_id.decode("utf-8")
            if scene_id:
                # dimensions (best‑effort – don’t crash if Pillow missing)
                width = height = None
                try:
                    from PIL import Image
                    import io

                    img = Image.open(io.BytesIO(body))
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
                thumb, t_width, t_height = _generate_thumbnail(body)
                if img_row:
                    img_row.image = body
                    img_row.timestamp = now
                    img_row.width = width
                    img_row.height = height
                    img_row.thumb_image = thumb
                    img_row.thumb_width = t_width
                    img_row.thumb_height = t_height
                else:
                    img_row = SceneImage(
                        frame_id=id,
                        scene_id=scene_id,
                        image=body,
                        timestamp=now,
                        width=width,
                        height=height,
                        thumb_image=thumb,
                        thumb_width=t_width,
                        thumb_height=t_height,
                    )
                    db.add(img_row)
                db.commit()

            await publish_message(
                redis,
                "new_scene_image",
                {
                    "frameId": id,
                    "sceneId": scene_id,
                    "timestamp": now.isoformat(),
                    "width": width,
                    "height": height,
                },
            )

            return Response(content=body, media_type="image/png")
        else:
            await log(
                db,
                redis,
                id,
                "stderr",
                f"Error fetching image from frame {id}: {status} {body.decode(errors='ignore')}",
            )
            raise HTTPException(status_code=status, detail="Unable to fetch image")

    except httpx.ReadTimeout:
        await log(
            db,
            redis,
            id,
            "stderr",
            f"Error fetching image from frame {id}: request timeout",
        )
        raise HTTPException(
            status_code=HTTPStatus.REQUEST_TIMEOUT, detail="Request Timeout"
        )
    except Exception as e:
        await log(
            db, redis, id, "stderr", f"Error fetching image from frame {id}: {str(e)}"
        )
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.get("/frames/{id:int}/scene_source/{scene}")
async def api_frame_scene_source(id: int, scene: str, db: Session = Depends(get_db)):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    for scene_json in frame.scenes or []:
        if scene_json.get("id") == scene:
            return {"source": write_scene_nim(frame, scene_json)}
    raise HTTPException(
        status_code=HTTPStatus.NOT_FOUND, detail=f"Scene {scene} not found"
    )


@api_with_auth.get("/frames/{id:int}/assets", response_model=FrameAssetsResponse)
async def api_frame_get_assets(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    assets_path = frame.assets_path or "/srv/assets"

    if await _use_agent(frame, redis):
        assets = await assets_list_on_frame(frame.id, assets_path)
        assets.sort(key=lambda a: a["path"])
        return {"assets": assets}

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"find {shlex.quote(assets_path)} -exec stat --printf='%F|%s|%Y|%n\\n' {{}} +"
        output: list[str] = []
        await exec_command(db, redis, frame, ssh, cmd, output, log_output=False)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)

    assets = []
    for line in output:
        if not line:
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        ftype, s, m, p = parts
        if p.strip() != assets_path:
            assets.append({
                "path": p.strip(),
                "size": int(s),
                "mtime": int(m),
                "is_dir": ftype == "directory",
            })
    assets.sort(key=lambda a: a["path"])
    return {"assets": assets}


@api_with_auth.post("/frames/{id:int}/assets/sync")
async def api_frame_assets_sync(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    try:
        from app.models.assets import sync_assets

        await sync_assets(db, redis, frame)
        return {"message": "Assets synced successfully"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/assets/upload")
async def api_frame_assets_upload(
    id: int,
    path: Optional[str] = Form(
        None,
        description="Sub-folder inside the frame's assets directory (optional)",
    ),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    subdir = (path or "").lstrip("/")
    if "*" in subdir or ".." in subdir or os.path.isabs(subdir):
        _bad_request("Invalid character * in path")

    assets_path = frame.assets_path or "/srv/assets"
    combined_path = os.path.normpath(
        os.path.join(assets_path, subdir, file.filename or "uploaded_file")
    )
    if not combined_path.startswith(os.path.normpath(assets_path) + os.sep):
        _bad_request("Invalid asset path")

    data = await file.read()

    await upload_file(db, redis, frame, combined_path, data)

    rel = os.path.relpath(combined_path, assets_path)
    return {
        "path": rel,
        "size": len(data),
        "mtime": int(datetime.now().timestamp()),
        "is_dir": False,
    }


@api_with_auth.post("/frames/{id:int}/assets/mkdir")
async def api_frame_assets_mkdir(
    id: int,
    path: str = Form(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    rel_path = path.lstrip("/")
    if ".." in rel_path or "*" in rel_path or os.path.isabs(rel_path):
        _bad_request("Invalid asset path")

    assets_path = frame.assets_path or "/srv/assets"
    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    if not full_path.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    await make_dir(db, redis, frame, full_path)
    return {"message": "Created"}


@api_with_auth.post("/frames/{id:int}/assets/delete")
async def api_frame_assets_delete(
    id: int,
    path: str = Form(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    rel_path = path.lstrip("/")
    if ".." in rel_path or "*" in rel_path or os.path.isabs(rel_path):
        _bad_request("Invalid asset path")

    assets_path = frame.assets_path or "/srv/assets"
    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    if not full_path.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    await delete_path(db, redis, frame, full_path)
    return {"message": "Deleted"}


@api_with_auth.post("/frames/{id:int}/assets/rename")
async def api_frame_assets_rename(
    id: int,
    src: str = Form(...),
    dst: str = Form(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    s_rel = src.lstrip("/")
    d_rel = dst.lstrip("/")
    if any(x in s_rel for x in ["..", "*"]) or os.path.isabs(s_rel):
        _bad_request("Invalid source path")
    if any(x in d_rel for x in ["..", "*"]) or os.path.isabs(d_rel):
        _bad_request("Invalid destination path")

    assets_path = frame.assets_path or "/srv/assets"
    src_full = os.path.normpath(os.path.join(assets_path, s_rel))
    dst_full = os.path.normpath(os.path.join(assets_path, d_rel))
    if not src_full.startswith(
        os.path.normpath(assets_path)
    ) or not dst_full.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    await rename_path(db, redis, frame, src_full, dst_full)
    return {"message": "Renamed"}


@api_with_auth.post("/frames/{id:int}/clear_build_cache")
async def api_frame_clear_build_cache(
    id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)
):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    if await _use_agent(frame, redis):
        try:
            await log(
                db,
                redis,
                id,
                "stdout",
                "> rm -rf /srv/frameos/build/cache && echo DONE",
            )
            await exec_shell_on_frame(
                frame.id, "rm -rf /srv/frameos/build/cache && echo DONE"
            )
            return {"message": "Build cache cleared successfully"}
        except Exception as e:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e)
            )

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

@api_with_auth.post("/frames/{id:int}/build_sd_image")
async def api_frame_build_sd_image_event(id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    try:
        from app.tasks.build_sd_card_image import build_sd_card_image_task

        try:
            img_path = await build_sd_card_image_task({"db": db, "redis": redis}, id=id)
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc)
            )

        if not img_path.exists():
            raise HTTPException(status_code=500, detail="Image build failed")

        async def sender():
            try:
                async with aiofiles.open(img_path, "rb") as fh:
                    while chunk := await fh.read(64 << 14):   # 1 MiB chunks
                        yield chunk
            finally:
                # do not remove the file, as it won't rebuild next time
                pass

        frame = db.get(Frame, id)
        if not frame:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
        name = (frame.name or "Untitled Frame").replace(" ", "_").replace("/", "_")

        filename = f"{name}.img.zst"
        headers  = {
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
        return StreamingResponse(sender(), headers=headers, media_type="application/zstd")
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
    if isinstance(update_data.get("scenes"), str):
        try:
            update_data["scenes"] = json.loads(update_data["scenes"])
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=400, detail="Invalid input for scenes (must be JSON)"
            )

    for field, value in update_data.items():
        setattr(frame, field, value)

    await update_frame(db, redis, frame)

    if data.next_action == "restart":
        from app.tasks import restart_frame

        await restart_frame(id, redis)
    elif data.next_action == "reboot":
        from app.tasks import reboot_frame

        await reboot_frame(id, redis)
    elif data.next_action == "stop":
        from app.tasks import stop_frame

        await stop_frame(id, redis)
    elif data.next_action == "deploy":
        from app.tasks import deploy_frame

        await deploy_frame(id, redis)

    return {"message": "Frame updated successfully"}


@api_with_auth.post("/frames/new", response_model=FrameResponse)
async def api_frame_new(
    data: FrameCreateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    try:
        frame = await new_frame(
            db,
            redis,
            data.name,
            data.frame_host,
            data.server_host,
            data.device,
            data.interval,
        )
        return {"frame": frame.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/import", response_model=FrameResponse)
async def api_frame_import(
    request: Request,
    file: UploadFile = File(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Import a frame from a JSON body or uploaded file."""
    try:
        if file is not None:
            content = await file.read()
            data = json.loads(content)
        else:
            data = await request.json()
    except Exception:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid JSON")

    try:
        frame = await new_frame(
            db,
            redis,
            data.get("name"),
            data.get("frameHost") or data.get("frame_host"),
            data.get("serverHost") or data.get("server_host"),
            data.get("device"),
            data.get("interval") or data.get("metricsInterval"),
        )

        mapping = {
            "framePort": "frame_port",
            "frameAccessKey": "frame_access_key",
            "frameAccess": "frame_access",
            "sshUser": "ssh_user",
            "sshPass": "ssh_pass",
            "sshPort": "ssh_port",
            "serverPort": "server_port",
            "serverApiKey": "server_api_key",
            "width": "width",
            "height": "height",
            "color": "color",
            "metricsInterval": "metrics_interval",
            "debug": "debug",
            "scalingMode": "scaling_mode",
            "rotate": "rotate",
            "backgroundColor": "background_color",
            "interval": "interval",
            "logToFile": "log_to_file",
            "assetsPath": "assets_path",
            "saveAssets": "save_assets",
            "uploadFonts": "upload_fonts",
            "schedule": "schedule",
            "gpioButtons": "gpio_buttons",
            "controlCode": "control_code",
            "network": "network",
            "agent": "agent",
            "palette": "palette",
            "scenes": "scenes",
        }
        for src, dest in mapping.items():
            if data.get(src) is not None:
                setattr(frame, dest, data[src])

        await update_frame(db, redis, frame)
        return {"frame": frame.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.delete("/frames/{frame_id}")
async def api_frame_delete(
    frame_id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
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
                "id": metric.id,
                "timestamp": metric.timestamp.isoformat(),
                "frame_id": metric.frame_id,
                "metrics": metric.metrics,
            }
            for metric in metrics
        ]
        return {"metrics": metrics_list}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))
