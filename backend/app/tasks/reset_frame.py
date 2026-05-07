from typing import Any
from arq import ArqRedis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import update_frame
from app.tasks.utils import get_fresh_frame

async def reset_frame(id: int, redis: ArqRedis):
    await redis.enqueue_job("reset_frame", id=id)

async def reset_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: ArqRedis = ctx['redis']

    frame = get_fresh_frame(db, id)
    if frame and frame.status != 'uninitialized':
        frame.status = 'uninitialized'
        await update_frame(db, redis, frame)
    await log(db, redis, id, "admin", "Resetting frame status to 'uninitialized'")
