from __future__ import annotations

import tempfile
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow

from .utils import find_nim_v2


async def deploy_frame(id: int, redis: Redis) -> None:
    await redis.enqueue_job("deploy_frame", id=id)


async def deploy_frame_task(ctx: dict[str, Any], id: int) -> None:
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]

    frame = db.get(Frame, id)
    if not frame:
        raise Exception("Frame not found")

    try:
        nim_path = find_nim_v2()
        with tempfile.TemporaryDirectory() as temp_dir:
            deployer = FrameDeployer(
                db=db,
                redis=redis,
                frame=frame,
                nim_path=nim_path,
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
            await workflow.execute(plan)
    except Exception as exc:
        await log(db, redis, int(frame.id), type="stderr", line=str(exc))
