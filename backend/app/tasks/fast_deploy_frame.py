from __future__ import annotations

from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow, tls_settings_changed
from app.tasks.utils import get_fresh_frame
from app.tasks.deploy_frame import deploy_task_log_line


async def fast_deploy_frame(id: int, redis: Redis, *, task_id: str | None = None) -> str | None:
    enqueue_kwargs: dict[str, Any] = {"id": id}
    if task_id:
        enqueue_kwargs["task_id"] = task_id
        enqueue_kwargs["_job_id"] = task_id
    await redis.enqueue_job("fast_deploy_frame", **enqueue_kwargs)
    return task_id


async def fast_deploy_frame_task(ctx: dict[str, Any], id: int, task_id: str | None = None) -> None:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")
    workflow = FrameDeployWorkflow(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        temp_dir="",
    )

    try:
        plan = await workflow.plan("fast")
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "started", "fast"))
        await workflow.execute(plan)
        if task_id:
            await log(db, redis, id, "stdout", deploy_task_log_line(task_id, "completed", "fast"))
    except Exception as exc:
        if task_id:
            await log(db, redis, id, "stderr", deploy_task_log_line(task_id, "failed", str(exc)))
        await log(db, redis, id, "stderr", str(exc))
