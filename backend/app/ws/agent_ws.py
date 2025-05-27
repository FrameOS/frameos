# backend/app/ws/agent_ws.py
from __future__ import annotations

import asyncio
import secrets
import json
import hmac
import hashlib
from datetime import datetime, timezone
from typing import Dict, Optional, TypedDict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status, Depends
from starlette.websockets import WebSocketState
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.redis import get_redis
from app.websockets import publish_message
from app.models.agent import Agent
from app.models.frame import Frame
from app.models.log import new_log as log

router = APIRouter()

MAX_AGENTS = 1000             # DoS safeguard
# TRUSTED_ORIGINS = {"https://your.frontend.fqdn"}

# device_id → websocket
active_sockets: Dict[str, WebSocket] = {}


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


class AgentPayload(TypedDict):
    id: str
    org_id: str
    batch_id: str
    device_id: str
    server_key_version: int
    last_seen: Optional[str]
    connected: bool
    frame_id: Optional[int]


def _agent_to_dict(agent: Agent) -> AgentPayload:
    """Convert an Agent SQLAlchemy row into a broadcast-friendly dict."""
    return AgentPayload(
        id                = agent.id,
        org_id            = agent.org_id,
        batch_id          = agent.batch_id,
        device_id         = agent.device_id,
        server_key_version= agent.server_key_version,
        last_seen         = agent.last_seen.replace(tzinfo=timezone.utc).isoformat()
                            if agent.last_seen else None,
        connected         = agent.device_id in active_sockets,
        frame_id          = agent.frame_id,
    )


# ---------------------------------------------------------------------------
# Main WS endpoint
# ---------------------------------------------------------------------------

@router.websocket("/ws/agent")
async def ws_agent_endpoint(
    ws: WebSocket,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    # ────────────────────────────────────────────────────────────────────────
    # Optional origin check
    # ────────────────────────────────────────────────────────────────────────
    # origin = ws.headers.get("origin")
    # if origin not in TRUSTED_ORIGINS:
    #     await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad origin")
    #     return

    # Basic DoS protection
    if len(active_sockets) >= MAX_AGENTS:
        await ws.close(code=status.WS_1013_TRY_AGAIN_LATER, reason="server busy")
        return

    await ws.accept()  # TCP ↔ WS handshake OK – start protocol below

    # ----------------------------------------------------------------------
    # STEP 0 – agent → {action:"hello", orgId, batchId, deviceId, serverApiKey}
    # ----------------------------------------------------------------------
    try:
        hello_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="hello timeout")
        return

    if hello_msg.get("action") != "hello":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="expected hello")
        return

    org_id        : str = hello_msg.get("orgId", "")
    batch_id      : str = hello_msg.get("batchId", "")
    device_id     : str = hello_msg.get("deviceId", "")
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
    # Validate identifiers
    # ----------------------------------------------------------------------
    for ident, name in [(org_id, "org"), (batch_id, "batch"), (device_id, "device")]:
        if len(ident) > 64 or not ident.isprintable():
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason=f"invalid {name} id")
            return

    # ----------------------------------------------------------------------
    # Look up / create Agent – ONLY if its frame is known
    # ----------------------------------------------------------------------
    is_new_agent = False

    agent: Agent | None = db.query(Agent).filter_by(
        device_id=device_id,
        org_id=org_id,
        batch_id=batch_id,
    ).first()

    # === New agent ========================================================
    if agent is None:
        is_new_agent = True
        agent = Agent(
            device_id=device_id,
            org_id=org_id,
            batch_id=batch_id,
            server_key=server_api_key,
            frame_id=frame.id
        )

        db.add(agent)  # commit after successful handshake

        print(f"New agent {device_id} created (awaiting handshake)")

    # === Existing agent ===================================================
    else:
        # Existing agent must belong to the same frame and use the same key
        if agent.frame_id != frame.id or server_api_key != agent.server_key:
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="frame/key mismatch")
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
        db.rollback()
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="handshake timeout")
        return

    if hs_msg.get("action") != "handshake":
        db.rollback()
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad action")
        return

    mac = str(hs_msg.get("mac", ""))

    expected_mac = sign(challenge, server_api_key, shared_secret)
    if not hmac.compare_digest(expected_mac, mac):
        print(f"Invalid MAC from {device_id}: expected {expected_mac}, got {mac}")
        db.rollback()
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
        return

    # ----------------------------------------------------------------------
    # STEP 3 – server → handshake/ok
    # ----------------------------------------------------------------------
    await ws.send_json({"action": "handshake/ok"})

    # Commit any pending DB changes (e.g. new agent) after successful auth
    db.commit()
    if is_new_agent:
        await publish_message(redis, "new_agent", _agent_to_dict(agent))

    # ----------------------------------------------------------------------
    # Fully authenticated – store socket and broadcast “connected”
    # ----------------------------------------------------------------------
    active_sockets[device_id] = ws
    await publish_message(redis, "update_agent", _agent_to_dict(agent))

    await log(db, redis, frame.id, "stdout", "☎️ agent connected ☎️")

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

            # Update last-seen timestamp
            agent.last_seen = datetime.now(timezone.utc)
            db.add(agent)
            db.commit()

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up
        active_sockets.pop(device_id, None)
        if ws.application_state != WebSocketState.DISCONNECTED:
            try:
                await ws.close()
            except Exception:
                pass

        # Broadcast “disconnected” state
        await publish_message(redis, "update_agent", _agent_to_dict(agent))
        await log(db, redis, frame.id, "stdout", "👋 agent disconnected 👋")