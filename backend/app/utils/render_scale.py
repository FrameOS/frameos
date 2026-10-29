"""The frame's render scale (frame.json ``renderScale``, the ``render_scale``
column and cloud settings key).

A UI from a .tsx or .jsx app is laid out for a panel this many times smaller
and drawn sharp at full size, so a scene made for an 800x480 screen fills a
1600x1200 one. 0 is automatic: the runtime takes the panel's shorter edge over
600 px in quarter steps, at least 1 (``frameos/src/frameos/render_scale.nim``,
``frontend/src/utils/renderScale.ts``). A scene's own ``settings.renderScale``
or a field with ``role: "renderScale"`` wins over it on the device.

The contract's rule (docs/cloud-frames-contract.json ``render_scale``) is a
number from 0 to 4, fractions allowed.
"""

from __future__ import annotations

import math
from typing import Any

MAX_RENDER_SCALE = 4.0


def normalize_render_scale(value: Any) -> float:
    """The stored scale as the device reads it: a number in (0, 4], or 0
    (automatic) for anything else, unset included."""
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        scale = float(value.strip() if isinstance(value, str) else value)
    except (TypeError, ValueError):
        return 0.0
    return scale if math.isfinite(scale) and 0.0 < scale <= MAX_RENDER_SCALE else 0.0
