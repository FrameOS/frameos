from __future__ import annotations

# stdlib ---------------------------------------------------------------------
import asyncio
from datetime import datetime
from http import HTTPStatus
import contextlib
import aiofiles
import asyncssh
import hashlib
import io
import json
import mimetypes
import os
import re
import shlex
import shutil
import sys
import tempfile
import time
import zipfile
from tempfile import NamedTemporaryFile
from typing import Any, Optional, Tuple
from urllib.parse import quote

# third-party ---------------------------------------------------------------
import httpx
from fastapi import Depends, File, Form, HTTPException, Header, Query, Request, UploadFile
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
from app.utils.image import render_line_of_text_png
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
    FramePingResponse,
    FrameSSHKeysUpdateRequest,
)
from app.api.auth import get_current_user
from app.config import config
from app.utils.network import is_safe_host
from app.utils.remote_exec import (
    upload_file,
    delete_path,
    rename_path,
    make_dir,
    _use_agent,
)
from app.utils.frame_http import (
    _build_frame_path,
    _build_frame_url,
    _auth_headers,
    _fetch_frame_http_bytes,
)
from app.tasks.utils import find_nim_v2
from app.tasks.deploy_frame import FrameDeployer
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
from app.models.assets import copy_custom_fonts_to_local_source_folder
from app.models.settings import get_settings_dict
from app.utils.ssh_key_utils import default_ssh_key_ids
from app.utils.ssh_authorized_keys import _install_authorized_keys, resolve_authorized_keys_update
from app.tasks.binary_builder import FrameBinaryBuilder
from app.utils.local_exec import exec_local_command
from app.utils.jwt_tokens import create_scoped_token_response, validate_scoped_token
from . import api_with_auth, api_no_auth


def _not_found():
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _bad_request(msg: str):
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=msg)


_ascii_re = re.compile(r"[^A-Za-z0-9._-]")


def _normalize_upload_scene_payload(body: Any) -> tuple[list[dict[str, Any]], Any]:
    if isinstance(body, (bytes, bytearray)):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            _bad_request("uploadScene payload must be valid JSON")

    if isinstance(body, dict) and isinstance(body.get("scenes"), list):
        scenes = body["scenes"]
        return scenes, body["scenes"]
    if isinstance(body, list):
        return body, body
    if isinstance(body, dict):
        return [body], body

    _bad_request("uploadScene payload must be a scene or list of scenes")
    return [], body  # for mypy


def _validate_upload_scene_payload(scenes: list[dict[str, Any]]) -> None:
    if not scenes:
        _bad_request("uploadScene payload must include at least one scene")

    scene_ids: set[str] = set()
    for scene in scenes:
        if not isinstance(scene, dict):
            _bad_request("uploadScene scenes must be objects")
        scene_id = scene.get("id")
        if not isinstance(scene_id, str) or not scene_id:
            _bad_request("uploadScene scenes must include an id")
        scene_ids.add(scene_id)

    for scene in scenes:
        nodes = scene.get("nodes") or []
        if not isinstance(nodes, list):
            _bad_request(f"Scene '{scene.get('id')}' has invalid nodes list")
        for node in nodes:
            if not isinstance(node, dict):
                _bad_request(f"Scene '{scene.get('id')}' has invalid node entry")
            node_type = node.get("type")
            data = node.get("data") or {}
            if not isinstance(data, dict):
                _bad_request(f"Scene '{scene.get('id')}' has invalid node data")
            if node_type == "scene":
                keyword = data.get("keyword")
                if not isinstance(keyword, str) or not keyword:
                    _bad_request(f"Scene '{scene.get('id')}' has invalid scene reference")
                if keyword not in scene_ids:
                    _bad_request(f"Scene '{scene.get('id')}' references missing scene '{keyword}'")
            elif node_type == "dispatch" and data.get("keyword") == "setCurrentScene":
                config = data.get("config") or {}
                if not isinstance(config, dict):
                    _bad_request(f"Scene '{scene.get('id')}' has invalid dispatch config")
                target_scene_id = config.get("sceneId")
                if isinstance(target_scene_id, str) and target_scene_id and target_scene_id not in scene_ids:
                    _bad_request(
                        f"Scene '{scene.get('id')}' references missing scene '{target_scene_id}'"
                    )


