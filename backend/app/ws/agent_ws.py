from __future__ import annotations

import contextlib
import asyncio
import secrets
import json
import hmac
import hashlib
import time
import uuid
import gzip
from collections import defaultdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status, Depends
from starlette.websockets import WebSocketState
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.redis import get_redis
from app.websockets import publish_message
from app.models.frame import Frame
from app.models.log import new_log as log

router = APIRouter()

MAX_AGENTS = 1000  # DoS safeguard
CONN_TTL = 60  # seconds - how long one WS key lives in Redis

# frame_id → list[websocket]
active_sockets_by_frame: dict[int, list[WebSocket]] = {}
active_sockets: set[WebSocket] = set()

_frame_queues: dict[int, asyncio.Queue] = defaultdict(asyncio.Queue)
_pending: dict[str, asyncio.Future] = {}  # cmd-id → Future
_binary_buffers: dict[str, bytearray] = {}
_pending_bin_by_ws: dict[WebSocket, str] = {}


def queue_command(
    frame_id: int, payload: dict, blob: bytes | None = None
) -> tuple[asyncio.Future, str]:
    """
    Add a command payload to the per-frame queue, return a Future that
    resolves when the agent answers.
    """
    cmd_id = str(uuid.uuid4())
    payload["id"] = cmd_id
    fut = _pending[cmd_id] = asyncio.get_event_loop().create_future()
    _frame_queues[frame_id].put_nowait((payload, blob))
    return fut, cmd_id  # caller will await it


async def next_command(frame_id: int) -> tuple[dict, bytes | None] | None:
    """Wait until there is a command for this frame (or None if queue empty)."""
    try:
        return await _frame_queues[frame_id].get()
    except asyncio.CancelledError:
        return None


def resolve_command(cmd_id: str, ok: bool, result):
    fut = _pending.pop(cmd_id, None)
    if fut and not fut.done():
        # attach streamed binary, if any
        if cmd_id in _binary_buffers and _binary_buffers[cmd_id]:
            raw = bytes(_binary_buffers.pop(cmd_id))

            # file_read → gzip,  http → plain
            try:
                raw_decompressed = gzip.decompress(raw)
            except Exception:
                raw_decompressed = raw  # not gzipped

            if isinstance(result, dict) and "status" in result:
                # ← http command: return dictbody
                result["body"] = raw_decompressed
                fut.set_result(result if ok else RuntimeError(result))
            else:
                # ← file_read: return raw bytes
                fut.set_result(raw_decompressed if ok else RuntimeError(result))
        else:
            # no binary frames at all – keep the original reply untouched
            if cmd_id in _binary_buffers:
                _binary_buffers.pop(cmd_id, None)
            if ok:
                fut.set_result(result)
            else:
                fut.set_exception(RuntimeError(result))


async def pump_commands(ws: WebSocket, frame_id: int, api_key: str, shared_secret: str):
    try:
        while True:
            item = await next_command(frame_id)
            if item is None:
                return
            cmd, blob = item
            env = make_envelope(cmd, api_key, shared_secret)

            try:
                await ws.send_json(env)
                if cmd.get("name") in ("file_read", "http"):
                    _pending_bin_by_ws[ws] = cmd["id"]
                if blob:
                    for i in range(0, len(blob), 4096):
                        await ws.send_bytes(blob[i : i + 4096])
            except RuntimeError:
                # re-queue so another connection can pick it up
                if cmd.get("name") == "file_read":
                    _pending_bin_by_ws.pop(ws, None)
                _frame_queues[frame_id].put_nowait(item)
                break  # exit the loop
    finally:
        # make sure no zombie task hangs around and clear any buffers
        if ws in _pending_bin_by_ws:
            cmd_id = _pending_bin_by_ws.pop(ws)
            _binary_buffers.pop(cmd_id, None)
            fut = _pending.pop(cmd_id, None)
            if fut and not fut.done():
                fut.set_exception(RuntimeError("connection closed"))
        await ws.close(code=1000)


async def http_get_on_frame(
    frame_id: int,
    path: str,
    method: str = "GET",
    body=None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
):
    payload = {
        "type": "cmd",
        "name": "http",
        "args": {
            "method": method,
            "path": path,
            "body": body,
            "headers": headers or {},
        },
    }
    fut, cmd_id = queue_command(frame_id, payload)

    # this allocates the buffer which Binary frames will fill
    _binary_buffers[cmd_id] = bytearray()
    return await asyncio.wait_for(fut, timeout=timeout)


async def assets_list_on_frame(frame_id: int, path: str, timeout: int = 60):
    """
    Ask the agent to enumerate every asset (JSON list).
    """
    payload = {
        "type": "cmd",
        "name": "assets_list",
        "args": {"path": path},
    }
    fut, _ = queue_command(frame_id, payload)
    resp = await asyncio.wait_for(fut, timeout=timeout)
    if isinstance(resp, dict) and "assets" in resp:
        return resp["assets"]
    raise RuntimeError("bad response from agent assets_list")


