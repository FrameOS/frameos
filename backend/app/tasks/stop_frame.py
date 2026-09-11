from typing import Any
from arq import ArqRedis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import frame_has_shell_access, update_frame
from app.tasks.utils import get_fresh_frame, record_task_failure
from app.utils.remote_exec import run_commands

async def stop_frame(id: int, redis: ArqRedis):
    await redis.enqueue_job("stop_frame", id=id)

async def stop_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: ArqRedis = ctx['redis']

    frame = None
    try:
        frame = get_fresh_frame(db, id)
        if not frame:
            return

        if not frame_has_shell_access(frame):
            # The runtime cannot stop itself for good: its admin API has
            # restart and reboot, and systemd brings a stopped process back.
            await log(db, redis, id, "stderr",
                      "No shell on this frame: stopping frameos.service needs SSH or FrameOS Remote. "
                      "Use Restart FrameOS or Reboot instead.")
            return

        frame.status = 'stopping'
        await update_frame(db, redis, frame)
        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo -n systemctl stop frameos.service || true",
            ],
        )
        frame.status = 'stopped'
        await update_frame(db, redis, frame)

    except Exception as e:
        await record_task_failure(db, redis, id, e, frame=frame)
        raise