def _ascii_safe(name: str) -> str:
    """Return a stripped ASCII fallback (for very old clients)."""
    return _ascii_re.sub("_", name)[:150] or "download"


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


def _decode_bytes(data: bytes) -> str:
    try:
        return data.decode()
    except Exception:
        return data.decode("latin1", errors="replace")


def _truncate_text(msg: str, limit: int = 400) -> str:
    msg = msg.strip()
    if len(msg) > limit:
        msg = msg[: limit - 3].rstrip() + "..."
    return msg


def _format_body_preview(body: bytes) -> str:
    if not body:
        return ""
    return _truncate_text(_decode_bytes(body))




async def _icmp_ping_host(host: str, *, timeout: float = 2.0) -> tuple[bool, float | None, str]:
    if not shutil.which("ping"):
        return False, None, "ping command not available on server"

    started = time.perf_counter()
    timeout_arg = str(int(timeout * 1000)) if sys.platform == "darwin" else str(int(timeout))
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping",
            "-c",
            "1",
            "-W",
            timeout_arg,
            host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return False, None, "ping command not available on server"

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout + 1.0)
    except asyncio.TimeoutError:
        proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        return False, None, f"Timeout after {timeout:.1f}s"

    elapsed_ms = (time.perf_counter() - started) * 1000
    if proc.returncode == 0:
        message = _decode_bytes(stdout or b"") or f"Reply from {host}"
        return True, elapsed_ms, _truncate_text(message)

    message = _decode_bytes(stderr or stdout or b"") or f"Unable to reach {host}"
    return False, elapsed_ms, _truncate_text(message)


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
        response = await exec_command(
            db,
            redis,
            frame,
            ssh,
            f"md5sum {shlex.quote(remote_path)}",
            output=md5_out,
            log_output=False,
            raise_on_error=False,
        )
        if response != 0:
            return "", False
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


@api_with_auth.get("/frames/{id:int}/ping", response_model=FramePingResponse)
async def api_frame_ping(
    id: int,
    mode: str = Query("icmp"),
    path: str | None = Query(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    mode_normalised = (mode or "").strip().lower()
    if mode_normalised not in {"icmp", "http"}:
        _bad_request("Ping mode must be 'icmp' or 'http'")

    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    if mode_normalised == "icmp":
        ok, elapsed_ms, message = await _icmp_ping_host(frame.frame_host)
        return FramePingResponse(
            ok=ok,
            mode="icmp",
            target=frame.frame_host,
            elapsed_ms=elapsed_ms,
            status=None,
            message=message,
        )

    ping_path = (path or "/ping").strip() or "/ping"
    if not ping_path.startswith("/"):
        ping_path = f"/{ping_path}"
    if len(ping_path) > 512:
        _bad_request("Ping path is too long")

    scheme = "https" if frame.frame_port % 1000 == 443 else "http"
    display_target = f"{scheme}://{frame.frame_host}:{frame.frame_port}{ping_path}"
    started = time.perf_counter()

    try:
        status, body, _hdrs = await _fetch_frame_http_bytes(
            frame, redis, path=ping_path, method="GET"
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        message = _format_body_preview(body) or f"HTTP {status}"
        return FramePingResponse(
            ok=200 <= status < 400,
            mode="http",
            target=display_target,
            elapsed_ms=elapsed_ms,
            status=status,
            message=message,
        )
    except HTTPException as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return FramePingResponse(
            ok=False,
            mode="http",
            target=display_target,
            elapsed_ms=elapsed_ms,
            status=None,
            message=_truncate_text(detail),
        )
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        return FramePingResponse(
            ok=False,
            mode="http",
            target=display_target,
            elapsed_ms=elapsed_ms,
            status=None,
            message=_truncate_text(str(exc)),
        )


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
    if event == "uploadScene":
        scenes, body = _normalize_upload_scene_payload(body)
        _validate_upload_scene_payload(scenes)
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
        source_dir = deployer.create_local_source_folder(tmp)

        # Apply all frame‑specific code generation (scenes, drivers, …)
        await deployer.make_local_modifications(source_dir)
        await copy_custom_fonts_to_local_source_folder(db, source_dir)

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


@api_with_auth.post("/frames/{id:int}/download_c_source_zip")
async def api_frame_local_c_source_zip(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    try:
        nim_path = find_nim_v2()
    except Exception as exc:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Unable to locate Nim installation: {exc}",
        )

    with tempfile.TemporaryDirectory() as tmp:
        deployer = FrameDeployer(db, redis, frame, nim_path, tmp)

        try:
            arch = await deployer.get_cpu_architecture()
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.BAD_GATEWAY,
                detail=f"Unable to detect frame architecture: {exc}",
            )

        source_dir = deployer.create_local_source_folder(tmp)
        await deployer.make_local_modifications(source_dir)
        await copy_custom_fonts_to_local_source_folder(db, source_dir)

        build_dir = os.path.join(tmp, f"build_{deployer.build_id}")
        os.makedirs(build_dir, exist_ok=True)
        await deployer.create_local_build_archive(build_dir, source_dir, arch)

        zip_path = os.path.join(tmp, f"frameos_{deployer.build_id}_c_source.zip")
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            strict_timestamps=False,
        ) as zf:
            for root, _dirs, files in os.walk(build_dir):
                for file in files:
                    full = os.path.join(root, file)
                    arc = os.path.relpath(full, build_dir)
                    zf.write(full, arc)

        async with aiofiles.open(zip_path, "rb") as fh:
            zip_bytes = await fh.read()

    async def sender():
        yield zip_bytes

    safe_name = (frame.name or "frame").replace(" ", "_").replace("/", "_")
    filename = f"{safe_name}_{deployer.build_id}_c_source.zip"
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{_ascii_safe(filename)}"'
        )
    }
    return StreamingResponse(sender(), headers=headers, media_type="application/zip")


