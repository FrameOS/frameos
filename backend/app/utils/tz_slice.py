"""Per-zone tzdata slices for the ESP32 (frameos/src/lib/tz.nim, fos_tz.h).

The full tzdata.json (frameos/assets/compiled/tz/tzdata.json, ~1.4 MB) is
what the Pi runtime embeds. An ESP32 keeps one zone: that zone's DST
transitions from the start of last year on, in the same
{"timezones": [...], "dstChanges": [...]} shape so chrono loads it unchanged
— about 1.5 KB for Europe/Brussels. The backend ships the slice with the
zone name on the embedded settings poll (timeZoneData) and bakes the frame's
zone into its firmware (FRAMEOS_DEFAULT_TZ_DATA); ../tz publishes the same
thing at https://tz.frameos.net/zone/<Zone>.json for frames that only know
a name.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
TZDATA_PATH = REPO_ROOT / "frameos" / "assets" / "compiled" / "tz" / "tzdata.json"
ALIASES_PATH = REPO_ROOT / "frameos" / "assets" / "compiled" / "tz" / "timezone_aliases.json"

# chrono's TimeZone.valid() is `id > 0`, so the slice's one zone is id 1.
SLICE_TZ_ID = 1
# How far a slice reaches: the whole previous calendar year (a frame whose
# clock is a little behind still resolves) through ten years ahead — tzdata
# itself runs to 2059, and a firmware that old will have pulled a fresh
# slice many times over. ~1.5 KB for an EU zone.
SLICE_YEARS_BACK = 1
SLICE_YEARS_AHEAD = 10

_lock = threading.Lock()
_data: Optional[dict[str, Any]] = None
_aliases: Optional[dict[str, str]] = None
_changes_by_zone: Optional[dict[str, list[dict[str, Any]]]] = None


def _load() -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    global _data, _aliases, _changes_by_zone
    with _lock:
        if _changes_by_zone is None:
            _data = json.loads(TZDATA_PATH.read_text(encoding="utf-8"))
            names = {int(tz["id"]): str(tz["name"]) for tz in _data.get("timezones", [])}
            by_zone: dict[str, list[dict[str, Any]]] = {name: [] for name in names.values()}
            for change in _data.get("dstChanges", []):
                name = names.get(int(change["tzId"]))
                if name is not None:
                    by_zone[name].append(change)
            for changes in by_zone.values():
                changes.sort(key=lambda c: float(c["start"]))
            _changes_by_zone = by_zone
            try:
                _aliases = {
                    str(k): str(v)
                    for k, v in json.loads(ALIASES_PATH.read_text(encoding="utf-8")).items()
                }
            except (OSError, ValueError):
                _aliases = {}
        return _changes_by_zone, _aliases or {}


def canonical_zone(zone: str) -> str:
    """The tzdata name for `zone`, following aliases ("Europe/Kiev" → "Europe/Kyiv")."""
    zone = (zone or "").strip()
    if not zone:
        return ""
    by_zone, aliases = _load()
    if zone in by_zone:
        return zone
    target = aliases.get(zone, "")
    return target if target in by_zone else ""


def slice_changes(
    changes: list[dict[str, Any]], from_epoch: float, to_epoch: Optional[float] = None
) -> list[dict[str, Any]]:
    """The transitions a slice carries: the last one at or before `from_epoch`
    (the offset in force when the slice starts) plus everything after it up
    to `to_epoch`."""
    before = [c for c in changes if float(c["start"]) <= from_epoch]
    after = [c for c in changes if float(c["start"]) > from_epoch and (to_epoch is None or float(c["start"]) < to_epoch)]
    head = before[-1:] if before else []
    return head + after


def tz_slice(zone: str, now: Optional[float] = None) -> Optional[dict[str, Any]]:
    """The slice for `zone` (aliases resolved; the slice keeps the name the
    caller used, which is what the device looks up), or None when tzdata
    does not know it. Deterministic for a given year, so ETags stay stable."""
    name = canonical_zone(zone)
    if not name:
        return None
    requested = (zone or "").strip()
    by_zone, _ = _load()
    if now is None:
        now = time.time()
    year = datetime.fromtimestamp(now, tz=timezone.utc).year
    from_epoch = datetime(year - SLICE_YEARS_BACK, 1, 1, tzinfo=timezone.utc).timestamp()
    to_epoch = datetime(year + SLICE_YEARS_AHEAD, 1, 1, tzinfo=timezone.utc).timestamp()
    changes = [
        {
            "tzId": SLICE_TZ_ID,
            "name": str(c["name"]),
            "start": float(c["start"]),
            "offset": int(c["offset"]),
        }
        for c in slice_changes(by_zone[name], from_epoch, to_epoch)
    ]
    return {"timezones": [{"id": SLICE_TZ_ID, "name": requested}], "dstChanges": changes}


def tz_slice_json(zone: str, now: Optional[float] = None) -> str:
    """`tz_slice` as compact JSON; "" for an unknown zone."""
    data = tz_slice(zone, now)
    return json.dumps(data, separators=(",", ":")) if data else ""
