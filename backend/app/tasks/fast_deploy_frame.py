from datetime import datetime, timezone
import json
from typing import Any

from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.remote_exec import run_commands
from app.utils.remote_exec import upload_file

async def fast_deploy_frame(id: int, redis: Redis):
    await redis.enqueue_job("fast_deploy_frame", id=id)

async def fast_deploy_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = None
    try:
        frame = db.get(Frame, id)
        if not frame:
            await log(db, redis, id, "stderr", "Frame not found")
            return

        frame.status = "restarting"
        await update_frame(db, redis, frame)

        await run_commands(
            db,
            redis,
            frame,
            ["sudo systemctl stop frameos.service || true"],
        )

        frame_dict = frame.to_dict() # persisted as frame.last_successful_deploy if successful
        if "last_successful_deploy" in frame_dict:
            del frame_dict["last_successful_deploy"]
        if "last_successful_deploy_at" in frame_dict:
            del frame_dict["last_successful_deploy_at"]

        frame_json_data = (
            json.dumps(get_frame_json(db, frame), indent=4).encode() + b"\n"
        )
        await upload_file(
            db,
            redis,
            frame,
            "/srv/frameos/current/frame.json",
            frame_json_data,
        )

        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo systemctl enable frameos.service",
                "sudo systemctl start frameos.service",
                "sudo systemctl status frameos.service",
            ],
        )

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
