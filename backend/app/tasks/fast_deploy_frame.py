from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.tasks._frame_deployer import FrameDeployer
from app.utils.frame_http import _fetch_frame_http_bytes


TLS_SETTINGS_KEYS = (
    "enable_tls",
    "tls_port",
    "expose_only_tls_port",
    "tls_server_cert",
    "tls_server_key",
    "tls_client_ca_cert",
)


def tls_settings_changed(frame: Frame) -> bool:
    if not frame.last_successful_deploy:
        return False

    previous_deploy = frame.last_successful_deploy or {}
    return any(previous_deploy.get(key) != getattr(frame, key) for key in TLS_SETTINGS_KEYS)


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

        frame_dict = frame.to_dict()  # persisted as frame.last_successful_deploy if successful
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

        try:
            if tls_settings_changed(frame):
                await log(db, redis, id, "stdout", "- TLS settings changed, restarting FrameOS service")
                await self.restart_service("frameos")
            else:
                status, body, _headers = await _fetch_frame_http_bytes(
                    frame, redis, path="/reload", method="POST"
                )
                if status >= 300:
                    message = body.decode("utf-8", errors="replace")
                    await log(db, redis, id, "stderr", f"Reload failed with status {status}: {message}. Restarting service.")
                    await self.restart_service("frameos")
        except Exception as e:
            await log(db, redis, id, "stderr", f"Reload request failed: {str(e)}. Restarting service.")
            await self.restart_service("frameos")

        previously_deployed_tls = bool((frame.last_successful_deploy or {}).get("enable_tls"))

        if not frame.enable_tls and not previously_deployed_tls:
            caddy_active = (
                await self.exec_command(
                    "sudo systemctl is-active --quiet caddy.service",
                    raise_on_error=False,
                    log_output=False,
                    log_command=False,
                )
                == 0
            )
        else:
            caddy_active = False

        if not frame.enable_tls and (previously_deployed_tls or caddy_active):
            await log(db, redis, id, "stdout", "🟢 TLS proxy disabled, stopping Caddy")
            await self.exec_command("sudo systemctl disable --now caddy.service", raise_on_error=False)

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
