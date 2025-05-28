from typing import Any
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection

async def restart_agent(id: int, redis: Redis):
    await redis.enqueue_job("restart_agent", id=id)

async def restart_agent_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    frame = db.get(Frame, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    try:
        ssh = await get_ssh_connection(db, redis, frame)
        await exec_command(db, redis, frame, ssh, "sudo systemctl stop frameos_agent.service || true")
        await exec_command(db, redis, frame, ssh, "sudo systemctl enable frameos_agent.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl start frameos_agent.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl status frameos_agent.service")

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
    finally:
        if ssh is not None:
            await remove_ssh_connection(db, redis, ssh, frame)
