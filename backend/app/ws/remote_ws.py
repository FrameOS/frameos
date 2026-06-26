from __future__ import annotations

import asyncio
import base64
import contextlib
import gzip
import hmac
import hashlib
import json
import secrets
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from starlette.websockets import WebSocketState
from arq import ArqRedis as Redis

# ── project locals ──────────────────────────────────────────────────────────
from app.database import SessionLocal
from app.redis import close_redis_connection, get_redis, create_redis_connection
from app.websockets import publish_message
from app.models.frame import Frame
from app.models.log import new_log as log
from app.utils.request_ip import extract_client_ip
from app.ws.remote_bridge import CMD_KEY, RESP_KEY, STREAM_KEY, send_cmd

router = APIRouter()

MAX_REMOTES = 1000        # simple DoS safeguard
CONN_TTL   = 60           # seconds – Redis key self-expiry
REMOTE_DISCONNECTED_ERROR = "remote websocket disconnected before command completed"

# frame_id → list[websocket] (only for UI statistics)
active_sockets_by_frame: dict[int, list[WebSocket]] = {}
active_sockets: set[WebSocket] = set()


async def write_log(redis: Redis, frame_id: int, type: str, line: str, ip: str | None = None):
    db = SessionLocal()
    try:
        await log(db, redis, frame_id, type, line, ip=ip)
    finally:
        db.close()


async def mark_sd_image_booted_if_needed(redis: Redis, frame_id: int) -> None:
    from app.tasks.buildroot_deploy_state import mark_buildroot_sd_image_booted

    db = SessionLocal()
    try:
        frame = db.get(Frame, frame_id)
        if frame is not None:
            await mark_buildroot_sd_image_booted(db, redis, frame)
    finally:
        db.close()


def remote_version_from_hello(hello_msg: dict[str, Any]) -> str | None:
    version = hello_msg.get("remoteVersion") or hello_msg.get("agentVersion")
    if isinstance(version, str) and version.strip():
        return version.strip()
    return None


def remote_capabilities_from_hello(hello_msg: dict[str, Any]) -> dict[str, bool] | None:
    capabilities = hello_msg.get("remoteCapabilities")
    if not isinstance(capabilities, dict):
        return None
    return {str(key): value for key, value in capabilities.items() if isinstance(value, bool)}


async def store_connected_remote_version(
    redis: Redis,
    frame: Frame,
    remote_version: str | None,
    remote_capabilities: dict[str, bool] | None = None,
) -> None:
    db = SessionLocal()
    try:
        stored_frame = db.get(Frame, frame.id)
        if stored_frame is None:
            return

        agent = dict(stored_frame.agent or {})
        if remote_version:
            agent["agentVersion"] = remote_version
        else:
            agent.pop("agentVersion", None)
        if remote_capabilities:
            agent["remoteCapabilities"] = remote_capabilities
        else:
            agent.pop("remoteCapabilities", None)

        if agent == (stored_frame.agent or {}):
            frame.agent = agent
            return

        stored_frame.agent = agent
        db.add(stored_frame)
        db.commit()
        frame.agent = agent
    finally:
        db.close()

    await publish_message(
        redis,
        "update_frame",
        {"agent": agent, "id": frame.id, "project_id": frame.project_id},
    )

# ────────────────────────────────────────────────────────────────────────────
# tiny helpers
# ────────────────────────────────────────────────────────────────────────────

def hmac_sha256(key: str, data: str) -> str:
    return hmac.new(key.encode(), data.encode(), hashlib.sha256).hexdigest()


def canonical_dumps(obj: Any) -> str:
    # 1. don’t escape printable Unicode – keep them exactly like Nim does
    s = json.dumps(obj, separators=(',', ':'), sort_keys=True, ensure_ascii=False)

    # 2. boostrap control-character escapes to Nim’s style
    #    (\u00xx → \u00XX, i.e. last two hex digits upper-case)
    return re.sub(
        r'\\u00([0-9a-f]{2})',
        lambda m: '\\u00' + m.group(1).upper(),
        s,
    )


