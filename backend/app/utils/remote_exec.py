from __future__ import annotations

import json
import uuid

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.ws.agent_ws import number_of_connections_for_frame

from app.utils.ssh_utils import (
    get_ssh_connection,
    exec_command,
    remove_ssh_connection,
)

__all__ = ["run_commands"]  # what the tasks import

# ---------------------------------------------------------------------------#
# internal helpers                                                           #
# ---------------------------------------------------------------------------#

async def _use_agent(redis: Redis, frame: Frame) -> bool:
    """Return *True* when at least one agent websocket is alive for *frame*."""
    return (await number_of_connections_for_frame(redis, frame.id)) > 0

async def _exec_via_agent(
    redis: Redis,
    frame: Frame,
    cmd: str,
    timeout: int,
) -> None:
    """
    Push one *cmd* into the Redis bridge and wait for completion.
    """
    cmd_id = str(uuid.uuid4())
    payload = {"type": "cmd", "name": "shell", "args": {"cmd": cmd}}

    message = {
        "id": cmd_id,
        "frame_id": frame.id,
        "payload": payload,
        "timeout": timeout,
    }

    await redis.rpush("agent:cmd:queue", json.dumps(message).encode())

    resp_key = f"agent:resp:{cmd_id}"
    _key, raw = await redis.blpop(resp_key, timeout=timeout)
    reply = json.loads(raw)

    if not reply.get("ok"):
        raise RuntimeError(reply.get("error", "agent error"))


# ---------------------------------------------------------------------------#
# public facade                                                              #
# ---------------------------------------------------------------------------#


async def run_commands(
    db: Session,
    redis: Redis,
    frame: Frame,
    commands: list[str],
    *,
    timeout: int = 120,
) -> None:
    """
    Execute *commands* (in order) on the frame.

    1. Prefer direct agent --> ``exec_shell_on_frame``.
    2. If no agent (or it fails), fall back to SSH transparently.
    3. Emit logs exactly like the legacy SSH path so the UI stays identical.
    """

    # ── 1) Try agent ──────────────────────────────────────────────────────
    if await _use_agent(redis, frame):
        for cmd in commands:
            await log(db, redis, frame.id, "stdout", f"> {cmd}")
            try:
                await _exec_via_agent(redis, frame, cmd, timeout)
                continue
            except Exception as e:  # noqa: BLE001
                await log(
                    db,
                    redis,
                    frame.id,
                    "stderr",
                    f"Agent exec error ({e}); falling back to SSH",
                )
                break  # drop to SSH path below

    # ── 2) SSH fallback ───────────────────────────────────────────────────
    ssh = await get_ssh_connection(db, redis, frame)
    try:
        for cmd in commands:
            await exec_command(db, redis, frame, ssh, cmd)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)
