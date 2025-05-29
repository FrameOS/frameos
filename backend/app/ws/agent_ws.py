from __future__ import annotations

import asyncio
import secrets
import json
import hmac
import hashlib

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

MAX_AGENTS = 1000       # DoS safeguard
CONN_TTL   = 60         # seconds - how long one WS key lives in Redis

# frame_id → list[websocket]
active_sockets_by_frame: dict[int, list[WebSocket]] = {}
active_sockets: set[WebSocket] = set()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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

    # ----------------------------------------------------------------------
    # STEP 0 - agent → {action:"hello", serverApiKey}
    # ----------------------------------------------------------------------
    try:
        hello_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="hello timeout")
        return

    if hello_msg.get("action") != "hello":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="expected hello")
        return

    server_api_key: str = str(hello_msg.get("serverApiKey", ""))

    # ----------------------------------------------------------------------
    # Look up the **Frame** that owns this server-side key.
    # ----------------------------------------------------------------------
    if not server_api_key:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="missing server key")
        return

    frame = db.query(Frame).filter_by(server_api_key=server_api_key).first()
    if frame is None:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="unknown frame")
        return

    # Each frame has an associated *shared secret* used for HMAC
    shared_secret: str = frame.network.get("agentSharedSecret", "") if frame.network else ""
    if not shared_secret:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="frame missing secret")
        return

    # ----------------------------------------------------------------------
    # STEP 1 - server → challenge
    # ----------------------------------------------------------------------
    challenge = secrets.token_hex(32)
    await ws.send_json({"action": "challenge", "c": challenge})

    # ----------------------------------------------------------------------
    # STEP 2 - agent → {action:"handshake", mac:...}
    # ----------------------------------------------------------------------
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
        print(f"Invalid MAC for frame {frame.id} \"{frame.name}\": expected {expected_mac}, got {mac}")
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
        return

    # ----------------------------------------------------------------------
    # STEP 3 - server → handshake/ok
    # ----------------------------------------------------------------------
    await ws.send_json({"action": "handshake/ok"})

    # ----------------------------------------------------------------------
    # Fully authenticated - register this socket
    # ----------------------------------------------------------------------
    active_sockets.add(ws)
    active_sockets_by_frame.setdefault(frame.id, []).append(ws)

    # Each connection gets its own Redis key that self-expires.
    conn_id  = secrets.token_hex(16)
    conn_key = f"frame:{frame.id}:conn:{conn_id}"
    await redis.set(conn_key, "1", ex=CONN_TTL)

    await publish_message(
        redis,
        "update_frame",
        {"active_connections": await number_of_connections_for_frame(redis, frame.id), "id": frame.id},
    )

    await log(db, redis, frame.id, "agent", f"☎️ Frame \"{frame.name}\" connected ☎️")

    # ----------------------------------------------------------------------
    # Main receive loop (enveloped messages)
    # ----------------------------------------------------------------------
    try:
        while True:
            msg = await asyncio.wait_for(ws.receive_json(), timeout=60)

            # keep the connection key alive
            await redis.expire(conn_key, CONN_TTL)

            # Basic schema check
            if not {"nonce", "payload", "mac"} <= msg.keys():
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad envelope")
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

            # TODO: dispatch payload …

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up
        if ws in active_sockets:
            active_sockets.remove(ws)
        if ws in active_sockets_by_frame.get(frame.id, []):
            active_sockets_by_frame[frame.id].remove(ws)

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
            {"active_connections": await number_of_connections_for_frame(redis, frame.id), "id": frame.id},
        )
        await log(db, redis, frame.id, "agent", f"👋 Frame \"{frame.name}\" disconnected 👋")