def make_envelope(payload: dict, api_key: str, shared_secret: str) -> dict:
    nonce = int(time.time())
    body  = canonical_dumps(payload)
    mac   = hmac_sha256(shared_secret, f"{api_key}{nonce}{body}")
    return {
        "nonce":        nonce,
        "serverApiKey": api_key,
        "payload":      payload,
        "mac":          mac,
    }


async def number_of_connections_for_frame(redis: Redis, frame_id: int) -> int:
    cnt = 0
    async for _ in redis.scan_iter(match=f"frame:{frame_id}:conn:*"):
        cnt += 1
    return cnt


@asynccontextmanager
async def _redis_for_command(redis: Optional[Redis]):
    if redis is not None:
        yield redis
        return

    owned_redis = create_redis_connection()
    try:
        yield owned_redis
    finally:
        await close_redis_connection(owned_redis)

# ────────────────────────────────────────────────────────────────────────────
# high-level helper wrappers (they now proxy *only* via Redis)
# ────────────────────────────────────────────────────────────────────────────

async def http_get_on_frame(           # used by /frames/… endpoints
    frame_id: int,
    path: str,
    method: str = "GET",
    body: Any = None,
    headers: Dict[str, str] | None = None,
    timeout: int = 30,
    redis: Optional[Redis] = None,
):
    payload = {
        "type": "cmd",
        "name": "http",
        "args": {
            "method":  method,
            "path":    path,
            "body":    body,
            "headers": headers or {},
        },
    }
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, timeout=timeout)


async def assets_list_on_frame(frame_id: int, path: str, timeout: int = 60,
                               redis: Optional[Redis] = None):
    payload = {"type": "cmd", "name": "assets_list", "args": {"path": path}}
    async with _redis_for_command(redis) as command_redis:
        resp = await send_cmd(command_redis, frame_id, payload, timeout=timeout)
    if isinstance(resp, dict) and "assets" in resp:
        return resp["assets"]
    raise RuntimeError("bad response from remote assets_list")


async def exec_shell_on_frame(frame_id: int, cmd: str, timeout: int = 120,
                              redis: Optional[Redis] = None):
    payload = {"type": "cmd", "name": "shell", "args": {"cmd": cmd}}
    async with _redis_for_command(redis) as command_redis:
        reply = await send_cmd(command_redis, frame_id, payload, timeout=timeout)
    if isinstance(reply, dict) and reply.get("exit", 1) == 0:
        return
    raise RuntimeError(f"shell failed: {reply}")


async def file_md5_on_frame(frame_id: int, path: str, timeout: int = 30,
                            redis: Optional[Redis] = None):
    payload = {"type": "cmd", "name": "file_md5", "args": {"path": path}}
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, timeout=timeout)


async def file_read_on_frame(frame_id: int, path: str, timeout: int = 60,
                             redis: Optional[Redis] = None) -> bytes:
    payload = {"type": "cmd", "name": "file_read", "args": {"path": path}}
    async with _redis_for_command(redis) as command_redis:
        res = await send_cmd(command_redis, frame_id, payload, timeout=timeout)
    if isinstance(res, (bytes, bytearray)):
        return bytes(res)
    raise RuntimeError("bad response from remote file_read")


async def file_write_on_frame(frame_id: int, path: str, data: bytes,
                              timeout: int = 60, redis: Optional[Redis] = None):
    blob    = gzip.compress(data)
    payload = {"type": "cmd", "name": "file_write",
               "args": {"path": path, "size": len(blob)}}
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, blob=blob, timeout=timeout)


async def file_delete_on_frame(frame_id: int, path: str, timeout: int = 60,
                               redis: Optional[Redis] = None):
    payload = {"type": "cmd", "name": "file_delete", "args": {"path": path}}
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, timeout=timeout)


async def file_mkdir_on_frame(frame_id: int, path: str, timeout: int = 60,
                              redis: Optional[Redis] = None):
    payload = {"type": "cmd", "name": "file_mkdir", "args": {"path": path}}
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, timeout=timeout)


