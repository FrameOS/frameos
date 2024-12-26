from typing import Any
from arq import ArqRedis
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

async def reset_frame(id: int, redis: ArqRedis):
    await redis.enqueue_job("reset_frame", id=id)

async def reset_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = db.get(Frame, id)
    if frame and frame.status != 'uninitialized':
        frame.status = 'uninitialized'
        await update_frame(db, redis, frame)
    await log(db, redis, id, "admin", "Resetting frame status to 'uninitialized'")
