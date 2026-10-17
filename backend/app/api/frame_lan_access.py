"""The frame's LAN access switch, from the workspace (app/utils/lan_access.py).

`POST /frames/{id}/lan_access/challenge` asks the frame to draw a code on
its panel:

    200 {"status": "shown", "expires_in_seconds": 300}
    200 {"status": "queued"}          an ESP32 that did not answer in time
                                      (asleep): the code shows when it wakes
    409 {"detail", "error": "no_panel"}     nothing to draw a code on
    409 {"detail", "error": "unsupported"}  FrameOS too old for the switch
    502/504 {"detail", "error"}             the frame did not answer

`POST /frames/{id}/lan_access` `{enabled: bool, code?: string}` sets it; on
needs the code from the panel, off goes straight through:

    200 {"status": "applied", "lan_access": bool}
    200 {"status": "queued"}
    400/403/500 {"detail", "error"}   the device's token (invalid_code, …)

Same paths and shapes as FrameOS Cloud's routes. A Linux frame (Raspberry
Pi OS, Buildroot, admin-API-only cards included) is asked over its own HTTP
API with the backend's serverApiKey bearer, once: never the admin-session
helper, whose retry on a 403 would burn one of the five code attempts. An
ESP32 gets the contract verb through its command queue. A virtual frame or a
thin client has no runtime of its own; the backend's renderer is what obeys
the switch there, so off is applied to the row and on is refused.
"""
from __future__ import annotations

import json
from http import HTTPStatus
from typing import Any, Optional

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.frame import Frame
from app.models.log import new_log
from app.redis import get_redis
from app.utils.embedded_commands import is_queued_embedded_frame, queue_embedded_command
from app.utils.frame_http import _fetch_frame_http_bytes
from app.utils.lan_access import (
    LAN_ACCESS_ACK_WAIT_SECONDS,
    LAN_ACCESS_CHALLENGE_SECONDS,
    LAN_ACCESS_CHALLENGE_VERB,
    LAN_ACCESS_SET_VERB,
    lan_access_refusal,
    mirror_lan_access,
    parse_lan_access_set_body,
)

from . import api_project
from .project_scope import project_get_or_404

# app/api/__init__.py star-imports every route module: only the routes.
__all__ = ["api_frame_lan_access_challenge", "api_frame_lan_access_set"]

DEVICE_CHALLENGE_PATH = "/api/network/local-access/challenge"
DEVICE_SET_PATH = "/api/network/local-access"
# A runtime from before the switch: no such route (404, 405), or the route
# exists but takes only an admin session (401).
_OLD_RUNTIME_STATUSES = frozenset({401, 404, 405})
_MAX_REQUEST_BYTES = 4096


def _refused(error: str, *, status: Optional[int] = None, detail: Optional[str] = None) -> JSONResponse:
    refusal = lan_access_refusal(error, status=status, detail=detail)
    return JSONResponse(status_code=refusal["status"], content={"detail": refusal["detail"], "error": refusal["error"]})


def _lan_access_target(frame: Frame) -> str:
    """Who answers for the switch: "linux", "esp32", "virtual" (the backend
    renders it, no device) or "thin_client" (a Pico: the backend renders
    what it shows)."""
    if (frame.mode or "rpios") != "embedded":
        return "linux"
    from app.tasks.embedded_firmware import embedded_platform_spec_for_frame

    try:
        family = embedded_platform_spec_for_frame(frame)["family"]
    except Exception:  # noqa: BLE001 - an unknown platform is still a device
        return "esp32"
    if family == "virtual":
        return "virtual"
    if family == "pico":
        return "thin_client"
    return "esp32"


def _no_code_on_this_frame(target: str) -> JSONResponse:
    if target == "virtual":
        return _refused("no_panel")
    return _refused("unsupported", detail="This frame cannot show a LAN access code.")


async def _relay_to_device(frame: Frame, redis: Redis, path: str, body: dict[str, Any]) -> tuple[int, Any]:
    """POST to the Linux runtime's local-access route: (status, parsed JSON
    or None). One attempt: a replayed set could meet a code the first one
    already used, and a replayed challenge replaces the code on the panel.
    Raises HTTPException(502/504) when the frame does not answer."""
    status, raw, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path=path,
        method="POST",
        body=json.dumps(body),
        headers={"Content-Type": "application/json"},
        attempts=1,
    )
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeDecodeError):
        parsed = None
    return status, parsed


def _unreachable(exc: HTTPException) -> JSONResponse:
    if exc.status_code in (HTTPStatus.REQUEST_TIMEOUT, HTTPStatus.GATEWAY_TIMEOUT):
        return _refused("timeout")
    detail = exc.detail if isinstance(exc.detail, str) and exc.detail else None
    return _refused("unreachable", detail=f"Could not reach the frame: {detail}" if detail else None)