@api_with_auth.post("/frames/{id:int}/download_binary_zip")
async def api_frame_local_binary_zip(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id) or _not_found()

    try:
        # Ensure Nim is available before attempting to build
        nim_path = find_nim_v2()
    except Exception as exc:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Unable to locate Nim installation: {exc}",
        )

    with tempfile.TemporaryDirectory() as tmp:
        deployer = FrameDeployer(db, redis, frame, nim_path, tmp)
        builder = FrameBinaryBuilder(db=db, redis=redis, frame=frame, deployer=deployer, temp_dir=tmp)

        try:
            build_result = await builder.build(force_cross_compile=True)
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"Failed to build FrameOS binary: {exc}",
            ) from exc

        binary_path = build_result.binary_path
        if not binary_path:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail="Cross compilation completed without producing a binary",
            )

        dist_dir = os.path.join(tmp, "dist")
        os.makedirs(dist_dir, exist_ok=True)
        bin_dir = os.path.join(dist_dir, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        shutil.copy2(binary_path, os.path.join(bin_dir, "frameos"))

        zip_path = os.path.join(tmp, f"frameos_{deployer.build_id}_binary.zip")
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            strict_timestamps=False,
        ) as zf:
            for root, _dirs, files in os.walk(dist_dir):
                for file in files:
                    full = os.path.join(root, file)
                    relative = os.path.relpath(full, dist_dir)
                    arc = os.path.join("dist", relative)
                    zf.write(full, arc)

        async with aiofiles.open(zip_path, "rb") as fh:
            zip_bytes = await fh.read()

    async def sender():
        yield zip_bytes

    safe_name = (frame.name or "frame").replace(" ", "_").replace("/", "_")
    filename = f"{safe_name}_{deployer.build_id}_binary.zip"
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{_ascii_safe(filename)}"'
        )
    }
    return StreamingResponse(sender(), headers=headers, media_type="application/zip")


