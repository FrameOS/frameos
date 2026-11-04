"""What an ESP32 says about itself that can change on the frame: its rotation,
Wi-Fi network and address (the panel on its screen, the console). The backend
never sends a Wi-Fi network back, so this is how its copy keeps up.

Kept under `embedded.reported`, beside `embedded.lastBoot`: the device's word,
never configuration, so a form loaded earlier cannot put an older one back
(frames.py) and the deploy drawer does not call it a change (frameLogic.ts).
The same three on the cloud are hello `hardware` fields (fos_cloud.c,
docs/cloud-frames.md). Never a password.
"""
from __future__ import annotations

import ipaddress
from typing import Any

from app.models.frame import Frame

ROTATIONS = (0, 90, 180, 270)
MAX_SSID_BYTES = 32


def _reported(embedded: dict[str, Any]) -> dict[str, Any]:
    reported = embedded.get("reported")
    return reported if isinstance(reported, dict) else {}


def valid_rotate(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value in ROTATIONS


def device_report(body: dict[str, Any]) -> dict[str, Any]:
    """The report in a device's commands pull, what is valid of it."""
    report: dict[str, Any] = {}
    if valid_rotate(body.get("rotate")):
        report["rotate"] = body["rotate"]
    ssid = body.get("wifiSsid")
    if isinstance(ssid, str) and len(ssid.encode()) <= MAX_SSID_BYTES:
        report["wifiSsid"] = ssid
    ip = body.get("ip")
    if isinstance(ip, str):
        try:
            ipaddress.ip_address(ip)
            report["ip"] = ip
        except ValueError:
            pass
    return report


def remember_device_report(frame: Frame, report: dict[str, Any], peer: str | None) -> bool:
    """The report onto the frame row; True when something changed. An address
    moves `frame_host` under the rule a bootup's does (`_accepted_boot_ip`:
    the claim must be the address the request came from): a frame that joins
    another network from its panel does not reboot, so it says no bootup."""
    from app.models.log import _accepted_boot_ip

    if not report:
        return False
    embedded = dict(frame.embedded or {})
    before = _reported(embedded)
    merged = {**before, **report}
    changed = merged != before
    if changed:
        embedded["reported"] = merged
    host = _accepted_boot_ip(frame, {"ip": report.get("ip")}, peer) if report.get("ip") else None
    if host:
        frame.frame_host = host
        last_boot = embedded.get("lastBoot")
        if isinstance(last_boot, dict):
            # What the backend reaches the board by (frame_http.py).
            embedded["lastBoot"] = {**last_boot, "ip": host}
        changed = True
    if changed:
        frame.embedded = embedded
    return changed


def adopt_first_rotate(frame: Frame, rotate: Any) -> bool:
    """The first time this backend hears from a frame, the frame's rotation
    stands: it may have been set on the frame's own panel before it was linked
    here, and the settings the frame is about to pull would turn it back and
    restart it. A frame provisioned from this row already holds the same. From
    then on the row is the truth. True when the row took it."""
    embedded = dict(frame.embedded or {})
    if isinstance(embedded.get("reported"), dict) or not valid_rotate(rotate):
        return False
    embedded["reported"] = {"rotate": rotate}
    frame.embedded = embedded
    frame.rotate = rotate
    return True


def reported_network_warning(frame: Frame, wifi_ssid: str) -> str | None:
    """The provisioning plan's word when what it would send is not the network
    the frame says it is on: joined from its panel, which this row never hears
    the password of."""
    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    on = _reported(embedded).get("wifiSsid")
    if not isinstance(on, str) or not on or on == wifi_ssid:
        return None
    if wifi_ssid:
        return (
            f"The frame last said it is on the Wi-Fi network “{on}”, and flashing it sends “{wifi_ssid}”. "
            "Change the frame's Wi-Fi settings first to keep it on the network it is on."
        )
    return (
        f"The frame last said it is on the Wi-Fi network “{on}”, and this frame has no Wi-Fi network set here. "
        "Set it in the frame's Wi-Fi settings first, or join it again on the frame's screen after flashing."
    )
