from __future__ import annotations

import asyncio
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow, tls_settings_changed  # noqa: F401  (tests import it from here)
from app.tasks.utils import enqueue_unique_job, get_fresh_frame, record_task_failure
from app.tasks.deploy_frame import clear_active_deploy_job, deploy_task_log_line, register_active_deploy_job


async def fast_deploy_frame(
    id: int,
    redis: Redis,
    *,
    task_id: str | None = None,
    activate_scene: dict[str, Any] | None = None,
) -> str | None:
    """Queue a fast deploy. `activate_scene` (`{"sceneId", "state"}`) is for
    frames deployed over their admin API: the scene to switch to once the
    push has landed (the SSH path writes the boot-scene files before it
    queues the job instead)."""
    enqueue_kwargs: dict[str, Any] = {"id": id}
    if task_id:
        enqueue_kwargs["task_id"] = task_id
        enqueue_kwargs["_job_id"] = task_id
    if activate_scene:
        enqueue_kwargs["activate_scene"] = activate_scene
    await enqueue_unique_job(redis, "fast_deploy_frame", **enqueue_kwargs)
    return task_id


def _failed_task_line(task_id: str | None):
    return (lambda message: deploy_task_log_line(task_id, "failed", message)) if task_id else None


async def deploy_over_admin_api(
    db: Session,
    redis: Redis,
    id: int,
    *,
    job_id: str | None,
    task_id: str | None,
    activate_scene: dict[str, Any] | None = None,
    task_label: str = "fast",
) -> None:
    """The deploy for a frame this backend only reaches over its admin API
    (an adopted generic Buildroot card: no Remote, no SSH). Fast or full
    makes no difference here — FrameOS itself only ever changes through the
    frame's own signed upgrade — so both queue paths end up in this one
    push of service keys, scenes and settings with a runtime reload. SSH
    would only fail."""
    from app.api.frame_sync import push_backend_state_to_device
    from app.utils.frame_http import _fetch_frame_http_bytes

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return
    await register_active_deploy_job(redis, id, job_id)
    try:
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "started", task_label))
        await log(db, redis, id, "stdout",
                  f"No shell on this frame: pushing scenes and settings over its admin API at {frame.frame_host}")
        await push_backend_state_to_device(
            frame, db, redis, _fetch_frame_http_bytes, activate_scene=activate_scene
        )
        await log(db, redis, id, "stdout", "Frame accepted the deploy and reloaded")
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "completed", task_label))
    except (Exception, asyncio.CancelledError) as exc:
        await record_task_failure(
            db, redis, id, exc, frame=get_fresh_frame(db, id), task_line=_failed_task_line(task_id)
        )
        raise
    finally:
        await clear_active_deploy_job(redis, id, job_id)


async def fast_deploy_frame_task(
    ctx: dict[str, Any],
    id: int,
    task_id: str | None = None,
    activate_scene: dict[str, Any] | None = None,
) -> None:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]
    job_id: str | None = ctx.get("job_id")

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    # Virtual frames: fast deploy IS rendering — no SSH, no device, ever.
    from app.tasks.embedded_firmware import embedded_platform_spec_for_frame

    if frame.mode == "embedded" and embedded_platform_spec_for_frame(frame)["family"] == "virtual":
        from app.api.virtual_frame import mark_virtual_frame_deployed, refresh_virtual_frame_image

        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "started", "fast"))
        await refresh_virtual_frame_image(db, redis, frame)
        await mark_virtual_frame_deployed(db, redis, frame)
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "completed", "fast"))
        return

    # A frame this backend only reaches over its admin API (an adopted generic
    # Buildroot card: no Remote, no SSH): the fast deploy IS that API — one
    # push of scenes and settings with a runtime reload. SSH would only fail.
    from app.models.frame import frame_has_shell_access

    if not frame_has_shell_access(frame):
        await deploy_over_admin_api(
            db, redis, id, job_id=job_id, task_id=task_id, activate_scene=activate_scene, task_label="fast"
        )
        return

    deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")
    workflow = FrameDeployWorkflow(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        temp_dir="",
    )

    await register_active_deploy_job(redis, id, job_id)
    try:
        plan = await workflow.plan("fast")
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "started", "fast"))
        await workflow.execute(plan)
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "completed", "fast"))
    except (Exception, asyncio.CancelledError) as exc:
        # The workflow resets "deploying" itself for an Exception; a
        # cancelled job skips that, so the shared path resets it here.
        await record_task_failure(
            db, redis, id, exc, frame=get_fresh_frame(db, id), task_line=_failed_task_line(task_id)
        )
        raise
    finally:
        await clear_active_deploy_job(redis, id, job_id)
