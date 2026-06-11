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

from .utils import get_fresh_frame


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
    await redis.enqueue_job("deploy_frame", **enqueue_kwargs)
    return task_id


async def deploy_frame_task(ctx: dict[str, Any], id: int, task_id: str | None = None) -> None:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]
    job_id: str | None = ctx.get("job_id")

    frame = get_fresh_frame(db, id)
    if not frame:
        raise Exception("Frame not found")

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
    except Exception as exc:
        if task_id:
            await log(db, redis, int(frame.id), type="stderr", line=deploy_task_log_line(task_id, "failed", str(exc)))
        await log(db, redis, int(frame.id), type="stderr", line=str(exc))
        # Re-raise so arq records the job as failed. The workflow already reset
        # frame.status to "uninitialized" before raising, so this leaves no
        # stuck state but lets job-status consumers see the failure.
        raise
    finally:
        await clear_active_deploy_job(redis, id, job_id)
