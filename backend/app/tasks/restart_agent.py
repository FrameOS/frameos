from typing import Any
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame
from app.utils.remote_exec import run_commands

async def restart_agent(id: int, redis: Redis):
    await redis.enqueue_job("restart_agent", id=id)

async def restart_agent_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = db.get(Frame, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    try:
        await run_commands(
            db,
            redis,
            frame,
            ["sudo systemctl restart frameos_agent.service"]
        )

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
