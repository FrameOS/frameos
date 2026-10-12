"""The frame row's `deploy_progress`: how far a deploy, update, restart or
reboot has come, from the click to the first render on the new code.

The contract is docs/deploy-progress-contract.json (prose:
docs/deploy-progress.md; corpus: docs/deploy-progress-fixtures.json), and
the tables here come from it (deploy_progress_gen.py). The cloud's
lib/deploy-progress.ts is the sibling fold; the shared workspace draws the
bar from the same tables (frontend/src/decorators/frame.tsx).

One record per frame, replaced by the next deploy. Two ways it moves:

  advance(record, stage)        the control plane's own step: forward only,
                                along the kind's stage list.
  fold(record, signal)          something observed: a device log line
                                (`bootup`, `render:done`, an `ota:*` line),
                                a command-queue state change, the hub's
                                hello. The current stage's `on` table says
                                where it leads; a signal it does not list is
                                ignored, so a late line from the previous
                                runtime cannot move the record.

The record never expires itself: `at` is what a reader compares with the
stage's `staleAfterSeconds` (is_running). models/log.py folds the device
lines; the deploy tasks advance; app/utils/frame_commands.py folds the acks.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.utils.deploy_progress_gen import (
    DEPLOY_PROGRESS_DONE_SHOWN_SECONDS,
    DEPLOY_PROGRESS_ERROR_SHOWN_SECONDS,
    DEPLOY_PROGRESS_KINDS,
    DEPLOY_PROGRESS_STAGES,
    DEPLOY_PROGRESS_WAKE_GRACE_SECONDS,
)

DETAIL_MAX_LENGTH = 200
ERROR_MAX_LENGTH = 400
ID_MAX_LENGTH = 128

DONE_SHOWN_SECONDS = DEPLOY_PROGRESS_DONE_SHOWN_SECONDS
ERROR_SHOWN_SECONDS = DEPLOY_PROGRESS_ERROR_SHOWN_SECONDS

# ESP32 `ota:<plane>` statuses -> contract signals.
_OTA_SIGNALS = {
    "waiting": "ota:waiting",
    "downloading": "ota:downloading",
    "progress": "ota:progress",
    "verified": "ota:verified",
    "up-to-date": "ota:up-to-date",
    "skipped": "ota:up-to-date",
    "downgrade-refused": "ota:up-to-date",
    "error": "ota:error",
    "gave-up": "ota:error",
}

# Pi `cloud:upgrade` (upgrade-status.json) statuses -> contract signals.
_UPGRADE_SIGNALS = {
    "starting": "upgrade:downloading",
    "scheduled": "upgrade:downloading",
    "running": "upgrade:downloading",
    "success": "upgrade:verified",
    "reboot_required": "upgrade:verified",
    "up_to_date": "upgrade:up-to-date",
    "skipped": "upgrade:up-to-date",
    "error": "upgrade:error",
    "failed": "upgrade:error",
    "stalled": "upgrade:error",
}

_PROGRESS_RE = re.compile(r"^\s*(\d+)\s*/\s*(\d+)\s*$")


def _iso(now: datetime) -> str:
    at = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return at.isoformat()


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _clip(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] if text else None


def kind_stages(kind: str) -> list[dict]:
    spec = DEPLOY_PROGRESS_KINDS.get(kind)
    return list(spec["stages"]) if spec else []


def kind_stage_names(kind: str) -> list[str]:
    return [entry["stage"] for entry in kind_stages(kind)]


def stage_index(kind: str, stage: Any) -> int:
    names = kind_stage_names(kind)
    return names.index(stage) if isinstance(stage, str) and stage in names else -1


def is_record(record: Any) -> bool:
    return (
        isinstance(record, dict)
        and isinstance(record.get("kind"), str)
        and record["kind"] in DEPLOY_PROGRESS_KINDS
        and isinstance(record.get("stage"), str)
        and record.get("status") in ("running", "done", "error")
    )


def start(
    kind: str,
    *,
    deploy_id: str,
    now: datetime,
    stage: str | None = None,
    detail: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    """A fresh running record at the kind's first stage (or `stage`)."""
    if kind not in DEPLOY_PROGRESS_KINDS:
        raise ValueError(f"Unknown deploy progress kind: {kind}")
    names = kind_stage_names(kind)
    first = stage if stage is not None else names[0]
    if first not in names:
        raise ValueError(f"Stage {first!r} is not part of deploy progress kind {kind!r}")
    at = _iso(now)
    return {
        "id": (_clip(deploy_id, ID_MAX_LENGTH) or "deploy"),
        "kind": kind,
        "stage": first,
        "status": "running",
        "detail": _clip(detail, DETAIL_MAX_LENGTH),
        "progress": None,
        "version": _clip(version, 64),
        "error": None,
        "started_at": at,
        "at": at,
    }


