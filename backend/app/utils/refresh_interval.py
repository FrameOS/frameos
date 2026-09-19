"""The scene's refresh interval as a state field.

Every scene has one state key that holds "seconds between renders": a field
with ``role: "refreshInterval"`` (the first one wins), else a field literally
named ``refreshInterval``, else an implicit public field seeded from
``settings.refreshInterval``. Whichever it is, it is listed last.

The same rules live in ``frameos/src/frameos/refresh_interval.nim`` (the
runtime) and ``frontend/src/utils/refreshInterval.ts`` (every control
surface); keep them in step.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

REFRESH_INTERVAL_ROLE = "refreshInterval"
REFRESH_INTERVAL_FIELD_NAME = "refreshInterval"
REFRESH_INTERVAL_LABEL = "Refresh interval (seconds)"
DEFAULT_REFRESH_INTERVAL_SECONDS = 300.0


def parse_refresh_seconds(value: Any) -> float:
    """A positive, finite number of seconds, or 0 for anything else."""
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        seconds = float(value.strip() if isinstance(value, str) else value)
    except (TypeError, ValueError):
        return 0.0
    return seconds if math.isfinite(seconds) and seconds > 0 else 0.0


def refresh_interval_field_index(fields: list[dict]) -> int:
    for index, field in enumerate(fields):
        if isinstance(field, dict) and field.get("role") == REFRESH_INTERVAL_ROLE:
            return index
    for index, field in enumerate(fields):
        if isinstance(field, dict) and field.get("name") == REFRESH_INTERVAL_FIELD_NAME:
            return index
    return -1


@dataclass
class ResolvedRefreshInterval:
    fields: list[dict]  # every field, the refresh interval one last
    key: str  # the state key that holds the interval
    default_seconds: float  # what the scene ships with
    implicit: bool  # the field was added here, not declared by the scene


def resolve_refresh_interval(fields: list[dict] | None, settings_seconds: Any) -> ResolvedRefreshInterval:
    fields = [field for field in (fields or []) if isinstance(field, dict)]
    settings_default = parse_refresh_seconds(settings_seconds) or DEFAULT_REFRESH_INTERVAL_SECONDS
    index = refresh_interval_field_index(fields)
    if index < 0:
        implicit = {
            "name": REFRESH_INTERVAL_FIELD_NAME,
            "label": REFRESH_INTERVAL_LABEL,
            "type": "float",
            # "900", not "900.0": the same text the frontend seeds the input with
            "value": str(int(settings_default)) if settings_default.is_integer() else str(settings_default),
            "persist": "disk",
            "access": "public",
            "role": REFRESH_INTERVAL_ROLE,
        }
        return ResolvedRefreshInterval([*fields, implicit], REFRESH_INTERVAL_FIELD_NAME, settings_default, True)
    field = fields[index]
    ordered = [other for i, other in enumerate(fields) if i != index] + [field]
    declared = parse_refresh_seconds(field.get("value"))
    return ResolvedRefreshInterval(ordered, str(field.get("name", "")), declared or settings_default, False)
