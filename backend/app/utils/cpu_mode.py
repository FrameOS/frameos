"""The frame's processor speed (the contract's ``cpu_mode``, docs/cloud-frames-contract.json).

``auto`` | ``battery`` | ``performance``. A backend keeps it in the frame's
``device_config`` as ``cpuMode`` whatever the frame runs (a USB-console
provisioning writes ``cpu_mode``), and it reaches the frame two ways:

- an ESP32 reads it off its settings pull (``embedded_frame_settings``) and
  sets the chip's clock at boot (160 or 240 MHz);
- a Linux frame (a Raspberry Pi) gets it in frame.json as ``cpuMode`` with its
  next deploy and sets the kernel's CPU frequency governor live
  (``frameos/src/frameos/cpu_governor.nim``: battery is powersave,
  performance is performance, auto is ondemand).

Present-only: unset is ``auto`` on both.
"""

from __future__ import annotations

from typing import Any, Optional

CPU_MODES = ("auto", "battery", "performance")


def device_config_cpu_mode(device_config: Any) -> Optional[str]:
    """The mode the device_config names, either spelling, or None when it
    names none the contract knows."""
    if not isinstance(device_config, dict):
        return None
    for key in ("cpuMode", "cpu_mode"):
        value = device_config.get(key)
        if isinstance(value, str) and value in CPU_MODES:
            return value
    return None
