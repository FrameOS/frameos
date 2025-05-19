# backend/app/api/agents.py
"""
REST API endpoints for managing Frame OS *agents* (the physical devices that
connect to `/ws/agent`).  Each change is broadcast on Redis via
`publish_message`, mirroring the behaviour of the frames API:

• “new_agent”    — emitted after creating a new Agent row
• “update_agent” — emitted after mutating an existing Agent row
• “delete_agent” — emitted after removing an Agent row

The `active_sockets` mapping from `app.ws.agent_ws` is used to mark which
agents are currently connected.
"""

from __future__ import annotations

from datetime import datetime, timezone
from http import HTTPStatus
from typing import List, Optional, Dict, Any

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.redis import get_redis
from app.websockets import publish_message
from app.models.agent import Agent
from app.ws.agent_ws import active_sockets
from . import api_with_auth


# ────────────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ────────────────────────────────────────────────────────────────────────────

class AgentInfo(BaseModel):
    id: str
    org_id: str
    batch_id: str
    device_id: str
    server_key_version: int = Field(..., description="Monotonic counter increased on each key rotation")
    last_seen: Optional[str] = Field(None, description="ISO-8601 timestamp (UTC)")
    connected: bool = False
    frame_id: Optional[int] = None


class AgentsListResponse(BaseModel):
    agents: List[AgentInfo]


class AgentResponse(BaseModel):
    agent: AgentInfo


class AgentStatusResponse(BaseModel):
    connected: bool
    last_seen: Optional[str] = None


class AgentRotateKeyResponse(BaseModel):
    message: str


class AgentCreateRequest(BaseModel):
    org_id: str
    batch_id: str
    device_id: str
    frame_id: Optional[int] = None


class AgentUpdateRequest(BaseModel):
    org_id: Optional[str] = None
    batch_id: Optional[str] = None
    device_id: Optional[str] = None
    frame_id: Optional[int] = None


# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────

def _agent_to_dict(agent: Agent) -> Dict[str, Any]:
    """Convert an Agent SQLAlchemy row into a plain dict for JSON."""
    return {
        "id":                   agent.id,
        "org_id":               agent.org_id,
        "batch_id":             agent.batch_id,
        "device_id":            agent.device_id,
        "server_key_version":   agent.server_key_version,
        "last_seen":            agent.last_seen.replace(tzinfo=timezone.utc).isoformat()
                                if agent.last_seen else None,
        "connected":            agent.device_id in active_sockets,
        "frame_id":             agent.frame_id,
    }


# ────────────────────────────────────────────────────────────────────────────
# CRUD end-points
# ────────────────────────────────────────────────────────────────────────────

@api_with_auth.get("/agents", response_model=AgentsListResponse)
async def api_agents_list(db: Session = Depends(get_db)):
    agents = db.query(Agent).all()
    return {"agents": [_agent_to_dict(a) for a in agents]}


@api_with_auth.get("/agents/{agent_id}", response_model=AgentResponse)
async def api_agent_get(agent_id: str, db: Session = Depends(get_db)):
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Agent not found")
    return {"agent": _agent_to_dict(agent)}


@api_with_auth.post("/agents/new", response_model=AgentResponse)
async def api_agent_new(
    data: AgentCreateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    agent = Agent(
        org_id=data.org_id,
        batch_id=data.batch_id,
        device_id=data.device_id,
        frame_id=data.frame_id,
    )
    db.add(agent)
    db.commit()

    agent_dict = _agent_to_dict(agent)
    await publish_message(redis, "new_agent", agent_dict)

    return {"agent": agent_dict}


@api_with_auth.post("/agents/{agent_id}", response_model=AgentResponse)
async def api_agent_update(
    agent_id: str,
    data: AgentUpdateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Agent not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(agent, field, value)

    db.add(agent)
    db.commit()

    agent_dict = _agent_to_dict(agent)
    await publish_message(redis, "update_agent", agent_dict)

    return {"agent": agent_dict}


@api_with_auth.delete("/agents/{agent_id}")
async def api_agent_delete(
    agent_id: str,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Agent not found")

    db.delete(agent)
    db.commit()

    await publish_message(redis, "delete_agent", {"id": agent_id})
    return {"message": "Agent deleted successfully"}


# ────────────────────────────────────────────────────────────────────────────
# Misc utilities
# ────────────────────────────────────────────────────────────────────────────

@api_with_auth.get("/agents/{agent_id}/status", response_model=AgentStatusResponse)
async def api_agent_status(agent_id: str, db: Session = Depends(get_db)):
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Agent not found")
    return {
        "connected": agent.device_id in active_sockets,
        "last_seen": agent.last_seen.replace(tzinfo=timezone.utc).isoformat()
                     if agent.last_seen else None,
    }


@api_with_auth.post("/agents/{agent_id}/rotate_key", response_model=AgentRotateKeyResponse)
async def api_agent_rotate_key(
    agent_id: str,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """
    Trigger a key-rotation for the agent.

    • If the device is **online** we emit a `/rotate` message over the live
      WebSocket and wait for the agent’s `/rotate/ack` (handled in
      `app.ws.agent_ws`).  The DB commit is performed there.

    • If the device is **offline** we revoke the current key immediately,
      forcing a rotation on the next connection.
    """
    from app.ws.agent_ws import active_sockets  # avoid circular import at module load

    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Agent not found")

    online = agent.device_id in active_sockets

    if online:
        ws = active_sockets[agent.device_id]
        agent.rotate_key()  # new key (no commit yet – will happen after /ack)

        try:
            await ws.send_json({"action": "rotate", "newKey": agent.server_key})
        except Exception as exc:
            agent.server_key_revoked_at = datetime.utcnow()
            db.add(agent)
            db.commit()
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"Failed to send rotate command: {exc}",
            )

        await publish_message(redis, "update_agent", _agent_to_dict(agent))
        return {"message": "Rotate command sent; waiting for acknowledgement"}

    # ── Offline ────────────────────────────────────────────────────────────
    agent.server_key_revoked_at = datetime.utcnow()
    db.add(agent)
    db.commit()

    await publish_message(redis, "update_agent", _agent_to_dict(agent))
    return {"message": "Agent offline – key revoked; a new key will be issued on next connect"}
