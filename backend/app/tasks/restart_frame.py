from typing import Any
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.models.frame import Frame
from app.models.log import new_log as log
from app.models.frame import update_frame
from app.tasks.utils import get_fresh_frame
from app.utils.remote_exec import run_commands

async def restart_frame(id: int, redis: Redis):
    await redis.enqueue_job("restart_frame", id=id)


async def _embedded_device_action(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    path: str,
    pending_status: str,
    final_status: str | None,
    action_label: str,
) -> None:
    """POST an /api/action/* verb on an embedded device over LAN HTTP.

    Microcontrollers have no SSH or systemd; the firmware exposes restart and
    reboot as authenticated HTTP actions (on ESP32 the runtime IS the firmware,
    so both reboot the chip). Status transitions mirror the SSH paths.
    """
    from app.tasks.embedded_firmware import embedded_platform_spec_for_frame
    from app.utils.frame_http import _fetch_frame_http_bytes

    if embedded_platform_spec_for_frame(frame)["family"] == "virtual":
        await log(db, redis, int(frame.id),
                  "stderr", f"Virtual frames have no device to {action_label}")
        return

    try:
        frame.status = pending_status
        await update_frame(db, redis, frame)

        status, body, _headers = await _fetch_frame_http_bytes(
            frame,
            redis,
            path=path,
            method="POST",
        )
        if status >= 300:
            detail = body.decode("utf-8", errors="replace").strip()
            raise Exception(
                f"Embedded {action_label} request failed with HTTP {status}"
                + (f": {detail}" if detail else "")
            )
        await log(db, redis, int(frame.id), "stdout",
                  f"Requested embedded {action_label}; the device reboots in about a second")

        if final_status is not None:
            frame.status = final_status
            await update_frame(db, redis, frame)
    except Exception as e:
        await log(db, redis, int(frame.id), "stderr", str(e))
        frame.status = "uninitialized"
        await update_frame(db, redis, frame)


async def restart_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    if (frame.mode or "rpios") == "embedded":
        await _embedded_device_action(
            db,
            redis,
            frame,
            path="/api/action/restart",
            pending_status="restarting",
            final_status="starting",
            action_label="restart",
        )
        return

    try:
        frame.status = "restarting"
        await update_frame(db, redis, frame)

        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo -n systemctl stop frameos.service || true",
                "sudo -n systemctl enable frameos.service",
                "sudo -n systemctl start frameos.service",
                "sudo -n systemctl status frameos.service",
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

    frame = get_fresh_frame(db, id)
    if not frame:
        await log(db, redis, id, "stderr", "Frame not found")
        return

    if (frame.mode or "rpios") == "embedded":
        await _embedded_device_action(
            db,
            redis,
            frame,
            path="/api/action/reboot",
            pending_status="rebooting",
            # The SSH path leaves the frame in "rebooting" until it reports
            # back; the embedded device's bootup log flips it to "ready".
            final_status=None,
            action_label="reboot",
        )
        return

    try:
        frame.status = "rebooting"
        await update_frame(db, redis, frame)
        await run_commands(
            db,
            redis,
            frame,
            [
                "sudo -n reboot",
            ],
        )

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        frame.status = "uninitialized"
        await update_frame(db, redis, frame)
