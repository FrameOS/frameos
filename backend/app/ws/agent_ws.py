from __future__ import annotations

import asyncio
import base64
import contextlib
import gzip
import hmac
import hashlib
import json
import secrets
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from starlette.websockets import WebSocketState
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

# ── project locals ──────────────────────────────────────────────────────────
from app.database import get_db
from app.redis import get_redis, create_redis_connection   # create_… gives a raw conn
from app.websockets import publish_message
from app.models.frame import Frame
from app.models.log import new_log as log
from app.ws.agent_bridge import CMD_KEY, RESP_KEY, STREAM_KEY, send_cmd

router = APIRouter()

MAX_AGENTS = 1000         # simple DoS safeguard
CONN_TTL   = 60           # seconds – Redis key self-expiry

# frame_id → list[websocket] (only for UI statistics)
active_sockets_by_frame: dict[int, list[WebSocket]] = {}
active_sockets: set[WebSocket] = set()

# ────────────────────────────────────────────────────────────────────────────
# tiny helpers
# ────────────────────────────────────────────────────────────────────────────

def hmac_sha256(key: str, data: str) -> str:
    return hmac.new(key.encode(), data.encode(), hashlib.sha256).hexdigest()


def canonical_dumps(obj: Any) -> str:
    """Dump JSON with deterministic key ordering – matches Nim's canonical()."""
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


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


async def _ensure_redis(redis: Optional[Redis]) -> Redis:
    return redis or create_redis_connection()

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
    redis = await _ensure_redis(redis)
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
    return await send_cmd(redis, frame_id, payload, timeout=timeout)


async def assets_list_on_frame(frame_id: int, path: str, timeout: int = 60,
                               redis: Optional[Redis] = None):
    redis = await _ensure_redis(redis)
    payload = {"type": "cmd", "name": "assets_list", "args": {"path": path}}
    resp    = await send_cmd(redis, frame_id, payload, timeout=timeout)
    if isinstance(resp, dict) and "assets" in resp:
        return resp["assets"]
    raise RuntimeError("bad response from agent assets_list")


async def exec_shell_on_frame(frame_id: int, cmd: str, timeout: int = 120,
                              redis: Optional[Redis] = None):
    redis   = await _ensure_redis(redis)
    payload = {"type": "cmd", "name": "shell", "args": {"cmd": cmd}}
    reply   = await send_cmd(redis, frame_id, payload, timeout=timeout)
    if isinstance(reply, dict) and reply.get("exit", 1) == 0:
        return
    raise RuntimeError(f"shell failed: {reply}")


async def file_md5_on_frame(frame_id: int, path: str, timeout: int = 30,
                            redis: Optional[Redis] = None):
    redis   = await _ensure_redis(redis)
    payload = {"type": "cmd", "name": "file_md5", "args": {"path": path}}
    return await send_cmd(redis, frame_id, payload, timeout=timeout)


async def file_read_on_frame(frame_id: int, path: str, timeout: int = 60,
                             redis: Optional[Redis] = None) -> bytes:
    redis   = await _ensure_redis(redis)
    payload = {"type": "cmd", "name": "file_read", "args": {"path": path}}
    res     = await send_cmd(redis, frame_id, payload, timeout=timeout)
    if isinstance(res, (bytes, bytearray)):
        return bytes(res)
    raise RuntimeError("bad response from agent file_read")


async def file_write_on_frame(frame_id: int, path: str, data: bytes,
                              timeout: int = 60, redis: Optional[Redis] = None):
    redis   = await _ensure_redis(redis)
    blob    = gzip.compress(data)
    payload = {"type": "cmd", "name": "file_write",
               "args": {"path": path, "size": len(blob)}}
    return await send_cmd(redis, frame_id, payload, blob=blob, timeout=timeout)


async def file_delete_on_frame(frame_id: int, path: str, timeout: int = 60,
                               redis: Optional[Redis] = None):
    redis   = await _ensure_redis(redis)
    payload = {"type": "cmd", "name": "file_delete", "args": {"path": path}}
    return await send_cmd(redis, frame_id, payload, timeout=timeout)