async def exec_shell_on_frame(frame_id: int, cmd: str, timeout: int = 120):
    """
    Fire-and-forget shell helper. Raises if exit != 0.
    """
    payload = {
        "type": "cmd",
        "name": "shell",
        "args": {"cmd": cmd},
    }
    fut, _ = queue_command(frame_id, payload)
    reply = await asyncio.wait_for(fut, timeout=timeout)
    if isinstance(reply, dict) and reply.get("exit", 1) == 0:
        return
    raise RuntimeError(f"shell failed: {reply}")


def hmac_sha256(key: str, data: str) -> str:
    """Return lowercase HMAC-SHA256(key, data)."""
    return hmac.new(key.encode(), data.encode(), hashlib.sha256).hexdigest()


def sign(data: str, api_key: str, shared_secret: str) -> str:
    """
    Compute HMAC-SHA256(shared_secret, api_key || data) - the new unified signature
    used by the agent and expected by the backend.
    """
    return hmac_sha256(shared_secret, f"{api_key}{data}")


def canonical_dumps(obj) -> str:
    """Dump JSON with sorted keys & no spaces - deterministic (like Nim)."""
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


async def number_of_connections_for_frame(redis: Redis, frame_id: int) -> int:
    """
    Count keys “frame:{id}:conn:*” - each represents one active socket.
    The keys self-expire, so the count is always fresh even after a crash.
    """
    cnt = 0
    async for _ in redis.scan_iter(match=f"frame:{frame_id}:conn:*"):
        cnt += 1
    return cnt


def make_envelope(payload: dict, api_key: str, shared_secret: str) -> dict:
    nonce = int(time.time())
    body = canonical_dumps(payload)
    mac = hmac_sha256(shared_secret, f"{api_key}{nonce}{body}")
    return {
        "nonce": nonce,
        "serverApiKey": api_key,
        "payload": payload,
        "mac": mac,
    }


async def file_md5_on_frame(frame_id: int, path: str, timeout: int = 30):
    """Ask agent to calculate MD5 of *path*."""
    payload = {
        "type": "cmd",
        "name": "file_md5",
        "args": {"path": path},
    }
    fut, _ = queue_command(frame_id, payload)
    return await asyncio.wait_for(fut, timeout=timeout)


async def file_read_on_frame(frame_id: int, path: str, timeout: int = 60) -> bytes:
    """Download *path* from agent - returns raw bytes."""
    payload = {
        "type": "cmd",
        "name": "file_read",
        "args": {"path": path},
    }
    fut, cmd_id = queue_command(frame_id, payload)
    _binary_buffers[cmd_id] = bytearray()
    resp = await asyncio.wait_for(fut, timeout=timeout)
    if isinstance(resp, bytes):
        return resp
    raise RuntimeError("bad response from agent file_read")


async def file_write_on_frame(frame_id: int, path: str, data: bytes, timeout: int = 60):
    """Upload a file to the frame via agent."""
    compressed = gzip.compress(data)
    payload = {
        "type": "cmd",
        "name": "file_write",
        "args": {"path": path, "size": len(compressed)},
    }
    fut, _ = queue_command(frame_id, payload, compressed)
    return await asyncio.wait_for(fut, timeout=timeout)


async def file_delete_on_frame(frame_id: int, path: str, timeout: int = 60):
    """Delete a file or directory on the frame via agent."""
    payload = {
        "type": "cmd",
        "name": "file_delete",
        "args": {"path": path},
    }
    fut, _ = queue_command(frame_id, payload)
    return await asyncio.wait_for(fut, timeout=timeout)


async def file_mkdir_on_frame(frame_id: int, path: str, timeout: int = 60):
    """Create a directory on the frame via agent."""
    payload = {
        "type": "cmd",
        "name": "file_mkdir",
        "args": {"path": path},
    }
    fut, _ = queue_command(frame_id, payload)
    return await asyncio.wait_for(fut, timeout=timeout)


async def file_rename_on_frame(frame_id: int, src: str, dst: str, timeout: int = 60):
    """Rename a file or directory on the frame via agent."""
    payload = {
        "type": "cmd",
        "name": "file_rename",
        "args": {"src": src, "dst": dst},
    }
    fut, _ = queue_command(frame_id, payload)
    return await asyncio.wait_for(fut, timeout=timeout)


# ---------------------------------------------------------------------------
# Main WS endpoint
# ---------------------------------------------------------------------------


