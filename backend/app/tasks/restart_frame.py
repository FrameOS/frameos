from typing import Any
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection

async def restart_frame(id: int, redis: Redis):
    await redis.enqueue_job("restart_frame", id=id)

async def restart_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    frame = None
    try:
        frame = db.get(Frame, id)
        if not frame:
            await log(db, redis, id, "stderr", "Frame not found")
            return

        frame.status = 'restarting'
        await update_frame(db, redis, frame)

        ssh = await get_ssh_connection(db, redis, frame)
        await exec_command(db, redis, frame, ssh, "sudo systemctl stop frameos.service || true")
        await exec_command(db, redis, frame, ssh, "sudo systemctl enable frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl start frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl status frameos.service")

        frame.status = 'starting'
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
            await remove_ssh_connection(ssh)