def _moved(record: dict[str, Any], *, now: datetime, **changes: Any) -> dict[str, Any]:
    return {**record, **changes, "at": _iso(now)}


def advance(
    record: Any,
    stage: str,
    *,
    now: datetime,
    detail: str | None = None,
    version: str | None = None,
    kind: str | None = None,
) -> dict[str, Any] | None:
    """The control plane reached `stage` of its own work. Forward only: a
    record already past it (the device was quicker, or a late caller) is
    left alone, except that `detail` still refreshes the caption when the
    record is in exactly that stage. With `kind`, only a record of that kind
    moves (a shared helper must not push a restart's record along a deploy's
    stages). None means no change."""
    if not is_record(record) or record["status"] != "running":
        return None
    if kind is not None and record["kind"] != kind:
        return None
    current = stage_index(record["kind"], record["stage"])
    target = stage_index(record["kind"], stage)
    if target < 0:
        return None
    if target < current:
        return None
    changes: dict[str, Any] = {}
    if target > current:
        changes["stage"] = stage
        changes["progress"] = None
    if detail is not None:
        changes["detail"] = _clip(detail, DETAIL_MAX_LENGTH)
    elif target > current:
        changes["detail"] = None
    if version:
        changes["version"] = _clip(version, 64)
    if not changes:
        return None
    return _moved(record, now=now, **changes)


def note(record: Any, detail: str, *, now: datetime, progress: dict[str, int] | None = None) -> dict[str, Any] | None:
    """Refresh the caption (and bytes) without changing stage: the control
    plane narrating a long step so the bar keeps moving and `at` stays
    fresh."""
    if not is_record(record) or record["status"] != "running":
        return None
    return _moved(record, now=now, detail=_clip(detail, DETAIL_MAX_LENGTH), progress=progress)


def finish(record: Any, *, now: datetime, detail: str | None = None) -> dict[str, Any] | None:
    if not is_record(record) or record["status"] != "running":
        return None
    return _moved(
        record, now=now, stage="done", status="done", progress=None,
        detail=_clip(detail, DETAIL_MAX_LENGTH) if detail is not None else record.get("detail"),
    )


def fail(record: Any, error: str, *, now: datetime) -> dict[str, Any] | None:
    if not is_record(record) or record["status"] != "running":
        return None
    return _moved(record, now=now, status="error", error=_clip(error, ERROR_MAX_LENGTH) or "failed")


def fold(
    record: Any,
    signal: str,
    *,
    now: datetime,
    detail: str | None = None,
    progress: dict[str, int] | None = None,
) -> dict[str, Any] | None:
    """An observed signal (see the contract's `signals`). None when the
    current stage does not list it."""
    if not is_record(record) or record["status"] != "running":
        return None
    for entry in kind_stages(record["kind"]):
        if entry["stage"] != record["stage"]:
            continue
        if signal in entry.get("holdOn", []):
            return _moved(
                record, now=now,
                detail=_clip(detail, DETAIL_MAX_LENGTH) if detail is not None else record.get("detail"),
                progress=progress if progress is not None else record.get("progress"),
            )
        target = entry.get("on", {}).get(signal)
        if target is None:
            return None
        if target == "done":
            return finish(record, now=now, detail=detail)
        if target == "error":
            return fail(record, detail or signal, now=now)
        return _moved(
            record, now=now, stage=target, progress=progress, detail=_clip(detail, DETAIL_MAX_LENGTH)
        )
    return None