@api_no_auth.get("/frames/{id:int}/asset")
async def api_frame_get_asset(
    id: int,
    request: Request,
    token: str | None = None,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if config.HASSIO_RUN_MODE != "ingress":
        if authorization and authorization.startswith("Bearer "):
            try:
                await get_current_user(authorization.split(" ")[1], db)
            except HTTPException:
                raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
        elif token:
            validate_scoped_token(token, expected_subject=f"frame={id}")
        else:
            raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")

    frame = db.get(Frame, id) or _not_found()

    assets_path = frame.assets_path or "/srv/assets"
    rel_path = request.query_params.get("path") or _bad_request(
        "Path parameter is required",
    )
    mode = request.query_params.get("mode", "download")
    filename = request.query_params.get("filename", os.path.basename(rel_path))
    thumb = request.query_params.get("thumb") == "1"

    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    if not full_path.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    if thumb:
        if os.path.splitext(rel_path)[1].lower() not in {
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".bmp",
            ".webp",
        }:
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Not an image")

        md5_key = f"asset-md5:{full_path}"
        cached_md5 = await redis.get(md5_key)
        if cached_md5:
            full_md5 = cached_md5.decode() if isinstance(cached_md5, bytes) else cached_md5
        else:
            full_md5, exists = await _remote_file_md5(db, redis, frame, full_path)
            if not full_md5:
                _bad_request("Invalid asset path")
            await redis.set(md5_key, full_md5, ex=86400 * 30)

        cache_key = f"asset:thumb:{full_md5}"
        if cached := await redis.get(cache_key):
            data = cached
        else:
            thumb_root = os.path.join(assets_path, ".thumbs")
            thumb_rel = full_md5 + ".320x320.jpg"
            thumb_full = os.path.normpath(os.path.join(thumb_root, thumb_rel))

            try:
                data = await _remote_download_file(db, redis, frame, thumb_full)
                await redis.set(cache_key, data, ex=86400 * 30)
            except Exception:
                cmd = (
                    f"mkdir -p {shlex.quote(os.path.dirname(thumb_full))} && "
                    f"convert {shlex.quote(full_path)} -thumbnail 320x320 "
                    f"{shlex.quote(thumb_full)}"
                )
                await exec_shell_on_frame(frame.id, cmd)

                data = await _remote_download_file(db, redis, frame, thumb_full)
                await redis.set(cache_key, data, ex=86400 * 30)

        return StreamingResponse(io.BytesIO(data), media_type="image/jpeg")

    if await _use_agent(frame, redis):
        try:
            data = await file_read_on_frame(frame.id, full_path)
        except Exception:  # file_read returns RuntimeError on missing file
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="Asset not found",
            )

        md5 = hashlib.md5(data).hexdigest()
        cache_key = f"asset:{md5}"
        await redis.set(cache_key, data, ex=86400 * 30)

    else:
        md5, exists = await _remote_file_md5(db, redis, frame, full_path)
        if not exists:
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="Asset not found",
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
    return create_scoped_token_response(f"frame={id}")


