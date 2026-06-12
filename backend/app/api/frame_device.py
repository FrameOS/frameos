"""Endpoints the frames themselves talk to.

Two flows live here:

* **Adoption** — a standalone frame (installed from an SD image or the
  bootstrap script, never connected to a backend) joins this backend. The
  user generates a short-lived adoption code in the backend UI, types the
  backend URL + code into the frame's own admin page, and the frame claims
  the code here. The backend creates the frame record and hands back the
  credentials (serverApiKey + agentSharedSecret) the frame needs to connect.

* **Self-requested updates** — a frame's on-device admin can ask the backend
  to deploy a fresh FrameOS or agent build to it. The backend runs its normal
  deploy pipeline (binaries built/downloaded by the backend, new release
  folder on the device, recorded in the backend), so the device never
  installs unsigned bits from arbitrary URLs.
"""
from __future__ import annotations

import json
import secrets
from http import HTTPStatus

from arq import ArqRedis as Redis
from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.frame import Frame
from app.models.log import new_log as log
from app.redis import get_redis
from app.tenancy import current_project_context
from app.utils.request_ip import extract_client_ip
from app.utils.token import secure_token
from app.websockets import publish_message

from . import api_project, api_public

ADOPTION_CODE_TTL_SECONDS = 15 * 60
ADOPTION_CODE_REDIS_PREFIX = "frame_adopt:"


def _frame_from_bearer(db: Session, authorization: str | None) -> Frame:
    if not authorization:
        raise HTTPException(status_code=401, detail="Unauthorized")
    parts = authorization.split(" ")
    if len(parts) != 2:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")
    frame = db.query(Frame).filter_by(server_api_key=parts[1]).first()
    if not frame:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return frame


class AdoptionCodeResponse(BaseModel):
    code: str
    expires_in: int


@api_project.post("/frames/adoption_code", response_model=AdoptionCodeResponse)
async def api_frame_adoption_code(
    redis: Redis = Depends(get_redis),
):
    """Generates a short-lived, single-use code a standalone frame can use to
    join this backend (entered on the frame's own admin page)."""
    context = current_project_context()
    code = "-".join(secrets.token_hex(2) for _ in range(2)).upper()  # e.g. A1B2-C3D4
    await redis.set(
        f"{ADOPTION_CODE_REDIS_PREFIX}{code}",
        json.dumps({"project_id": context.project_id}),
        ex=ADOPTION_CODE_TTL_SECONDS,
    )
    return AdoptionCodeResponse(code=code, expires_in=ADOPTION_CODE_TTL_SECONDS)


class FrameAdoptRequest(BaseModel):
    code: str
    name: str | None = None
    mode: str | None = None
    device: str | None = None
    width: int | None = None
    height: int | None = None
    frame_port: int | None = Field(default=None, alias="framePort")
    frame_access: str | None = Field(default=None, alias="frameAccess")
    frame_access_key: str | None = Field(default=None, alias="frameAccessKey")
    frame_host: str | None = Field(default=None, alias="frameHost")
    frameos_version: str | None = Field(default=None, alias="frameosVersion")

    model_config = {"populate_by_name": True}


@api_public.post("/frame_device/adopt")
async def api_frame_device_adopt(
    data: FrameAdoptRequest,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Called by a frame to join this backend using an adoption code."""
    code = (data.code or "").strip().upper()
    if not code:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Missing adoption code")

    redis_key = f"{ADOPTION_CODE_REDIS_PREFIX}{code}"
    stored = await redis.get(redis_key)
    if not stored:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Invalid or expired adoption code")
    await redis.delete(redis_key)  # single use
    project_id = json.loads(stored)["project_id"]

    client_ip = extract_client_ip(
        request.headers,
        request.client.host if request.client else None,
    )
    frame_host = (data.frame_host or "").strip() or client_ip or "localhost"

    server_api_key = secure_token(32)
    agent_shared_secret = secure_token(32)

    frame = Frame(
        project_id=project_id,
        name=(data.name or "").strip() or f"Adopted frame ({frame_host})",
        mode=data.mode if data.mode in ("rpios", "buildroot") else "rpios",
        frame_host=frame_host,
        frame_port=data.frame_port or 8787,
        frame_access=data.frame_access or "private",
        frame_access_key=data.frame_access_key or secure_token(20),
        device=data.device or "web_only",
        width=data.width,
        height=data.height,
        server_api_key=server_api_key,
        server_send_logs=True,
        agent={
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": agent_shared_secret,
            "deployWithAgent": True,
        },
        status="ready",
        version=data.frameos_version,
        scenes=[],
        interval=300,
        metrics_interval=60,
        scaling_mode="contain",
        rotate=0,
        background_color="#ffffff",
    )
    db.add(frame)
    db.commit()
    await publish_message(redis, "new_frame", frame.to_dict())
    await log(db, redis, frame.id, "stdout",
              f"Frame adopted from {client_ip or 'unknown ip'} using an adoption code")

    return {
        "frameId": frame.id,
        "serverApiKey": server_api_key,
        "agentSharedSecret": agent_shared_secret,
    }


class FrameUpdateRequestBody(BaseModel):
    target: str = "frameos"  # "frameos" | "agent"


@api_public.post("/frame_device/request_update")
async def api_frame_device_request_update(
    data: FrameUpdateRequestBody,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    authorization: str = Header(None),
):
    """Called by a frame (authenticated with its serverApiKey) when the user
    presses "update" on the frame's own admin page. The backend runs its
    regular deploy pipeline, producing a new release on the device."""
    frame = _frame_from_bearer(db, authorization)

    if data.target not in ("frameos", "agent"):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Unknown update target")
    if frame.status == "deploying":
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="A deploy is already running")

    if data.target == "agent":
        from app.tasks import deploy_agent
        await deploy_agent(frame.id, redis)
        message = "Frame requested an agent update from its admin page; agent deploy queued"
    else:
        from app.tasks import deploy_frame
        await deploy_frame(frame.id, redis)
        message = "Frame requested a FrameOS update from its admin page; deploy queued"

    await log(db, redis, frame.id, "stdout", message)
    return {"status": "queued", "target": data.target}