async def file_rename_on_frame(frame_id: int, src: str, dst: str,
                               timeout: int = 60, redis: Optional[Redis] = None):
    payload = {
        "type": "cmd",
        "name": "file_rename",
        "args": {"src": src, "dst": dst},
    }
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, timeout=timeout)

async def file_write_open_on_frame(
    frame_id: int, path: str, meta: dict[str, Any] | None = None,
    timeout: int = 30, redis: Redis | None = None,
):
    payload = {
        "type": "cmd", "name": "file_write_open",
        "args": {"path": path, **(meta or {})},
    }
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(command_redis, frame_id, payload, timeout=timeout)


async def file_write_chunk_on_frame(
    frame_id: int, chunk: bytes,
    timeout: int = 60, redis: Redis | None = None,
):
    # Chunks are small (<300KB), so attaching the blob to the command is OK.
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(
            command_redis,
            frame_id,
            {"type": "cmd", "name": "file_write_chunk", "args": {"size": len(chunk)}},
            blob=chunk,
            timeout=timeout,
        )


async def file_write_close_on_frame(
    frame_id: int, timeout: int = 30, redis: Redis | None = None,
):
    async with _redis_for_command(redis) as command_redis:
        return await send_cmd(
            command_redis,
            frame_id,
            {"type": "cmd", "name": "file_write_close", "args": {}},
            timeout=timeout,
        )

# ────────────────────────────────────────────────────────────────────────────
# Redis ⇄ WebSocket pump
# ────────────────────────────────────────────────────────────────────────────

async def pump_commands(
    ws: WebSocket,
    frame_id: int,
    api_key: str,
    shared_secret: str,
    redis: Redis,
) -> None:
    """
    Forever task: pop jobs from Redis, forward them to the Remote,
    optionally stream upload blobs, and stash a byte-buffer for any
    binary download that follows.
    """
    ws.scope.setdefault("cmd_buffers", {})          # cmd_id → bytearray
    ws.scope.setdefault("cmd_log_output", {})       # cmd_id → bool
    try:
        while True:
            _key, raw = await redis.blpop(CMD_KEY.format(id=frame_id), timeout=0)
            job = json.loads(raw)

            cmd_id   = job["id"]
            payload  = job["payload"]
            payload["id"] = cmd_id
            blob_b64 = job.get("blob")

            # Mark the command before writing to the socket. If the websocket
            # drops during send, the waiter still gets a failure response.
            ws.scope["cmd_buffers"][cmd_id] = bytearray()
            ws.scope["cmd_log_output"][cmd_id] = bool(job.get("log", True))

            # These two commands always stream binary data back first
            if payload.get("name") in ("file_read", "http"):
                ws.scope["current_bin_cmd"] = cmd_id

            env = make_envelope(payload, api_key, shared_secret)
            await ws.send_json(env)

            # Optional upload blob (file_write)
            if blob_b64:
                blob = base64.b64decode(blob_b64)
                for off in range(0, len(blob), 4096):
                    await ws.send_bytes(blob[off : off + 4096])

    except (asyncio.CancelledError, RuntimeError, WebSocketDisconnect):
        pass    # let caller handle final cleanup
    finally:
        await fail_pending_commands(ws, redis)


async def fail_pending_commands(
    ws: WebSocket,
    redis: Redis,
    reason: str = REMOTE_DISCONNECTED_ERROR,
) -> None:
    """Unblock commands already popped from Redis when their websocket dies."""
    cmd_buffers = ws.scope.get("cmd_buffers")
    if not isinstance(cmd_buffers, dict):
        return

    pending_ids = list(cmd_buffers.keys())
    if not pending_ids:
        return

    log_output = ws.scope.get("cmd_log_output")
    if not isinstance(log_output, dict):
        log_output = {}

    for cmd_id in pending_ids:
        cmd_buffers.pop(cmd_id, None)
        log_output.pop(cmd_id, None)
        if ws.scope.get("current_bin_cmd") == cmd_id:
            ws.scope.pop("current_bin_cmd", None)

        await redis.rpush(
            RESP_KEY.format(id=cmd_id),
            json.dumps({"ok": False, "error": reason, "result": {"error": reason}}).encode(),
        )
        await redis.expire(RESP_KEY.format(id=cmd_id), 60)


