from typing import Any
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.tasks.deploy_remote import delayed_agent_restart_command, resolve_agent_task_transport
from app.tasks.utils import get_fresh_frame
from app.utils.remote_exec import RemoteTransport, run_commands

async def restart_remote(id: int, redis: Redis, *, transport: RemoteTransport = "auto"):
    await redis.enqueue_job("restart_remote", id=id, transport=transport)

async def restart_remote_task(ctx: dict[str, Any], id: int, transport: RemoteTransport = "auto"):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    try:
        resolved_transport = resolve_agent_task_transport(frame, transport)
        await log(db, redis, id, "stdout", f"Restarting FrameOS Remote via {resolved_transport}")
        commands = (
            [delayed_agent_restart_command("manual")]
            if resolved_transport == "agent"
            else ["sudo systemctl restart frameos_agent.service"]
        )
        await run_commands(
            db,
            redis,
            frame,
            commands,
            transport=resolved_transport,
        )
        await log(db, redis, id, "stdout", "FrameOS Remote restart command completed")

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