async def file_mkdir_on_frame(frame_id: int, path: str, timeout: int = 60,
                              redis: Optional[Redis] = None):
    redis   = await _ensure_redis(redis)
    payload = {"type": "cmd", "name": "file_mkdir", "args": {"path": path}}
    return await send_cmd(redis, frame_id, payload, timeout=timeout)


async def file_rename_on_frame(frame_id: int, src: str, dst: str,
                               timeout: int = 60, redis: Optional[Redis] = None):
    redis   = await _ensure_redis(redis)
    payload = {
        "type": "cmd",
        "name": "file_rename",
        "args": {"src": src, "dst": dst},
    }
    return await send_cmd(redis, frame_id, payload, timeout=timeout)

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
    Forever task: pop jobs from Redis, forward them to the agent,
    optionally stream upload blobs, and stash a byte-buffer for any
    binary download that follows.
    """
    ws.scope.setdefault("cmd_buffers", {})          # cmd_id → bytearray
    try:
        while True:
            _key, raw = await redis.blpop(CMD_KEY.format(id=frame_id), timeout=0)
            job = json.loads(raw)

            cmd_id   = job["id"]
            payload  = job["payload"]
            payload["id"] = cmd_id
            blob_b64 = job.get("blob")

            env = make_envelope(payload, api_key, shared_secret)
            await ws.send_json(env)

            # store buffer for incoming Binary frames (if any)
            ws.scope["cmd_buffers"][cmd_id] = bytearray()

            # These two commands always stream binary data back first
            if payload.get("name") in ("file_read", "http"):
                ws.scope["current_bin_cmd"] = cmd_id

            # Optional upload blob (file_write)
            if blob_b64:
                blob = base64.b64decode(blob_b64)
                for off in range(0, len(blob), 4096):
                    await ws.send_bytes(blob[off : off + 4096])

    except (asyncio.CancelledError, RuntimeError, WebSocketDisconnect):
        pass    # let caller handle final cleanup

# ────────────────────────────────────────────────────────────────────────────
# Main WebSocket endpoint
# ────────────────────────────────────────────────────────────────────────────

@router.websocket("/ws/agent")
async def ws_agent_endpoint(
    ws: WebSocket,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    # ----- rudimentary DoS guard (per-worker) ------------------------------
    if len(active_sockets) >= MAX_AGENTS:
        await ws.close(code=status.WS_1013_TRY_AGAIN_LATER, reason="server busy")
        return

    await ws.accept()

    # STEP 0 – agent → hello
    try:
        hello_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="hello timeout")
        return

    if hello_msg.get("action") != "hello":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="expected hello")
        return

    server_api_key = str(hello_msg.get("serverApiKey", "")) or ""
    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()
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

    # STEP 2 – agent → handshake
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

    # STEP 3 – server → handshake/ok  +  start pump
    await ws.send_json({"action": "handshake/ok"})
    send_task = asyncio.create_task(
        pump_commands(ws, frame.id, server_api_key, shared_secret, redis)
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
         "id": frame.id}
    )
    await log(db, redis, frame.id, "agent", f'☎️ Frame "{frame.name}" connected ☎️')

    # =======================================================================
    #                           RECEIVE LOOP
    # =======================================================================
    try:
        while True:
            packet = await asyncio.wait_for(ws.receive(), timeout=60)

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
                stream = pl.get("stream", "stdout")
                data   = pl.get("data", "")

                for line in data.splitlines():
                    if line:
                        await log(db, redis, frame.id, stream, line)
                        await redis.rpush(STREAM_KEY.format(id=pl["id"]),
                                          json.dumps({"stream": stream, "data": line}).encode())
                await redis.expire(STREAM_KEY.format(id=pl["id"]), 300)
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
             "id": frame.id}
        )
        await log(db, redis, frame.id, "agent", f'👋 Frame "{frame.name}" disconnected 👋')