async def handle_remote_stream_chunk(
    ws: WebSocket,
    redis: Redis,
    frame: Frame,
    payload: dict[str, Any],
    client_ip: str | None,
) -> None:
    stream = payload.get("stream", "stdout")
    data = payload.get("data", "")
    command_id = payload["id"]
    log_output = ws.scope.get("cmd_log_output", {}).get(command_id, True)

    if payload.get("raw"):
        for line in str(data).splitlines():
            if line and log_output:
                await write_log(redis, frame.id, stream, line, ip=client_ip)
        await redis.rpush(
            STREAM_KEY.format(id=command_id),
            json.dumps({"stream": stream, "data": data, "raw": True}).encode(),
        )
        await redis.expire(STREAM_KEY.format(id=command_id), 300)
        return

    for line in data.splitlines():
        if line:
            if log_output:
                await write_log(redis, frame.id, stream, line, ip=client_ip)
            await redis.rpush(
                STREAM_KEY.format(id=command_id),
                json.dumps({"stream": stream, "data": line}).encode(),
            )
    await redis.expire(STREAM_KEY.format(id=command_id), 300)

# ────────────────────────────────────────────────────────────────────────────
# Main WebSocket endpoint
# ────────────────────────────────────────────────────────────────────────────

@router.websocket("/ws/agent")
@router.websocket("/ws/remote")
async def ws_remote_endpoint(
    ws: WebSocket,
    redis: Redis = Depends(get_redis),
):
    # ----- rudimentary DoS guard (per-worker) ------------------------------
    if len(active_sockets) >= MAX_REMOTES:
        await ws.close(code=status.WS_1013_TRY_AGAIN_LATER, reason="server busy")
        return

    await ws.accept()

    # STEP 0 – remote → hello
    try:
        hello_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="hello timeout")
        return

    if hello_msg.get("action") != "hello":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="expected hello")
        return

    server_api_key = str(hello_msg.get("serverApiKey", "")) or ""
    db = SessionLocal()
    try:
        frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()
    finally:
        db.close()

    if frame is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="unknown frame")
        return

    shared_secret = (frame.agent or {}).get("agentSharedSecret", "")
    if not shared_secret:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="frame missing secret")
        return

    # STEP 1 – server → challenge
    challenge = secrets.token_hex(32)
    await ws.send_json({"action": "challenge", "c": challenge})

    # STEP 2 – remote → handshake
    try:
        hs_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="handshake timeout")
        return

    if hs_msg.get("action") != "handshake":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad action")
        return

    expected_mac = hmac_sha256(shared_secret, f"{server_api_key}{challenge}")
    if not hmac.compare_digest(expected_mac, str(hs_msg.get("mac", ""))):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
        return

    await mark_sd_image_booted_if_needed(redis, frame.id)

    # STEP 3 – server → handshake/ok  +  start pump
    await ws.send_json({"action": "handshake/ok"})
    await store_connected_remote_version(
        redis,
        frame,
        remote_version_from_hello(hello_msg),
        remote_capabilities_from_hello(hello_msg),
    )
    send_task = asyncio.create_task(
        pump_commands(ws, frame.id, server_api_key, shared_secret, redis)
    )

    client_ip = extract_client_ip(
        ws.headers,
        ws.client.host if ws.client else None,
    )

    # ----- bookkeeping -----------------------------------------------------
    active_sockets.add(ws)
    active_sockets_by_frame.setdefault(frame.id, []).append(ws)

    conn_id  = secrets.token_hex(16)
    conn_key = f"frame:{frame.id}:conn:{conn_id}"
    await redis.set(conn_key, "1", ex=CONN_TTL)

    await publish_message(
        redis, "update_frame",
        {"active_connections": await number_of_connections_for_frame(redis, frame.id),
         "id": frame.id,
         "project_id": frame.project_id}
    )
    await write_log(redis, frame.id, "remote", f'Frame "{frame.name}" connected', ip=client_ip)

    # =======================================================================
    #                           RECEIVE LOOP
    # =======================================================================
    try:
        while True:
            packet = await asyncio.wait_for(ws.receive(), timeout=300)

            # -- Binary frames (part of file_read / http) --------------------
            if packet.get("type") == "websocket.receive" and packet.get("bytes") is not None:
                cmd_id = ws.scope.get("current_bin_cmd")        # type: ignore[attr-defined]
                if cmd_id:
                    buf = ws.scope["cmd_buffers"].get(cmd_id, None)   # type: ignore[index]
                    if buf is not None:
                        buf.extend(packet["bytes"])
                continue

            # -- Text frames -------------------------------------------------
            if packet.get("type") == "websocket.receive" and packet.get("text") is not None:
                msg = json.loads(packet["text"])
            else:
                if packet.get("type") == "websocket.disconnect":
                    break
                continue

            # keep connection key alive
            await redis.expire(conn_key, CONN_TTL)

            # basic envelope check
            if not {"nonce", "payload", "mac"} <= msg.keys():
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad envelope")
                break

            data_to_check = f"{server_api_key}{msg['nonce']}{canonical_dumps(msg['payload'])}"
            if not hmac.compare_digest(hmac_sha256(shared_secret, data_to_check), msg["mac"]):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
                break

            pl = msg["payload"]

            # ① final reply --------------------------------------------------
            if pl.get("type") == "cmd/resp":
                cmd_id = pl["id"]
                ok      = pl.get("ok", False)
                result  = pl.get("result")

                buf = ws.scope["cmd_buffers"].pop(cmd_id, None)    # type: ignore[index]
                if buf:
                    try:
                        raw = gzip.decompress(bytes(buf))
                    except Exception:
                        raw = bytes(buf)
                    if isinstance(result, dict) and "status" in result:
                        result["body"] = raw          # ← http command
                    else:
                        result = raw                  # ← file_read

                # remove marker so Binary frames won't be appended any more
                if ws.scope.get("current_bin_cmd") == cmd_id:
                    ws.scope.pop("current_bin_cmd", None)          # type: ignore[arg-type]
                ws.scope.get("cmd_log_output", {}).pop(cmd_id, None)

                # ── make JSON-safe ────────────────────────────────────────────
                payload: dict[str, Any] = {"ok": ok}

                # a) plain-binary reply  (file_read)
                if isinstance(result, (bytes, bytearray)):
                    payload["binary"] = True
                    payload["result"] = base64.b64encode(result).decode()

                # b) http reply dict with possible binary body
                elif isinstance(result, dict):
                    if isinstance(result.get("body"), (bytes, bytearray)):
                        result["binary"] = True
                        result["body"] = base64.b64encode(result["body"]).decode()
                    payload["result"] = result

                # c) everything else is already JSON-serialisable
                else:
                    payload["result"] = result

                await redis.rpush(RESP_KEY.format(id=cmd_id),
                                  json.dumps(payload).encode())
                await redis.expire(RESP_KEY.format(id=cmd_id), 60)
                continue

            # ② live stream chunk -------------------------------------------
            if pl.get("type") == "cmd/stream":
                await handle_remote_stream_chunk(ws, redis, frame, pl, client_ip)
                continue

    except WebSocketDisconnect:
        pass
    finally:
        # ----- final clean-up ---------------------------------------------
        if ws in active_sockets:
            active_sockets.remove(ws)
        if ws in active_sockets_by_frame.get(frame.id, []):
            active_sockets_by_frame[frame.id].remove(ws)

        send_task.cancel()

        with contextlib.suppress(Exception):
            await redis.delete(conn_key)
            await send_task

        if ws.application_state != WebSocketState.DISCONNECTED:
            with contextlib.suppress(Exception):
                await ws.close()

        await publish_message(
            redis, "update_frame",
            {"active_connections": await number_of_connections_for_frame(redis, frame.id),
             "id": frame.id,
             "project_id": frame.project_id}
        )
        await write_log(redis, frame.id, "remote", f'Frame "{frame.name}" disconnected', ip=client_ip)
