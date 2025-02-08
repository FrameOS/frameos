from datetime import datetime, timezone
import json
import os
import tempfile
from typing import Any
import asyncssh
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection

async def fast_deploy_frame(id: int, redis: Redis):
    await redis.enqueue_job("fast_deploy_frame", id=id)

async def fast_deploy_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    frame = None
    try:
        frame = db.get(Frame, id)
        if not frame:
            await log(db, redis, id, "stderr", "Frame not found")
            return

        ssh = await get_ssh_connection(db, redis, frame)

        frame.status = 'restarting'
        await update_frame(db, redis, frame)

        await exec_command(db, redis, frame, ssh, "sudo systemctl stop frameos.service || true")

        frame_dict = frame.to_dict() # persisted as frame.last_successful_deploy if successful
        if "last_successful_deploy" in frame_dict:
            del frame_dict["last_successful_deploy"]
        if "last_successful_deploy_at" in frame_dict:
            del frame_dict["last_successful_deploy_at"]

        # Upload new frame.json
        frame_json_data = (json.dumps(get_frame_json(db, frame), indent=4) + "\n").encode('utf-8')
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmpf:
            local_json_path = tmpf.name
            tmpf.write(frame_json_data)
        await asyncssh.scp(
            local_json_path, (ssh, "/srv/frameos/current/frame.json"),
            recurse=False
        )
        os.remove(local_json_path)  # remove local temp file
        await log(db, redis, id, "stdout", "> updated /srv/frameos/current/frame.json")

        await exec_command(db, redis, frame, ssh, "sudo systemctl enable frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl start frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl status frameos.service")

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
    finally:
        if ssh is not None:
            await remove_ssh_connection(db, redis, ssh, frame)
