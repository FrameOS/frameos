from __future__ import annotations

import asyncio
import secrets
import json
import hmac
import hashlib
from datetime import datetime, timezone
from typing import Dict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status, Depends
from starlette.websockets import WebSocketState

from app.database import get_db
from sqlalchemy.orm import Session
from app.models.agent import Agent

router = APIRouter()

MAX_AGENTS = 1000             # DoS safeguard
# TRUSTED_ORIGINS = {"https://your.frontend.fqdn"}

active_sockets: Dict[str, WebSocket] = {}

# ---------------------------------------------------------------------------
# HMAC helpers
# ---------------------------------------------------------------------------

def hmac_sha256(key: str, data: str) -> str:
    return hmac.new(key.encode(), data.encode(), hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Canonical JSON  (same rules as Nim’s toOrderedJson())
# ---------------------------------------------------------------------------

def canonical_dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)

# ---------------------------------------------------------------------------
# Main WS endpoint
# ---------------------------------------------------------------------------

@router.websocket("/ws/agent")
async def ws_agent_endpoint(ws: WebSocket, db: Session = Depends(get_db)):
    # Origin check – 1008 on mismatch
    # origin = ws.headers.get("origin")
    # if origin not in TRUSTED_ORIGINS:
    #     await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad origin")
    #     return

    # Resource limit guard
    if len(active_sockets) >= MAX_AGENTS:
        await ws.close(code=status.WS_1013_TRY_AGAIN_LATER, reason="server busy")
        return

    await ws.accept()  # handshake OK – we start protocol below

    # ------------------------------------------------------------------
    # STEP 1 – send random challenge
    # ------------------------------------------------------------------
    challenge = secrets.token_hex(16)
    await ws.send_json({"action": "challenge", "c": challenge})

    try:
        # STEP 2 – wait for client’s answer (max 30 s)
        msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="timeout")
        return

    if msg.get("action") != "handshake":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad action")
        return

    device_id = msg.get("deviceId", "")
    mac       = str(msg.get("mac", ""))

    # input limits
    if len(device_id) > 64 or not device_id.isprintable():
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="invalid id")
        return

    agent: Agent | None = db.get(Agent, device_id)
    if agent is None:
        # first‑time device – create Agent row (yet untrusted)
        agent = Agent(device_id=device_id)
        db.add(agent)
        db.commit()

    # compute expected MAC
    expected = hmac_sha256(agent.server_key, challenge)
    if not hmac.compare_digest(expected, mac):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad key")
        # log + rate‑limit per‑IP elsewhere
        return

    # Passed! store socket & tell client we’re good – or rotate
    active_sockets[device_id] = ws

    if agent.must_rotate_key():
        agent.rotate_key()
        db.add(agent)
        db.commit()
        await ws.send_json({"action": "rotate", "newKey": agent.server_key})
    else:
        await ws.send_json({"action": "handshake/ok"})

    # ------------------------------------------------------------------
    # Receive loop – each packet must be a {nonce,payload,mac} envelope
    # ------------------------------------------------------------------
    try:
        while True:
            msg = await asyncio.wait_for(ws.receive_json(), timeout=60)

            # basic schema check
            if not {"nonce", "payload", "mac"} <= msg.keys():
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad envelope")
                break
            data_to_check = f"{msg['nonce']}{canonical_dumps(msg['payload'])}"
            expected = hmac_sha256(agent.server_key, data_to_check)
            if not hmac.compare_digest(expected, msg["mac"]):
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac")
                break

            # TODO: dispatch payload here …

            agent.last_seen = datetime.now(timezone.utc)
            db.add(agent)
            db.commit()

    except WebSocketDisconnect:
        pass
    finally:
        active_sockets.pop(device_id, None)
        if ws.application_state != WebSocketState.DISCONNECTED:
            await ws.close()
