"""The hourly automatic update sweep (docs/auto-updates.md, "Per frame type"):
every frame of this backend whose owner left "Install updates automatically"
on is asked the update decision, and the ones it answers are updated the way
the owner's own buttons would.

- An ESP32 gets the firmware update check queued (what "Update firmware"
  does); its board then asks /embedded/ota/manifest, which answers by the
  same rule.
- A Linux frame on a runtime from 2026.11.14 on is asked through its admin
  API to upgrade itself to exactly the version decided; an older runtime
  this backend can reach over SSH gets the ordinary deploy; an older
  shell-less one is asked to upgrade (to GitHub's latest) only when that is
  what the rule answered. The ceiling is this backend's own FrameOS: it
  deploys its own runtime and must not leave a frame on a newer one.

Each frame is nudged at most once in 20 hours, only between 02:00 and 05:00
in its time zone (UTC without one), never while a deploy, update, restart or
reboot is in flight, never a virtual frame or a board without an OTA image
(a Pico, the 4 MB layout).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame, frame_has_shell_access
from app.utils.deploy_progress import is_running as deploy_progress_running
from app.utils.frame_updates import (
    AUTO_NUDGE_TTL_SECONDS,
    auto_nudge_key,
    decide_for_frame,
    embedded_ota_target,
    request_device_upgrade,
    start_embedded_firmware_update,
)
from app.utils.update_decision import parse_version
from app.utils.update_manifest import get_update_manifest
from app.utils.versions import current_frameos_version

logger = logging.getLogger(__name__)

# The local hours [from, to) an automatic update may start in.
WINDOW_FROM_HOUR = 2
WINDOW_TO_HOUR = 5
# The first runtime that takes `POST /api/upgrade {"version"}`.
PINNED_UPGRADE_SINCE = (2026, 11, 14)


@dataclass
class SweepAction:
    frame_id: int
    action: str  # firmware | upgrade | deploy | skip
    version: Optional[str] = None
    reason: str = ""


def local_hour(frame: Frame, now: datetime) -> int:
    zone: Any = timezone.utc
    name = (frame.timezone or "").strip() if isinstance(frame.timezone, str) else ""
    if name:
        try:
            zone = ZoneInfo(name)
        except Exception:  # noqa: BLE001 - an unknown zone reads as UTC
            zone = timezone.utc
    moment = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return moment.astimezone(zone).hour


def in_window(frame: Frame, now: datetime) -> bool:
    return WINDOW_FROM_HOUR <= local_hour(frame, now) < WINDOW_TO_HOUR


def frame_kind(frame: Frame) -> Optional[str]:
    """`esp32`, `linux`, or None for a frame the sweep leaves alone."""
    from app.tasks.embedded_firmware import is_virtual_frame

    mode = frame.mode or "rpios"
    if mode == "embedded":
        if is_virtual_frame(frame) or embedded_ota_target(frame) is None:
            return None
        return "esp32"
    if mode in ("rpios", "buildroot"):
        return "linux"
    return None


def skip_reason(frame: Frame, now: datetime) -> Optional[str]:
    """Why the sweep leaves a frame alone this hour, before asking the
    rule (None: ask it)."""
    if frame.auto_update is False:
        return "automatic updates are off"
    if frame.archived:
        return "archived"
    if frame_kind(frame) is None:
        return "nothing to update (virtual, or no OTA image)"
    if deploy_progress_running(frame.deploy_progress, now, next_wake_at=_aware(frame.next_wake_at)):
        return "a deploy, update, restart or reboot is in flight"
    if not in_window(frame, now):
        return "outside 02:00-05:00 local time"
    return None


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def runtime_takes_pinned_upgrade(version: Optional[str]) -> bool:
    parsed = parse_version(version)
    return parsed is not None and parsed >= PINNED_UPGRADE_SINCE


async def sweep_frame(
    db: Session,
    redis: Redis,
    frame: Frame,
    manifest: Any,
    now: datetime,
    *,
    enqueue_deploy: Optional[Callable[[Session, Redis, Frame], Awaitable[None]]] = None,
) -> SweepAction:
    """Decide for one frame and act on it. Never raises: a frame that
    cannot be updated is logged and left for the next sweep."""
    from app.utils.retired_apps import frame_runtime_version

    frame_id = int(frame.id)
    reason = skip_reason(frame, now)
    if reason:
        return SweepAction(frame_id, "skip", reason=reason)
    try:
        if await redis.get(auto_nudge_key(frame_id)):
            return SweepAction(frame_id, "skip", reason="nudged in the last 20 hours")
    except Exception:  # noqa: BLE001 - no redis: no memory of nudges, so no nudges
        return SweepAction(frame_id, "skip", reason="redis unavailable")

    kind = frame_kind(frame)
    current = frame_runtime_version(frame)
    if kind == "esp32":
        decision = decide_for_frame(
            frame, manifest, platform="esp32", target=embedded_ota_target(frame) or "", current=current, now=now
        )
    else:
        decision = decide_for_frame(
            frame, manifest, platform="linux", target="", current=current,
            max_version=current_frameos_version(), now=now,
        )
    version = decision.get("version")
    if not version:
        return SweepAction(frame_id, "skip", reason=str(decision.get("reason")))

    # Remembered before acting: a frame that fails is tried again tomorrow,
    # not every hour of the window.
    await redis.set(auto_nudge_key(frame_id), version, ex=AUTO_NUDGE_TTL_SECONDS)
    try:
        if kind == "esp32":
            await start_embedded_firmware_update(db, redis, frame, version=version, wait_seconds=0)
            action = SweepAction(frame_id, "firmware", version, str(decision.get("reason")))
        elif runtime_takes_pinned_upgrade(current) and await _admin_upgrade(db, redis, frame, version):
            action = SweepAction(frame_id, "upgrade", version, str(decision.get("reason")))
        elif frame_has_shell_access(frame):
            await (enqueue_deploy or _enqueue_deploy)(db, redis, frame)
            action = SweepAction(frame_id, "deploy", version, str(decision.get("reason")))
        elif version == decision.get("latest") and await _admin_upgrade(db, redis, frame, None):
            action = SweepAction(frame_id, "upgrade", version, str(decision.get("reason")))
        else:
            action = SweepAction(frame_id, "skip", version,
                                 "a shell-less runtime too old to install exactly this version")
    except Exception as exc:  # noqa: BLE001 - one frame never stops the sweep
        logger.warning("auto update: frame %s: %s", frame_id, exc)
        return SweepAction(frame_id, "skip", version, f"failed: {exc}")
    if action.action != "skip":
        logger.info("auto update: frame %s -> %s (%s, %s)", frame_id, version, action.action, action.reason)
    return action


async def _admin_upgrade(db: Session, redis: Redis, frame: Frame, version: Optional[str]) -> bool:
    """The runtime's own signed upgrade through its admin API; False when
    the frame cannot be reached that way (no admin login, offline)."""
    try:
        payload = await request_device_upgrade(
            db, redis, frame, version=version, detail="automatic update: the frame downloads the release itself"
        )
    except Exception as exc:  # noqa: BLE001 - the caller falls back
        logger.info("auto update: frame %s admin upgrade unavailable: %s", frame.id, exc)
        return False
    return payload.get("status") not in ("error", "failed")


async def _enqueue_deploy(db: Session, redis: Redis, frame: Frame) -> None:
    """The ordinary deploy, exactly as the Deploy button starts it."""
    from app.tasks.deploy_frame import deploy_frame
    from app.tasks.utils import begin_deploy_progress, deploy_progress_kind_for_frame

    await begin_deploy_progress(db, redis, frame, deploy_progress_kind_for_frame(frame, "full"))
    try:
        await deploy_frame(int(frame.id), redis)
    except Exception as exc:
        from app.models.frame import set_deploy_progress
        from app.utils.deploy_progress import fail

        await set_deploy_progress(db, redis, frame, fail(frame.deploy_progress, str(exc), now=datetime.now(timezone.utc)))
        raise


async def auto_update_frames(db: Session, redis: Redis, *, now: Optional[datetime] = None) -> list[SweepAction]:
    moment = now or datetime.now(timezone.utc)
    frames = db.query(Frame).filter(Frame.auto_update.isnot(False)).all()
    candidates = [frame for frame in frames if skip_reason(frame, moment) is None]
    if not candidates:
        return []
    manifest = await get_update_manifest()
    if manifest is None:
        logger.info("auto update: no manifest (GitHub and the cloud mirror unreachable); nothing this hour")
        return []
    return [await sweep_frame(db, redis, frame, manifest, moment) for frame in candidates]


async def auto_update_frames_task(ctx: dict[str, Any]) -> dict[str, int]:
    actions = await auto_update_frames(ctx["db"], ctx["redis"])
    counts: dict[str, int] = {}
    for action in actions:
        counts[action.action] = counts.get(action.action, 0) + 1
    return counts
