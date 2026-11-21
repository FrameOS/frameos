"""What this backend does to update a frame, shared by the owner's buttons
(app/api/frames.py), the board's OTA manifest route (app/api/embedded_device.py)
and the hourly automatic sweep (app/tasks/auto_update.py). docs/auto-updates.md
is the spec; the decision itself is app/utils/update_decision.py."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.utils.update_decision import decide_update
from app.utils.update_manifest import backend_frame_key

# "The owner pressed Update": the board's next manifest check within this
# long is answered as a manual one (the rollout is skipped).
MANUAL_OTA_TTL_SECONDS = 30 * 60
# The sweep nudges a frame at most once in this long.
AUTO_NUDGE_TTL_SECONDS = 20 * 60 * 60


def manual_ota_key(frame_id: int) -> str:
    return f"ota:manual:{int(frame_id)}"


def auto_nudge_key(frame_id: int) -> str:
    return f"auto_update:nudged:{int(frame_id)}"


async def mark_manual_ota(redis: Redis, frame_id: int) -> None:
    await redis.set(manual_ota_key(frame_id), "1", ex=MANUAL_OTA_TTL_SECONDS)


async def manual_ota_requested(redis: Redis, frame_id: int) -> bool:
    try:
        return bool(await redis.get(manual_ota_key(frame_id)))
    except Exception:  # noqa: BLE001 - no redis, no flag: an automatic check
        return False


def now_iso(now: Optional[datetime] = None) -> str:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def embedded_ota_target(frame: Frame) -> Optional[str]:
    """The OTA layout a board's release image is published under, or None
    for a frame with none (a Pico's UF2 is provisioning-only, the 4 MB
    layout has no OTA slot)."""
    from app.tasks.embedded_firmware import (
        EMBEDDED_IMAGE_FORMAT_BIN,
        embedded_ota_supported_for_frame,
        embedded_release_firmware_for_frame,
    )

    try:
        release = embedded_release_firmware_for_frame(frame)
        if release is None or release.get("format") != EMBEDDED_IMAGE_FORMAT_BIN:
            return None
        if not embedded_ota_supported_for_frame(frame):
            return None
    except ValueError:
        return None
    return str(release["asset"])


def decide_for_frame(
    frame: Frame,
    manifest: Any,
    *,
    platform: str,
    target: str,
    current: Optional[str],
    manual: bool = False,
    max_version: Optional[str] = None,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    return decide_update(
        manifest,
        {
            "current": current or "",
            "platform": platform,
            "target": target,
            "frameKey": backend_frame_key(int(frame.id)),
            "channel": "stable",
            "manual": manual,
            "now": now_iso(now),
            "maxVersion": max_version,
        },
    )


async def start_embedded_firmware_update(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    version: Optional[str] = None,
    wait_seconds: float = 5.0,
) -> dict[str, Any]:
    """Queue the board's update check with its deploy-progress record
    (kind `firmware`) started first and moved by the outcome. Raises
    ValueError (the record failed) when the board cannot take it."""
    from app.tasks.embedded_firmware import embedded_release_firmware_for_frame, request_embedded_firmware_update
    from app.tasks.utils import advance_deploy_progress, begin_deploy_progress, record_task_failure

    if version is None:
        release = embedded_release_firmware_for_frame(frame)
        version = str(release.get("version")) if isinstance(release, dict) and release.get("version") else None
    await begin_deploy_progress(db, redis, frame, "firmware", version=version)
    try:
        outcome = await request_embedded_firmware_update(db, redis, frame, wait_seconds=wait_seconds)
    except ValueError as exc:
        await record_task_failure(db, redis, int(frame.id), exc, frame=frame)
        raise
    # Taken now (the ack, or a pre-queue board's direct poke): the device is
    # off to its updater. Queued: it takes the check on its next wake.
    await advance_deploy_progress(
        db, redis, frame, "downloading" if outcome["applied"] else "waiting", kind="firmware"
    )
    return outcome


async def request_device_upgrade(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    version: Optional[str] = None,
    dry_run: bool = False,
    detail: str = "the frame downloads the release itself",
) -> dict[str, Any]:
    """Ask a Linux frame's runtime to upgrade itself (``POST /api/upgrade``
    on its admin API): to exactly ``version`` when given (a runtime from
    2026.11.14 on; an older one ignores it and takes GitHub's latest), and
    start the `upgrade` deploy-progress record when it accepted. Raises an
    HTTPException (502) when the frame cannot be reached or refuses."""
    from app.api.frames import _record_device_reported_frameos_version, _relay_device_admin
    from app.models.frame import frame_has_shell_access
    from app.tasks.utils import begin_deploy_progress

    body: dict[str, Any] = {"dry_run": dry_run}
    if version:
        body["version"] = version
    payload = await _relay_device_admin(frame, redis, "/api/upgrade", method="POST", body=body)
    payload["shell_access"] = frame_has_shell_access(frame)
    await _record_device_reported_frameos_version(db, redis, frame, payload)
    if not dry_run and payload.get("status") not in ("up_to_date", "error", "failed"):
        # The frame upgrades itself: its cloud:upgrade lines, bootup and
        # first render move the record from here (models/log.py).
        latest = payload.get("latest_version")
        await begin_deploy_progress(
            db, redis, frame, "upgrade",
            version=version or (latest if isinstance(latest, str) and latest else None),
            detail=detail,
        )
    return payload
