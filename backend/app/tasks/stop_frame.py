from typing import Any
from arq import ArqRedis
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

async def stop_frame(id: int, redis: ArqRedis):
    await redis.enqueue_job("stop_frame", id=id)

async def stop_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    try:
        frame = db.get(Frame, id)
        if not frame:
            return

        frame.status = 'stopping'
        await update_frame(db, redis, frame)

        ssh = await get_ssh_connection(db, redis, frame)
        await exec_command(db, redis, frame, ssh, "sudo systemctl stop frameos.service || true")
        await exec_command(db, redis, frame, ssh, "sudo systemctl disable frameos.service")

        frame.status = 'stopped'
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
    finally:
        if ssh is not None:
            ssh.close()
            await log(db, redis, id, "stdinfo", "SSH connection closed")
            remove_ssh_connection(ssh)
