"""The deploy for a frame this backend is the provider of.

A provider frame (app/utils/provider_frames.py) takes its deploy as three
verbs on its management socket — `set_settings`, `set_schedule`,
`set_scenes` — exactly as a cloud frame does. Fast or full makes no
difference: the frame's FrameOS changes only through its own signed upgrade,
on a `notify_update_available` nudge ("Update FrameOS"). The deploy is
recorded as the frame's baseline when the device acks the scenes and the
settings, never when it is queued: here when it does so within the job's
wait, otherwise by the mirror when it reconnects and does
(app/tasks/provider_mirror.py). The deploy-progress bar (`cloud_scenes`) is
the hub's, started by the cloud's enqueueFrameCommand and moved by the hub.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.tasks.utils import get_fresh_frame, record_task_failure
from app.utils.provider_commands import (
    ProviderCommandError,
    provider_deploy_state,
    queue_provider_deploy,
    record_settled_provider_deploys,
)
from app.utils.provider_frames import provider_link, provider_reported_version
from app.utils.versions import current_frameos_version

# How long the job waits for a connected frame to take the deploy before
# reporting it as queued.
DEPLOY_WAIT_SECONDS = 20.0


async def _await_settled(db: Session, redis: Redis, frame: Any, deploy_id: str, timeout: float) -> str:
    """`acked`, `failed`, or `pending` when the frame did not answer in time."""
    deadline = time.monotonic() + timeout
    while True:
        db.expire_all()
        state = await provider_deploy_state(db, frame, deploy_id, redis)
        if state != "pending" or time.monotonic() >= deadline:
            return state
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
        scene_state = activate_scene.get("state") if isinstance(activate_scene, dict) else None
        deploy_id = await queue_provider_deploy(
            db, redis, frame, snapshot,
            scene_id=scene_id if isinstance(scene_id, str) and scene_id else None,
            state=scene_state if isinstance(scene_state, dict) else None,
        )
        link = provider_link(frame)
        state = (
            await _await_settled(db, redis, frame, deploy_id, DEPLOY_WAIT_SECONDS)
            if link is not None and link.connected
            else "pending"
        )
        if state != "pending":
            await record_settled_provider_deploys(db, redis, frame)
        if state == "failed":
            raise RuntimeError("The frame refused the deploy; its log says why")
        applied = state == "acked"
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
