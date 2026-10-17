"""LAN access, the frame-level switch: when it is off, scene HTTP on the frame
may not reach private/local addresses.

The device holds the truth (state/local_access.json on Linux, NVS
`lan_access` on an ESP32) and the backend mirrors it in `frame.lan_access`,
which is also the creation seed (frame.json `network.lanAccess`, the ESP32
provisioning plan) and the switch the backend's own renderer obeys for frames
it renders (virtual frames, thin clients). Turning it ON is verified on the
device: `lan_access_challenge` draws a six-digit code on the panel and
`lan_access_set {enabled: true, code}` checks it there. Turning it OFF needs
no code. Verbs and tokens: docs/cloud-frames-contract.json.

The refusal table and the body rules are the cloud's
(cloud/apps/auth-web/src/lib/frame-lan-access.ts): the shared SPA calls the
same routes on both control planes and shows `detail` inline.

The code is never logged and never kept: it rides the request to the device,
or the ESP32's queued command until the device answers
(frame_commands.SECRET_PAYLOAD_KEYS).
"""
from __future__ import annotations

import re
from typing import Any, Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame, update_frame

LAN_ACCESS_CHALLENGE_VERB = "lan_access_challenge"
LAN_ACCESS_SET_VERB = "lan_access_set"
# The device's challenge lifetime (both runtimes); reported when the device
# does not say.
LAN_ACCESS_CHALLENGE_SECONDS = 300
# How long a route waits for an awake ESP32's ack before answering `queued`.
LAN_ACCESS_ACK_WAIT_SECONDS = 15.0

# What each token means to the person at the screen.
REFUSALS: dict[str, tuple[int, str]] = {
    # The device answered unknown_verb / unsupported_verb, or 401/404 from a
    # runtime that predates the switch.
    "unsupported": (409, "Update this frame's FrameOS first."),
    "no_panel": (409, "This frame has no screen to show a code on."),
    "invalid_lan_access": (400, "Choose whether LAN access is on or off."),
    "code_required": (403, "Enter the code showing on the frame."),
    "invalid_code": (403, "That code is not right. Check the frame and try again."),
    "code_expired": (403, "That code has expired. Show a new code on the frame."),
    "too_many_attempts": (403, "Too many wrong codes. Show a new code on the frame."),
    # The device's wrong-code budget (10 an hour) is spent: no new code
    # either, until the hour has passed.
    "rate_limited": (429, "Too many wrong codes in the last hour. Try again later."),
    "persist_failed": (500, "The frame could not save the setting. Try again."),
    # The device could not make a code (no entropy source).
    "challenge_failed": (500, "The frame could not make a code. Try again."),
    "timeout": (504, "The frame did not answer in time. Try again."),
    "unreachable": (502, "Could not reach the frame. Check that it is on and try again."),
}
UNSUPPORTED_DEVICE_ERRORS = frozenset({"unknown_verb", "unsupported_verb"})
_TOKEN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_CODE = re.compile(r"^\d{6}$")


def lan_access_refusal(error: str, *, status: Optional[int] = None, detail: Optional[str] = None) -> dict[str, Any]:
    """`{status, error, detail}` for a token. A device error outside the table
    travels as itself when it looks like a token (so a new one is still
    named); anything else is not echoed."""
    if error in UNSUPPORTED_DEVICE_ERRORS:
        error = "unsupported"
    known = REFUSALS.get(error)
    if known is not None:
        return {"status": status or known[0], "error": error, "detail": detail or known[1]}
    return {
        "status": status or 502,
        "error": error if _TOKEN.match(error or "") else "frame_error",
        "detail": detail or "The frame could not do that right now. Try again.",
    }


def parse_lan_access_set_body(body: Any) -> tuple[Optional[dict[str, Any]], Optional[dict[str, Any]]]:
    """The body of POST /frames/{id}/lan_access, `{enabled: bool, code?}`, as
    (payload for the device, None) or (None, refusal). The code is checked for
    shape here so a typo does not burn one of the device's five attempts;
    whitespace anywhere is dropped ("123 456"). A code sent with
    `enabled: false` is not forwarded: turning off needs none."""
    body = body if isinstance(body, dict) else {}
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        return None, lan_access_refusal("invalid_lan_access")
    if not enabled:
        return {"enabled": False}, None
    code = body.get("code")
    if code is None:
        return None, lan_access_refusal("code_required", status=400)
    if not isinstance(code, str):
        return None, lan_access_refusal("invalid_code", status=400, detail="Enter the 6-digit code showing on the frame.")
    code = re.sub(r"\s+", "", code)
    if not code:
        return None, lan_access_refusal("code_required", status=400)
    if not _CODE.match(code):
        return None, lan_access_refusal("invalid_code", status=400, detail="Enter the 6-digit code showing on the frame.")
    return {"enabled": True, "code": code}, None


def reported_lan_access(body: Any) -> Optional[bool]:
    """The switch a device message reports: the top-level `lan_access` of an
    ESP32 hello / ack (its state fields) or of the Linux runtime's
    `GET /api/frames/{id}` payload, else `hardware.lanAccess`. None when the
    message does not say (older firmware)."""
    if not isinstance(body, dict):
        return None
    value = body.get("lan_access")
    if isinstance(value, bool):
        return value
    hardware = body.get("hardware")
    if isinstance(hardware, dict) and isinstance(hardware.get("lanAccess"), bool):
        return bool(hardware["lanAccess"])
    return None


async def mirror_lan_access(db: Session, redis: Redis, frame: Frame, value: Optional[bool]) -> bool:
    """Store what the device says its switch is, and broadcast the frame so
    the workspace's copy follows. A no-op (False) for None or no change."""
    if value is None or (frame.lan_access is not None and bool(frame.lan_access) == value):
        return False
    frame.lan_access = value
    await update_frame(db, redis, frame)
    return True
