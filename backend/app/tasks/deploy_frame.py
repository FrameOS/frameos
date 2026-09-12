from __future__ import annotations

import asyncio
import tempfile
from typing import Any

from arq import ArqRedis as Redis
from arq.jobs import Job
from sqlalchemy.orm import Session

from app.models.frame import Frame, update_frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow, active_deploy_job_key, deploy_lock_key

from .utils import enqueue_unique_job, get_fresh_frame, record_task_failure


def deploy_task_log_line(task_id: str, action: str, detail: str = "") -> str:
    suffix = f" {detail}" if detail else ""
    return f"[frameos-task:{task_id}] deploy {action}{suffix}"


async def register_active_deploy_job(redis: Redis, frame_id: int, job_id: str | None) -> None:
    if not job_id:
        return
    await redis.set(
        active_deploy_job_key(frame_id), job_id, ex=FrameDeployWorkflow.DEPLOY_LOCK_TTL_SECONDS
    )


async def clear_active_deploy_job(redis: Redis, frame_id: int, job_id: str | None) -> None:
    if not job_id:
        return
    key = active_deploy_job_key(frame_id)
    current = await redis.get(key)
    current_id = current.decode(errors="replace") if isinstance(current, bytes) else current
    if current_id == job_id:
        await redis.delete(key)


async def cancel_active_deploy(db: Session, redis: Redis, frame: Frame) -> dict[str, bool]:
    """Forcibly clear a stuck deploy for a frame.

    Aborts the running (or queued) deploy job if one is registered, releases
    the per-frame deploy lock, and resets a lingering "deploying" status —
    in that order, so the aborted job's cleanup cannot re-wedge the frame.
    """
    frame_id = int(frame.id)

    aborted_job = False
    job_key = active_deploy_job_key(frame_id)
    raw_job_id = await redis.get(job_key)
    job_id = raw_job_id.decode(errors="replace") if isinstance(raw_job_id, bytes) else raw_job_id
    if job_id:
        try:
            aborted_job = bool(await Job(job_id, redis).abort(timeout=10))
        except asyncio.TimeoutError:
            await log(db, redis, frame_id, "stderr",
                      f"Deploy job {job_id} did not confirm the abort in time; clearing the deploy lock anyway")
        except Exception as exc:
            await log(db, redis, frame_id, "stderr",
                      f"Could not abort deploy job {job_id}: {exc}. Clearing the deploy lock anyway")
    await redis.delete(job_key)

    cleared_lock = bool(await redis.delete(deploy_lock_key(frame_id)))

    reset_status = False
    if frame.status == "deploying":
        frame.status = "uninitialized"
        await update_frame(db, redis, frame)
        reset_status = True

    summary = []
    if aborted_job:
        summary.append("aborted the running deploy job")
    if cleared_lock:
        summary.append("released the deploy lock")
    if reset_status:
        summary.append('reset the "deploying" status')
    await log(db, redis, frame_id, "stdinfo",
              "🛑 Deploy cancelled: " + (", ".join(summary) if summary else "nothing was running") +
              ". You can start a new deploy now.")

    return {"abortedJob": aborted_job, "clearedLock": cleared_lock, "resetStatus": reset_status}


async def deploy_frame(id: int, redis: Redis, *, task_id: str | None = None) -> str | None:
    enqueue_kwargs: dict[str, Any] = {"id": id}
    if task_id:
        enqueue_kwargs["task_id"] = task_id
        enqueue_kwargs["_job_id"] = task_id
    await enqueue_unique_job(redis, "deploy_frame", **enqueue_kwargs)
    return task_id


async def deploy_frame_task(ctx: dict[str, Any], id: int, task_id: str | None = None) -> None:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]
    job_id: str | None = ctx.get("job_id")

    frame = get_fresh_frame(db, id)
    if not frame:
        raise Exception("Frame not found")

    # Virtual frames: deploying IS rendering — no SSH, no device, ever.
    # Belt-and-braces with the endpoint gates: this catches every enqueue path.
    from app.tasks.embedded_firmware import embedded_platform_spec_for_frame

    if frame.mode == "embedded" and embedded_platform_spec_for_frame(frame)["family"] == "virtual":
        from app.api.virtual_frame import mark_virtual_frame_deployed, refresh_virtual_frame_image

        if task_id:
            await log(db, redis, int(frame.id), type="stdout", line=deploy_task_log_line(task_id, "started"))
        await refresh_virtual_frame_image(db, redis, frame)
        await mark_virtual_frame_deployed(db, redis, frame)
        if task_id:
            await log(db, redis, int(frame.id), type="stdout", line=deploy_task_log_line(task_id, "completed"))
        return

    # A frame this backend reaches only over its admin API has no full
    # deploy: FrameOS on it changes through its own signed upgrade, and
    # everything else is the same push the fast deploy makes. Every enqueue
    # path (the deploy button, next_action, set_next_scene) lands here.
    from app.models.frame import frame_has_shell_access

    if not frame_has_shell_access(frame):
        from app.tasks.fast_deploy_frame import deploy_over_admin_api

        await deploy_over_admin_api(db, redis, id, job_id=job_id, task_id=task_id, task_label="full")
        return

    await register_active_deploy_job(redis, id, job_id)
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            deployer = FrameDeployer(
                db=db,
                redis=redis,
                frame=frame,
                nim_path="",
                temp_dir=temp_dir,
            )
            workflow = FrameDeployWorkflow(
                db=db,
                redis=redis,
                frame=frame,
                deployer=deployer,
                temp_dir=temp_dir,
            )
            plan = await workflow.plan("full")
            if task_id:
                await log(db, redis, int(frame.id), type="stdout", line=deploy_task_log_line(task_id, "started"))
            await workflow.execute(plan)
            if task_id:
                await log(db, redis, int(frame.id), type="stdout", line=deploy_task_log_line(task_id, "completed"))
    except (Exception, asyncio.CancelledError) as exc:
        # CancelledError is a BaseException: an aborted or timed-out job used
        # to skip this block, leave status="deploying" and log nothing, and
        # the next deploy then hit the stuck-status branch. Reset the row
        # here (the workflow's own reset only runs for Exception) before
        # re-raising so arq records the outcome.
        await record_task_failure(
            db, redis, int(frame.id), exc,
            frame=get_fresh_frame(db, id),
            task_line=(lambda message: deploy_task_log_line(task_id, "failed", message)) if task_id else None,
        )
        raise
    finally:
        await clear_active_deploy_job(redis, id, job_id)
