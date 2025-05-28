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
# from app.websockets import publish_message
from app.models.frame import Frame
from app.models.log import new_log as log

router = APIRouter()

MAX_AGENTS = 1000             # DoS safeguard

# frame_id → list[websocket]
active_sockets_by_frame: dict[str, list[WebSocket]] = {}
active_sockets: set[WebSocket] = set()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def hmac_sha256(key: str, data: str) -> str:
    """Return lowercase HMAC-SHA256(key, data)."""
    return hmac.new(key.encode(), data.encode(), hashlib.sha256).hexdigest()


def sign(data: str, api_key: str, shared_secret: str) -> str:
    """
    Compute HMAC-SHA256(shared_secret, api_key || data) – the new unified signature
    used by the agent and expected by the backend.
    """
    return hmac_sha256(shared_secret, f"{api_key}{data}")


def canonical_dumps(obj) -> str:
    """Dump JSON with sorted keys & no spaces – deterministic (like Nim)."""
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)




# ---------------------------------------------------------------------------
# Main WS endpoint
# ---------------------------------------------------------------------------

@router.websocket("/ws/agent")
async def ws_agent_endpoint(
    ws: WebSocket,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    # Basic DoS protection
    if len(active_sockets) >= MAX_AGENTS:
        await ws.close(code=status.WS_1013_TRY_AGAIN_LATER, reason="server busy")
        return

    await ws.accept()  # TCP ↔ WS handshake OK – start protocol below

    # ----------------------------------------------------------------------
    # STEP 0 – agent → {action:"hello", serverApiKey}
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
    # If no such frame exists we abort – we never register “orphan” agents.
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
    # STEP 1 – server → challenge
    # ----------------------------------------------------------------------
    challenge = secrets.token_hex(32)
    await ws.send_json({"action": "challenge", "c": challenge})

    # ----------------------------------------------------------------------
    # STEP 2 – agent → {action:"handshake", mac:...}
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
    # STEP 3 – server → handshake/ok
    # ----------------------------------------------------------------------
    await ws.send_json({"action": "handshake/ok"})

    # ----------------------------------------------------------------------
    # Fully authenticated – store socket and broadcast “connected”
    # ----------------------------------------------------------------------
    active_sockets.add(ws)
    # TODO:
    # await publish_message(redis, "update_agent", _agent_to_dict(agent))

    await log(db, redis, frame.id, "agent", f"☎️ Frame \"{frame.name}\" connected ☎️")

    # ----------------------------------------------------------------------
    # Main receive loop (enveloped messages)
    # ----------------------------------------------------------------------
    try:
        while True:
            msg = await asyncio.wait_for(ws.receive_json(), timeout=60)

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

            # # Update last-seen timestamp
            # frame.last_seen = datetime.now(timezone.utc)
            # db.add(frame)
            # db.commit()

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up
        if ws in active_sockets:
            active_sockets.remove(ws)
        if ws.application_state != WebSocketState.DISCONNECTED:
            try:
                await ws.close()
            except Exception:
                pass

        # Broadcast “disconnected” state
        # await publish_message(redis, "update_agent", _agent_to_dict(agent))
        await log(db, redis, frame.id, "agent", f"👋 Frame \"{frame.name}\" disconnected 👋")