@api_no_auth.get("/frames/{id:int}/image")
async def api_frame_get_image(
    id: int,
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    if config.HASSIO_RUN_MODE != "ingress":
        validate_scoped_token(token, expected_subject=f"frame={id}")

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
            # Fallback image: black background with big gray "no iamge" (single line, no wrapping)
            if not frame.width or not frame.height:
                frame.width = 800
                frame.height = 600

            width, height = int(frame.width), int(frame.height)
            body = render_line_of_text_png("no image", width, height)
            return Response(content=body, media_type="image/png")

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


@api_with_auth.post("/frames/{id:int}/nix_collect_garbage_frame")
async def api_frame_nix_collect_garbage_frame(
    id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)
):
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    if await _use_agent(frame, redis):
        try:
            await log( db, redis, id, "stdout", "> nix-collect-garbage")
            await exec_shell_on_frame(frame.id, "nix-collect-garbage")
            return {"message": "Garbage collected"}
        except Exception as e:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e)
            )
    try:
        ssh = await get_ssh_connection(db, redis, frame)
        try:
            await exec_command(db, redis, frame, ssh, "nix-collect-garbage")
        finally:
            await remove_ssh_connection(db, redis, ssh, frame)
        return {"message": "Garbage collected"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

@api_with_auth.post("/frames/{id:int}/nix_collect_garbage_backend")
async def api_frame_nix_collect_garbage_backend(
    id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)
):
    cmd = 'nix-collect-garbage'
    frame = db.get(Frame, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    await exec_local_command(db, redis, frame, cmd)
    return {"message": "Garbage collected"}


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
        base_name = frame.name or f"frame{frame.id}"
        sanitized = "".join(c if c.isalnum() or c in "-._" else "_" for c in base_name).strip("._-") or f"frame{frame.id}"
        suffix = "".join(img_path.suffixes) or img_path.suffix or ".img"
        filename = f"{sanitized}{suffix}"
        quoted_filename = quote(filename)

        mime, _ = mimetypes.guess_type(str(img_path))
        if not mime and img_path.suffixes:
            last_suffix = img_path.suffixes[-1]
            if last_suffix == ".zst":
                mime = "application/zstd"
            elif last_suffix == ".gz":
                mime = "application/gzip"
            elif last_suffix == ".xz":
                mime = "application/x-xz"
            elif last_suffix == ".zip":
                mime = "application/zip"

        headers = {
            "Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quoted_filename}",
            "Content-Length": str(img_path.stat().st_size),
        }
        return StreamingResponse(sender(), headers=headers, media_type=mime or "application/octet-stream")
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

    old_mode = data.mode
    for field, value in update_data.items():
        setattr(frame, field, value)

    if data.mode == "nixos" and old_mode == "rpios":
        if frame.ssh_user == "pi":
            frame.ssh_user = "frame"
    elif data.mode == "rpios" and old_mode == "nixos":
        if frame.ssh_user == "frame":
            frame.ssh_user = "pi"

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
    settings = get_settings_dict(db)
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

        frame.ssh_keys = default_ssh_key_ids(settings) or None

        frame.mode = data.mode
        if frame.mode == "nixos":
            frame.ssh_user = 'frame'
            frame.network = {} # mark as changed for the orm
            frame.network['wifiHotspot'] = 'bootOnly'
            frame.agent = {} # mark as changed for the orm
            frame.agent['agentEnabled'] = False
            frame.agent['agentRunCommands'] = True
            platform = data.platform or (frame.nix or {}).get('platform') or 'pi-zero2'
            if timezone := settings.get('defaults', {}).get('timezone'):
                frame.nix = {} # mark as changed for the orm
                frame.nix['timezone'] = timezone
            else:
                frame.nix = frame.nix or {}
            if wifi_ssid := settings.get('defaults', {}).get('wifiSSID'):
                frame.network['wifiSSID'] = wifi_ssid
            if wifi_password := settings.get('defaults', {}).get('wifiPassword'):
                frame.network['wifiPassword'] = wifi_password
            db.add(frame)
            db.commit()
            db.refresh(frame)
            frame.nix = { **frame.nix, 'hostname': f'frame{frame.id}', 'platform': platform }
            frame.frame_host = f'frame{frame.id}.local'
            db.add(frame)
            db.commit()
            db.refresh(frame)
        elif frame.mode == "buildroot":
            frame.ssh_user = 'root'
            selected_platform = (data.platform or (frame.buildroot or {}).get('platform') or '').strip()
            buildroot_settings = {**(frame.buildroot or {})}
            if selected_platform:
                buildroot_settings['platform'] = selected_platform
            else:
                buildroot_settings.pop('platform', None)
            frame.buildroot = buildroot_settings
            if not frame.frame_host:
                frame.frame_host = f'frame{frame.id}.local'
            db.add(frame)
            db.commit()
            db.refresh(frame)
        elif frame.mode == "rpios":
            rpios_settings = {**(frame.rpios or {})}
            rpios_settings["platform"] = data.platform or (frame.rpios or {}).get('platform') or ''
            frame.rpios = rpios_settings
            db.add(frame)
            db.commit()
            db.refresh(frame)

        return {"frame": frame.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_with_auth.post("/frames/{id:int}/ssh_keys")
async def api_frame_update_ssh_keys(
    id: int,
    data: FrameSSHKeysUpdateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = db.get(Frame, id)
    if not frame:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    settings = get_settings_dict(db)
    try:
        new_keys, public_keys, known_public_keys = resolve_authorized_keys_update(
            data.ssh_keys,
            frame.ssh_keys,
            settings,
        )
        await _install_authorized_keys(db, redis, frame, public_keys, known_public_keys)
    except ValueError as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc))
    frame.ssh_keys = new_keys
    await update_frame(db, redis, frame)

    return {"message": "SSH keys updated successfully"}


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
            data.get("frame_host"),
            data.get("server_host"),
            data.get("device"),
            data.get("interval"),
        )

        for key, value in data.items():
            if key in ["id", "name", "frame_host", "server_host", "device", "interval", "last_success"]:
                continue
            if hasattr(frame, key):
                if key in ["last_successful_deploy_at", "last_log_at"]:
                    value = datetime.fromisoformat(value) if isinstance(value, str) else value
                setattr(frame, key, value)

        await update_frame(db, redis, frame)
        db.refresh(frame)

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