def signals_for_log(payload: Any) -> list[tuple[str, str | None, dict[str, int] | None]]:
    """The contract signals one device log line carries, as
    (signal, detail, progress). Most lines carry none."""
    if not isinstance(payload, dict):
        return []
    event = payload.get("event")
    if not isinstance(event, str):
        return []
    if event in ("bootup", "reload", "render:done"):
        return [(event, None, None)]
    status = payload.get("status")
    if event.startswith("ota:") and isinstance(status, str):
        signal = _OTA_SIGNALS.get(status)
        if not signal:
            return []
        raw_detail = payload.get("detail")
        detail = raw_detail if isinstance(raw_detail, str) else None
        progress = None
        if signal == "ota:progress" and detail:
            match = _PROGRESS_RE.match(detail)
            if match:
                progress = {"current": int(match.group(1)), "total": int(match.group(2))}
                detail = None
        if signal == "ota:downloading" and detail:
            detail = f"downloading {detail}"
        return [(signal, detail, progress)]
    if event == "cloud:upgrade" and isinstance(status, str):
        signal = _UPGRADE_SIGNALS.get(status)
        if not signal:
            return []
        message = payload.get("message")
        return [(signal, message if isinstance(message, str) else None, None)]
    return []


def fold_log(record: Any, payload: Any, *, now: datetime) -> dict[str, Any] | None:
    """Fold every signal one device log line carries. None when nothing moved."""
    result = None
    current = record
    for signal, detail, progress in signals_for_log(payload):
        moved = fold(current, signal, now=now, detail=detail, progress=progress)
        if moved is not None:
            result = current = moved
    return result


def fold_command(record: Any, command_type: str, state: str, *, now: datetime, error: str | None = None) -> dict[str, Any] | None:
    """A command-queue row of this frame changed state (sent / acked / failed)."""
    if state not in ("sent", "acked", "failed"):
        return None
    return fold(record, f"command:{state}:{command_type}", now=now, detail=error)


def is_stale(record: Any, now: datetime, *, next_wake_at: datetime | None = None) -> bool:
    """Whether a running record sat in its stage longer than the stage
    allows. A `waiting` stage stays fresh while the frame's own wake
    forecast is still ahead (plus a grace), whatever the stage's allowance."""
    if not is_record(record) or record["status"] != "running":
        return False
    at = _parse(record.get("at"))
    if at is None:
        return True
    spec = DEPLOY_PROGRESS_STAGES.get(record["stage"]) or {}
    reference = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    if spec.get("freshWhileSleeping") and next_wake_at is not None:
        wake = next_wake_at if next_wake_at.tzinfo is not None else next_wake_at.replace(tzinfo=timezone.utc)
        if reference < wake + timedelta(seconds=DEPLOY_PROGRESS_WAKE_GRACE_SECONDS):
            return False
    return (reference - at).total_seconds() > int(spec.get("staleAfterSeconds") or 0)


def is_running(record: Any, now: datetime, *, next_wake_at: datetime | None = None) -> bool:
    return is_record(record) and record["status"] == "running" and not is_stale(record, now, next_wake_at=next_wake_at)


def percent(record: Any) -> int:
    """0..100 for a bar: the stage's position in its kind's list, the bytes
    fraction inside a downloading stage, 100 when done."""
    if not is_record(record):
        return 0
    if record["status"] == "done":
        return 100
    names = kind_stage_names(record["kind"])
    index = stage_index(record["kind"], record["stage"])
    if index < 0 or not names:
        return 0
    fraction = 0.3
    progress = record.get("progress")
    if isinstance(progress, dict):
        current = progress.get("current")
        total = progress.get("total")
        if isinstance(current, int) and isinstance(total, int) and total > 0:
            fraction = max(0.0, min(1.0, current / total))
    return int(round(100 * (index + fraction) / len(names)))
