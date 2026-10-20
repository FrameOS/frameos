"""The deploy for a frame this backend is the provider of.

A provider frame (app/utils/provider_frames.py) takes its deploy as three
verbs on its management socket — `set_settings`, `set_schedule`,
`set_scenes` — exactly as a cloud frame does. Fast or full makes no
difference: the frame's FrameOS changes only through its own signed upgrade,
on a `notify_update_available` nudge ("Update FrameOS"). The deploy is
recorded as the frame's baseline when the device acks the scenes and the
settings (app/ws/provider_hub.py), never when it is queued; a frame that is
away takes it when it next connects, and the deploy-progress bar
(`cloud_scenes`) follows the verb there.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.tasks.utils import get_fresh_frame, record_task_failure
from app.utils.provider_commands import ProviderCommandError, provider_deploy_settled, queue_provider_deploy
from app.utils.provider_frames import provider_link, provider_reported_version
from app.utils.versions import current_frameos_version

# How long the job waits for a connected frame to take the deploy before
# reporting it as queued.
DEPLOY_WAIT_SECONDS = 20.0


async def _await_settled(db: Session, frame: Any, deploy_id: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        db.expire_all()
        if provider_deploy_settled(db, frame, deploy_id):
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.5)


async def deploy_over_provider_socket(
    db: Session,
    redis: Redis,
    id: int,
    *,
    job_id: Optional[str],
    task_id: Optional[str],
    activate_scene: Optional[dict[str, Any]] = None,
    task_label: str = "fast",
) -> bool:
    """Queue the deploy's verbs and wait a moment for a connected frame to
    take them. Returns whether it was applied (False: queued for the frame's
    next connection)."""
    from app.tasks.deploy_frame import clear_active_deploy_job, deploy_task_log_line, register_active_deploy_job

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return False
    await register_active_deploy_job(redis, id, job_id)
    try:
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "started", task_label))
        # The baseline the drawer diffs against: what is being sent, on the
        # FrameOS the frame said it runs.
        snapshot = frame.to_dict()
        snapshot.pop("last_successful_deploy", None)
        snapshot.pop("last_successful_deploy_at", None)
        snapshot["frameos_version"] = provider_reported_version(frame) or current_frameos_version()
        scene_id = activate_scene.get("sceneId") if isinstance(activate_scene, dict) else None
        state = activate_scene.get("state") if isinstance(activate_scene, dict) else None
        deploy_id = await queue_provider_deploy(
            db, redis, frame, snapshot,
            scene_id=scene_id if isinstance(scene_id, str) and scene_id else None,
            state=state if isinstance(state, dict) else None,
        )
        link = provider_link(frame)
        applied = bool(link is not None and link.connected) and await _await_settled(
            db, frame, deploy_id, DEPLOY_WAIT_SECONDS
        )
        if applied:
            await log(db, redis, id, "stdout", "The frame took the scenes and settings")
        else:
            await log(db, redis, id, "stdinfo", "Deploy queued; the frame takes it when it next connects")
        if task_id:
            await log(
                db, redis, id, "stdout",
                deploy_task_log_line(task_id, "completed", task_label if applied else f"{task_label} queued"),
            )
        return applied
    except ProviderCommandError as exc:
        await record_task_failure(
            db, redis, id, RuntimeError(f"The frame cannot take this deploy: {exc.error}"),
            frame=get_fresh_frame(db, id),
            task_line=(lambda message: deploy_task_log_line(task_id, "failed", message)) if task_id else None,
        )
        raise
    except (Exception, asyncio.CancelledError) as exc:
        await record_task_failure(
            db, redis, id, exc, frame=get_fresh_frame(db, id),
            task_line=(lambda message: deploy_task_log_line(task_id, "failed", message)) if task_id else None,
        )
        raise
    finally:
        await clear_active_deploy_job(redis, id, job_id)