@router.websocket("/ws/agent")
async def ws_agent_endpoint(
    ws: WebSocket,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    # Basic DoS protection (per-worker)
    if len(active_sockets) >= MAX_AGENTS:
        await ws.close(code=status.WS_1013_TRY_AGAIN_LATER, reason="server busy")
        return

    await ws.accept()  # TCP ↔ WS handshake OK - start protocol below

    # STEP 0 - agent → {action:"hello", serverApiKey}
    try:
        hello_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="hello timeout")
        return

    if hello_msg.get("action") != "hello":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="expected hello")
        return

    server_api_key: str = str(hello_msg.get("serverApiKey", ""))

    # Look up the **Frame** that owns this server-side key.
    if not server_api_key:
        await ws.close(
            code=status.WS_1008_POLICY_VIOLATION, reason="missing server key"
        )
        return

    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()
    if frame is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="unknown frame")
        return

    # Each frame has an associated *shared secret* used for HMAC
    shared_secret: str = frame.agent.get("agentSharedSecret", "") if frame.agent else ""
    if not shared_secret:
        await ws.close(
            code=status.WS_1008_POLICY_VIOLATION, reason="frame missing secret"
        )
        return

    # STEP 1 - server → challenge
    challenge = secrets.token_hex(32)
    await ws.send_json({"action": "challenge", "c": challenge})

    # STEP 2 - agent → {action:"handshake", mac:...}
    try:
        hs_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="handshake timeout")
        return

    if hs_msg.get("action") != "handshake":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad action")
        return

    mac = str(hs_msg.get("mac", ""))

    expected_mac = sign(challenge, server_api_key, shared_secret)
    if not hmac.compare_digest(expected_mac, mac):
        print(
            f'Invalid MAC for frame {frame.id} "{frame.name}": expected {expected_mac}, got {mac}'
        )
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
        return

    # STEP 3 - server → handshake/ok
    await ws.send_json({"action": "handshake/ok"})
    send_task = asyncio.create_task(
        pump_commands(ws, frame.id, server_api_key, shared_secret)
    )

    # Fully authenticated - register this socket
    active_sockets.add(ws)
    active_sockets_by_frame.setdefault(frame.id, []).append(ws)

    # Each connection gets its own Redis key that self-expires.
    conn_id = secrets.token_hex(16)
    conn_key = f"frame:{frame.id}:conn:{conn_id}"
    await redis.set(conn_key, "1", ex=CONN_TTL)

    await publish_message(
        redis,
        "update_frame",
        {
            "active_connections": await number_of_connections_for_frame(
                redis, frame.id
            ),
            "id": frame.id,
        },
    )

    await log(db, redis, frame.id, "agent", f'☎️ Frame "{frame.name}" connected ☎️')

    # Main receive loop (enveloped messages)
    try:
        while True:
            packet = await asyncio.wait_for(ws.receive(), timeout=60)

            if (
                packet.get("type") == "websocket.receive"
                and packet.get("bytes") is not None
            ):
                cmd_id = _pending_bin_by_ws.get(ws)
                if cmd_id and cmd_id in _binary_buffers:
                    _binary_buffers[cmd_id].extend(packet["bytes"])
                continue

            if (
                packet.get("type") == "websocket.receive"
                and packet.get("text") is not None
            ):
                msg = json.loads(packet["text"])
            else:
                if packet.get("type") == "websocket.disconnect":
                    break
                continue

            # keep the connection key alive
            await redis.expire(conn_key, CONN_TTL)

            # Basic schema check
            if not {"nonce", "payload", "mac"} <= msg.keys():
                await ws.close(
                    code=status.WS_1008_POLICY_VIOLATION, reason="bad envelope"
                )
                break

            data_to_check = (
                f"{server_api_key}"
                f"{msg['nonce']}"
                f"{canonical_dumps(msg['payload'])}"
            )
            expected = hmac_sha256(shared_secret, data_to_check)
            if not hmac.compare_digest(expected, msg["mac"]):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
                break

            pl = msg["payload"]
            if pl.get("type") == "cmd/resp":
                resolve_command(pl["id"], pl.get("ok", False), pl.get("result"))
                if _pending_bin_by_ws.get(ws) == pl["id"]:
                    _pending_bin_by_ws.pop(ws, None)
                continue
            elif pl.get("type") == "cmd/stream":
                # Stream chunks arrive while a shell command runs on the frame.
                stream = pl.get("stream", "stdout")
                data = pl.get("data", "")

                for line in data.splitlines():
                    if line:  # skip blanks to match exec_command
                        await log(db, redis, frame.id, stream, line)

                # NB: resolve_command is NOT called here – it is done on the final
                #     “cmd/resp” message which arrives after exit status is known.
                continue

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up
        if ws in active_sockets:
            active_sockets.remove(ws)
        if ws in active_sockets_by_frame.get(frame.id, []):
            active_sockets_by_frame[frame.id].remove(ws)

        send_task.cancel()
        cmd_id = _pending_bin_by_ws.pop(ws, None)
        if cmd_id:
            _binary_buffers.pop(cmd_id, None)
            fut = _pending.pop(cmd_id, None)
            if fut and not fut.done():
                fut.set_exception(RuntimeError("connection closed"))

        # Remove this connection’s Redis key (if we still can)
        try:
            await redis.delete(conn_key)
        except Exception:
            pass

        if ws.application_state != WebSocketState.DISCONNECTED:
            try:
                await ws.close()
            except Exception:
                pass

        # Broadcast “disconnected” state
        await publish_message(
            redis,
            "update_frame",
            {
                "active_connections": await number_of_connections_for_frame(
                    redis, frame.id
                ),
                "id": frame.id,
            },
        )
        await log(
            db, redis, frame.id, "agent", f'👋 Frame "{frame.name}" disconnected 👋'
        )

        with contextlib.suppress(Exception):
            await send_task
