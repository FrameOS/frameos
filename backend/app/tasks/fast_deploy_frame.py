from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.tasks._frame_deployer import FrameDeployer
from app.utils.frame_http import _fetch_frame_http_bytes

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

        frame.status = "deploying"
        await update_frame(db, redis, frame)

        self = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")

        frame_dict = frame.to_dict() # persisted as frame.last_successful_deploy if successful
        if "last_successful_deploy" in frame_dict:
            del frame_dict["last_successful_deploy"]
        if "last_successful_deploy_at" in frame_dict:
            del frame_dict["last_successful_deploy_at"]

        distro = await self.get_distro()
        if distro == 'nixos':
            await self._upload_frame_json("/var/lib/frameos/frame.json")
            await self._upload_scenes_json("/var/lib/frameos/scenes.json.gz", gzip=True)
        else:
            await self._upload_frame_json("/srv/frameos/current/frame.json")
            await self._upload_scenes_json("/srv/frameos/current/scenes.json.gz", gzip=True)

        status, body, _headers = await _fetch_frame_http_bytes(
            frame, redis, path="/reload", method="POST"
        )
        if status >= 300:
            message = body.decode("utf-8", errors="replace")
            raise Exception(f"Reload failed with status {status}: {message}")

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
