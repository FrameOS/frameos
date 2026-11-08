"""Where an ESP32 is now, from its commands pull: a frame that joins another
Wi-Fi network on its own screen (docs/scene-settings.md "The frame page") does
not reboot, so it says no `bootup`, and the backend would keep reaching for
its old address.

The address only. The network's name never leaves the frame: the backend has
no use for it, and the cloud is not told either.
"""
from __future__ import annotations

import ipaddress
from typing import Any

from app.models.frame import Frame


def reported_address(body: dict[str, Any]) -> str | None:
    """The address in a device's commands pull, when it is one."""
    ip = body.get("ip")
    if not isinstance(ip, str):
        return None
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return None
    return ip


def follow_device_address(frame: Frame, ip: str | None, peer: str | None) -> bool:
    """`frame_host` moves to `ip` under the rule a bootup's does
    (`_accepted_boot_ip`: the claim must be the address the request came from,
    and a real hostname stays). True when the row changed."""
    from app.models.log import _accepted_boot_ip

    if not ip:
        return False
    host = _accepted_boot_ip(frame, {"ip": ip}, peer)
    if not host or host == frame.frame_host:
        return False
    frame.frame_host = host
    embedded = dict(frame.embedded or {})
    last_boot = embedded.get("lastBoot")
    if isinstance(last_boot, dict):
        # What the backend reaches the board by (frame_http.py).
        embedded["lastBoot"] = {**last_boot, "ip": host}
        frame.embedded = embedded
    return True
