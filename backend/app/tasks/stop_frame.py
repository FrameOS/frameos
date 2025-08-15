from typing import Any
from arq import ArqRedis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.remote_exec import run_commands

async def stop_frame(id: int, redis: ArqRedis):
    await redis.enqueue_job("stop_frame", id=id)

async def stop_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: ArqRedis = ctx['redis']

    frame = None
    try:
        frame = db.get(Frame, id)
        if not frame:
            return

        frame.status = 'stopping'
        await update_frame(db, redis, frame)
        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo systemctl stop frameos.service || true",
            ],
        )
        frame.status = 'stopped'
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
