from typing import Any
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.remote_exec import run_commands

async def restart_frame(id: int, redis: Redis):
    await redis.enqueue_job("restart_frame", id=id)

async def restart_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = db.get(Frame, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    try:
        frame.status = "restarting"
        await update_frame(db, redis, frame)

        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo systemctl stop frameos.service || true",
                "sudo systemctl enable frameos.service",
                "sudo systemctl start frameos.service",
                "sudo systemctl status frameos.service",
            ],
        )

        frame.status = "starting"
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        frame.status = "uninitialized"
        await update_frame(db, redis, frame)

async def reboot_frame(id: int, redis: Redis):
    await redis.enqueue_job("reboot_frame", id=id)

async def reboot_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = db.get(Frame, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    try:
        frame.status = "rebooting"
        await update_frame(db, redis, frame)

        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo reboot",
            ],
        )

        frame.status = "starting"
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        frame.status = "uninitialized"
        await update_frame(db, redis, frame)
