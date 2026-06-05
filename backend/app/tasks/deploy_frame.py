from __future__ import annotations

import tempfile
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow

from .utils import get_fresh_frame


def deploy_task_log_line(task_id: str, action: str, detail: str = "") -> str:
    suffix = f" {detail}" if detail else ""
    return f"[frameos-task:{task_id}] deploy {action}{suffix}"


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

    frame = get_fresh_frame(db, id)
    if not frame:
        raise Exception("Frame not found")

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
