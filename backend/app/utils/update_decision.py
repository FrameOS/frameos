"""The update decision (docs/auto-updates.md): given the update manifest
(docs/update-manifest.json) and a frame — the version it runs, its platform
and target, its cohort key, its channel — which version may it install now?

One rule, three ports pinned by docs/update-decision-fixtures.json:
this file, the cloud's ``src/lib/update-decision.ts`` and the Linux
runtime's ``frameos/src/frameos/update_decision.nim`` (for a frame with no
control plane). An ESP32 never runs it: it asks its plane, or the cloud's
public ``/api/updates/firmware`` when it has none. Change the three and the
corpus together.

The answer:
  version  what to install now, or None
  reason   latest | stepping_stone | held_back   (version set)
           up_to_date | held | paused | unknown_version   (version None)
  latest   the newest release this frame could ever be offered (its channel,
           its target, under the ceiling), blocked or not, or None
  held     why ``latest`` is not the answer: {version, why, detail} with why
           one of blocked | scheduled | rollout | needs | paused; None when
           the answer is the latest or the frame is up to date
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone
from typing import Any, Optional

CHANNELS = ("stable", "early")
BUCKETS = 10000


def parse_version(value: Any) -> Optional[tuple[int, int, int]]:
    """``2026.11.13`` (a leading ``v`` and a ``+build`` suffix allowed) as a
    tuple, or None for anything else ("dev", "unknown", two fields)."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.startswith("v"):
        text = text[1:]
    text = text.split("+", 1)[0]
    parts = text.split(".")
    if len(parts) != 3:
        return None
    out: list[int] = []
    for part in parts:
        if not (part.isascii() and part.isdigit()) or len(part) > 9:
            return None
        out.append(int(part))
    return (out[0], out[1], out[2])


def _version_text(parsed: tuple[int, int, int]) -> str:
    return f"{parsed[0]}.{parsed[1]}.{parsed[2]}"


