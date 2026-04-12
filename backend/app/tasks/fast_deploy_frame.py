from __future__ import annotations

from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow, tls_settings_changed


async def fast_deploy_frame(id: int, redis: Redis) -> None:
    await redis.enqueue_job("fast_deploy_frame", id=id)


async def fast_deploy_frame_task(ctx: dict[str, Any], id: int) -> None:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]

    frame = db.get(Frame, id)
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
        await workflow.execute(plan)
    except Exception as exc:
        await log(db, redis, id, "stderr", str(exc))
