from __future__ import annotations

import asyncio
import secrets
import json
import hmac
import hashlib
from datetime import datetime, timezone
from typing import Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status, Depends
from starlette.websockets import WebSocketState

from app.database import get_db
from sqlalchemy.orm import Session
from app.models.agent import Agent

router = APIRouter()

MAX_AGENTS = 1000             # DoS safeguard
# TRUSTED_ORIGINS = {"https://your.frontend.fqdn"}

# device_id → websocket
active_sockets: Dict[str, WebSocket] = {}


# ---------------------------------------------------------------------------
# HMAC helpers
# ---------------------------------------------------------------------------

def hmac_sha256(key: str, data: str) -> str:
    """Return lowercase HMAC-SHA256(key, data)."""
    return hmac.new(key.encode(), data.encode(), hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Canonical JSON (same rules as Nim’s canonical() helper)
# ---------------------------------------------------------------------------

def canonical_dumps(obj) -> str:
    """Dump JSON with sorted keys & no spaces – deterministic."""
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# Main WS endpoint
# ---------------------------------------------------------------------------

@router.websocket("/ws/agent")
async def ws_agent_endpoint(ws: WebSocket, db: Session = Depends(get_db)):
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

    await ws.accept()  # handshake OK – start protocol below

    # ----------------------------------------------------------------------
    # STEP 1 – server → challenge
    # ----------------------------------------------------------------------
    challenge = secrets.token_hex(16)
    await ws.send_json({"action": "challenge", "c": challenge})

    # ----------------------------------------------------------------------
    # STEP 2 – client → handshake
    # ----------------------------------------------------------------------
    try:
        msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="timeout")
        return

    if msg.get("action") != "handshake":
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad action")
        return

    org_id: str = msg.get("orgId", "")
    batch_id: str = msg.get("batchId", "")
    device_id: str = msg.get("deviceId", "")
    mac: str = str(msg.get("mac", ""))

    print(
        f"Handshake from org={org_id!r} batch={batch_id!r} "
        f"device={device_id!r} mac={mac!r}"
    )

    # ----------------------------------------------------------------------
    # Validate identifiers
    # ----------------------------------------------------------------------
    for ident, name in [(org_id, "org"), (batch_id, "batch"), (device_id, "device")]:
        if len(ident) > 64 or not ident.isprintable():
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason=f"invalid {name} id")
            return

    # ----------------------------------------------------------------------
    # Look up / create Agent
    # ----------------------------------------------------------------------
    ack_expected: Optional[str] = None  # "register/ack" | "rotate/ack" | None

    agent: Agent | None = db.query(Agent).filter_by(
        device_id=device_id,
        org_id=org_id,
        batch_id=batch_id,
    ).first()

    # === New agent ========================================================
    if agent is None:
        if mac:
            # New devices must not send a MAC yet
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad mac, none expected")
            return

        agent = Agent(device_id=device_id, org_id=org_id, batch_id=batch_id)
        agent.rotate_key()
        db.add(agent)  # NO COMMIT YET – wait for /ack
        ack_expected = "register/ack"

        print(f"New agent {device_id} created (pending ack)")
        await ws.send_json({"action": "register", "serverKey": agent.server_key})

    # === Existing agent ===================================================
    else:
        # Verify MAC with current key
        expected = hmac_sha256(agent.server_key, challenge)
        if not hmac.compare_digest(expected, mac):
            print(f"Invalid MAC from {device_id}: expected {expected}, got {mac}")
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad key")
            return

        # Rotate key if required
        if agent.must_rotate_key():
            agent.rotate_key()       # updates key in-memory
            db.add(agent)            # NO COMMIT YET
            ack_expected = "rotate/ack"

            print(f"Rotating key for {device_id}, awaiting ack…")
            await ws.send_json({"action": "rotate", "newKey": agent.server_key})
        else:
            await ws.send_json({"action": "handshake/ok"})

    # ----------------------------------------------------------------------
    # STEP 2b – wait for /ack when a new key was issued
    # ----------------------------------------------------------------------
    if ack_expected is not None:
        try:
            ack_msg = await asyncio.wait_for(ws.receive_json(), timeout=30)
        except (asyncio.TimeoutError, WebSocketDisconnect):
            db.rollback()
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="ack timeout")
            return

        if ack_msg.get("action") != ack_expected:
            db.rollback()
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad ack")
            return

        # Ack OK → persist new key
        db.commit()
        print(f"{ack_expected} received – key persisted for {device_id}")

    # ----------------------------------------------------------------------
    # Fully authenticated – store socket and proceed
    # ----------------------------------------------------------------------
    active_sockets[device_id] = ws

    # ----------------------------------------------------------------------
    # STEP 3 – main receive loop (enveloped messages)
    # ----------------------------------------------------------------------
    try:
        while True:
            msg = await asyncio.wait_for(ws.receive_json(), timeout=60)

            # Basic schema check
            if not {"nonce", "payload", "mac"} <= msg.keys():
                await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad envelope")
                break

            data_to_check = f"{msg['nonce']}{canonical_dumps(msg['payload'])}"
            expected = hmac_sha256(agent.server_key, data_to_check)
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
            await ws.close()