def parse_time(value: Any) -> Optional[float]:
    """An ISO 8601 time (``Z`` or an offset; a bare one is UTC) as unix seconds."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def cohort_bucket(frame_key: str, version: str) -> int:
    """0 … 9999: where this frame stands in the rollout of ``version``.
    Salted by the version, so the first tenth of one release is not the
    first tenth of the next."""
    digest = hashlib.sha256(f"{frame_key}/{version}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % BUCKETS


def cohort_threshold(percent: float) -> int:
    """The buckets below this are in a rollout at ``percent``."""
    return int(math.floor(percent * BUCKETS / 100.0 + 0.5))


def pattern_matches(pattern: Any, key: str) -> bool:
    if not isinstance(pattern, str) or not pattern:
        return False
    if pattern.endswith("*"):
        return key.startswith(pattern[:-1])
    return pattern == key


def rollout_percent(release: dict[str, Any], default_rollout: Any, now: float) -> float:
    """How far the release's rollout has come at ``now``: the largest stage
    percent whose time has come, frozen at ``pausedAt``. No stages = 100."""
    stages = release.get("rollout")
    if not isinstance(stages, list):
        stages = default_rollout if isinstance(default_rollout, list) else []
    start = parse_time(release.get("at"))
    if start is None:
        return 0.0
    moment = now
    paused_at = parse_time(release.get("pausedAt"))
    if paused_at is not None and paused_at < moment:
        moment = paused_at
    if moment < start:
        return 0.0
    if not stages:
        return 100.0
    percent = 0.0
    for stage in stages:
        if not isinstance(stage, dict):
            continue
        after = stage.get("afterHours", 0)
        value = stage.get("percent", 0)
        if not isinstance(after, (int, float)) or isinstance(after, bool):
            continue
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        if start + float(after) * 3600.0 <= moment:
            percent = max(percent, float(value))
    return max(0.0, min(100.0, percent))


def _blocked_reason(release: dict[str, Any], key: str) -> Optional[str]:
    blocked = release.get("blocked")
    if isinstance(blocked, str) and blocked:
        return blocked
    if blocked is True:
        return "blocked"
    targets = release.get("blockedTargets")
    if isinstance(targets, dict):
        for pattern, reason in targets.items():
            if pattern_matches(pattern, key):
                return reason if isinstance(reason, str) and reason else "blocked for this target"
    return None


def _visible(release: dict[str, Any], key: str, channel: str) -> bool:
    channels = release.get("channels")
    if isinstance(channels, list) and channel not in channels:
        return False
    targets = release.get("targets")
    if isinstance(targets, list) and not any(pattern_matches(p, key) for p in targets):
        return False
    return True


def decide_update(manifest: Any, request: dict[str, Any]) -> dict[str, Any]:
    """The decision for one frame. ``request``: current, platform, target,
    frameKey, channel ("stable" | "early"; anything else is stable), manual
    (an owner asked: the rollout is skipped, blocks and stepping stones are
    not), now (ISO time), maxVersion (a ceiling, e.g. a backend's own
    version: releases above it do not exist for this frame)."""
    manifest = manifest if isinstance(manifest, dict) else {}
    releases_raw = manifest.get("releases") if isinstance(manifest.get("releases"), list) else []
    platform = str(request.get("platform") or "")
    target = str(request.get("target") or "")
    key = f"{platform}/{target}"
    channel = str(request.get("channel")) if request.get("channel") in CHANNELS else "stable"
    manual = bool(request.get("manual"))
    frame_key = str(request.get("frameKey") or "")
    now = parse_time(request.get("now"))
    if now is None:
        now = datetime.now(timezone.utc).timestamp()
    ceiling = parse_version(request.get("maxVersion")) if request.get("maxVersion") else None

    releases: list[tuple[tuple[int, int, int], dict[str, Any]]] = []
    seen: set[tuple[int, int, int]] = set()
    for release in releases_raw:
        if not isinstance(release, dict):
            continue
        parsed = parse_version(release.get("version"))
        if parsed is None or parsed in seen:
            continue
        if ceiling is not None and parsed > ceiling:
            continue
        if not _visible(release, key, channel):
            continue
        seen.add(parsed)
        releases.append((parsed, release))
    releases.sort(key=lambda item: item[0])

    latest = releases[-1][0] if releases else None
    latest_text = _version_text(latest) if latest else None
    current = parse_version(request.get("current"))

    def answer(version: Optional[str], reason: str, held: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        return {"version": version, "reason": reason, "latest": latest_text, "held": held}

    if current is None:
        return answer(None, "unknown_version")
    if latest is None or latest <= current:
        return answer(None, "up_to_date")
    paused = manifest.get("paused")
    if isinstance(paused, str) and paused:
        return answer(None, "paused", {"version": latest_text, "why": "paused", "detail": paused})

    def min_from(index: int) -> Optional[tuple[int, int, int]]:
        parsed, release = releases[index]
        floor = parse_version(release.get("minFrom"))
        for earlier, other in releases[:index]:
            if other.get("steppingStone") is True and (floor is None or earlier > floor):
                floor = earlier
        return floor

    def hold(index: int) -> Optional[dict[str, Any]]:
        parsed, release = releases[index]
        text = _version_text(parsed)
        blocked = _blocked_reason(release, key)
        if blocked:
            return {"version": text, "why": "blocked", "detail": blocked}
        start = parse_time(release.get("at"))
        if start is None or start > now:
            return {"version": text, "why": "scheduled", "detail": f"rolls out from {release.get('at')}"}
        if not manual and channel != "early":
            percent = rollout_percent(release, manifest.get("defaultRollout"), now)
            in_cohort = percent >= 100.0 or (
                frame_key != "" and cohort_bucket(frame_key, text) < cohort_threshold(percent)
            )
            if not in_cohort:
                return {
                    "version": text,
                    "why": "rollout",
                    "detail": f"rolling out to {percent:g}% of frames; this one is in a later stage",
                }
        floor = min_from(index)
        if floor is not None and current < floor:
            return {"version": text, "why": "needs", "detail": f"needs {_version_text(floor)} first"}
        return None

    latest_hold = hold(len(releases) - 1)
    if latest_hold is None:
        return answer(latest_text, "latest")
    for index in range(len(releases) - 2, -1, -1):
        parsed = releases[index][0]
        if parsed <= current:
            break
        if hold(index) is None:
            reason = "stepping_stone" if latest_hold["why"] == "needs" else "held_back"
            return answer(_version_text(parsed), reason, latest_hold)
    return answer(None, "held", latest_hold)