def _device_refusal(status: int, parsed: Any) -> JSONResponse:
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(error, str) and error:
        return _refused(error)
    if status in _OLD_RUNTIME_STATUSES:
        return _refused("unsupported")
    return _refused("frame_error", detail=f"The frame answered HTTP {status}. Try again.")


def _queued_refusal(outcome: dict[str, Any]) -> Optional[JSONResponse]:
    """The answer for an ESP32 command that did not end in an ack, or None
    while it is simply still waiting for the frame."""
    if outcome.get("status") == "failed":
        return _refused(str(outcome.get("error") or "error"))
    command = outcome.get("command")
    if isinstance(command, dict) and command.get("status") == "expired":
        # Superseded or cancelled while the route waited.
        return _refused("timeout")
    return None


async def _request_object(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > _MAX_REQUEST_BYTES:
        raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="Body too large")
    try:
        body = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


@api_project.post("/frames/{id:int}/lan_access/challenge")
async def api_frame_lan_access_challenge(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = project_get_or_404(db, Frame, id, detail="Frame not found")
    target = _lan_access_target(frame)
    if target in ("virtual", "thin_client"):
        return _no_code_on_this_frame(target)
    if target == "esp32":
        if not is_queued_embedded_frame(frame):
            return _refused("unsupported")
        outcome = await queue_embedded_command(
            db, redis, frame, LAN_ACCESS_CHALLENGE_VERB, {}, wait_seconds=LAN_ACCESS_ACK_WAIT_SECONDS
        )
        if outcome.get("status") == "applied":
            return {"status": "shown", "expires_in_seconds": LAN_ACCESS_CHALLENGE_SECONDS}
        return _queued_refusal(outcome) or {"status": "queued"}

    try:
        status, parsed = await _relay_to_device(frame, redis, DEVICE_CHALLENGE_PATH, {"scope": "localNetwork"})
    except HTTPException as exc:
        return _unreachable(exc)
    if status != HTTPStatus.OK:
        return _device_refusal(status, parsed)
    seconds = parsed.get("expiresInSeconds") if isinstance(parsed, dict) else None
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds <= 0:
        seconds = LAN_ACCESS_CHALLENGE_SECONDS
    return {"status": "shown", "expires_in_seconds": int(seconds)}


@api_project.post("/frames/{id:int}/lan_access")
async def api_frame_lan_access_set(
    id: int,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = project_get_or_404(db, Frame, id, detail="Frame not found")
    payload, refusal = parse_lan_access_set_body(await _request_object(request))
    if payload is None:
        assert refusal is not None
        return _refused(refusal["error"], status=refusal["status"], detail=refusal["detail"])
    enabled = bool(payload["enabled"])
    target = _lan_access_target(frame)

    if target in ("virtual", "thin_client"):
        # No device holds the switch: the row is what the renderer reads.
        if enabled:
            return _no_code_on_this_frame(target)
        await _record_applied(db, redis, frame, False)
        return {"status": "applied", "lan_access": False}

    if target == "esp32":
        if not is_queued_embedded_frame(frame):
            return _refused("unsupported")
        outcome = await queue_embedded_command(
            db,
            redis,
            frame,
            LAN_ACCESS_SET_VERB,
            payload,
            detail="on" if enabled else "off",
            wait_seconds=LAN_ACCESS_ACK_WAIT_SECONDS,
        )
        if outcome.get("status") == "applied":
            db.refresh(frame)
            await _record_applied(db, redis, frame, enabled, log=False)
            return {"status": "applied", "lan_access": enabled}
        return _queued_refusal(outcome) or {"status": "queued"}

    try:
        status, parsed = await _relay_to_device(frame, redis, DEVICE_SET_PATH, {**payload, "scope": "localNetwork"})
    except HTTPException as exc:
        return _unreachable(exc)
    if status != HTTPStatus.OK:
        return _device_refusal(status, parsed)
    reported = parsed.get("allowLocalNetworkAccess") if isinstance(parsed, dict) else None
    value = reported if isinstance(reported, bool) else enabled
    await _record_applied(db, redis, frame, value)
    return {"status": "applied", "lan_access": value}


async def _record_applied(db: Session, redis: Redis, frame: Frame, value: bool, *, log: bool = True) -> None:
    """Mirror the new value and broadcast it. The ESP32 path's log lines come
    from its queue ("Frame applied: LAN access (on)")."""
    await mirror_lan_access(db, redis, frame, value)
    if log:
        await new_log(db, redis, int(frame.id), "stdinfo", f"LAN access turned {'on' if value else 'off'}")
