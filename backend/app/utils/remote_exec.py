from __future__ import annotations

import base64
import json
import uuid
import asyncssh
import gzip
import tempfile
import os
import shlex

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

__all__ = [
    "run_commands",
    "upload_file",
    "delete_path",
    "rename_path",
    "make_dir",
]  # what the tasks import

# ---------------------------------------------------------------------------#
# internal helpers                                                           #
# ---------------------------------------------------------------------------#


async def _use_agent(frame: Frame, redis: Redis) -> bool:
    """
    Returns True if we can use the WebSocket agent for this frame.
    """
    agent = frame.agent or {}
    if agent.get("agentEnabled") and agent.get("agentRunCommands"):
        if (await number_of_connections_for_frame(redis, frame.id)) <= 0:
            raise RuntimeError(
                f"Frame {frame.id} agent enabled, but offline. Can't connect."
            )
        return True
    return False


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
    res = await redis.blpop(resp_key, timeout=timeout)
    if res is None:  # ⬅︎ handle timeout
        raise TimeoutError(
            f"_exec_via_agent via agent timed-out after {timeout}s "
            f"(frame {frame.id}, command: {cmd})"
        )

    _key, raw = res
    reply = json.loads(raw)

    if not reply.get("ok"):
        raise RuntimeError(reply.get("error", "agent error"))


async def _file_write_via_agent(
    redis: Redis,
    frame: Frame,
    remote_path: str,
    data: bytes,
    timeout: int,
) -> None:
    cmd_id = str(uuid.uuid4())
    zipped = gzip.compress(data)
    payload = {
        "type": "cmd",
        "name": "file_write",
        "args": {"path": remote_path, "size": len(zipped)},
    }

    message = {
        "id": cmd_id,
        "frame_id": frame.id,
        "payload": payload,
        "timeout": timeout,
        "blob": base64.b64encode(zipped).decode(),
    }

    await redis.rpush("agent:cmd:queue", json.dumps(message).encode())

    resp_key = f"agent:resp:{cmd_id}"
    res = await redis.blpop(resp_key, timeout=timeout)
    if res is None:  # ⬅︎ handle timeout
        raise TimeoutError(
            f"file_write via agent timed-out after {timeout}s "
            f"(frame {frame.id}, path {remote_path})"
        )

    _key, raw = res
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
    Execute *commands* (in order) on the frame. Either via the WebSocket agent or via SSH.
    """

    if await _use_agent(frame, redis):
        for cmd in commands:
            await log(db, redis, frame.id, "stdout", f"> {cmd}")
            try:
                await _exec_via_agent(redis, frame, cmd, timeout)
            except Exception as e:
                await log(
                    db,
                    redis,
                    frame.id,
                    "stderr",
                    f"Agent exec error: {e}",
                )
                raise

        return

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        for cmd in commands:
            await exec_command(db, redis, frame, ssh, cmd)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def upload_file(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
    data: bytes,
    *,
    timeout: int = 120,
) -> None:
    """
    Write *data* to *remote_path* on the device:
    """

    if await _use_agent(frame, redis):
        try:
            await log(db, redis, frame.id, "stdout", f"> write {remote_path} (agent)")
            await _file_write_via_agent(redis, frame, remote_path, data, timeout)
            await log(
                db,
                redis,
                frame.id,
                "stdout",
                f"> file written to {remote_path} (agent)",
            )
            return
        except Exception as e:  # noqa: BLE001
            await log(
                db,
                redis,
                frame.id,
                "stderr",
                f"Agent file_write error ({e})",
            )
            raise

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        await log(db, redis, frame.id, "stdout", f"> scp → {remote_path}")
        await asyncssh.scp(
            tmp_path,
            (ssh, shlex.quote(remote_path)),
            recurse=False,
        )
    finally:
        os.remove(tmp_path)
        await remove_ssh_connection(db, redis, ssh, frame)


async def delete_path(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
    *,
    timeout: int = 120,
) -> None:
    """Delete a file or directory on the device."""

    if await _use_agent(frame, redis):
        from app.ws.agent_ws import file_delete_on_frame

        try:
            await log(db, redis, frame.id, "stdout", f"> rm -rf {remote_path} (agent)")
            await file_delete_on_frame(frame.id, remote_path, timeout)
            return
        except Exception as e:  # noqa: BLE001
            await log(db, redis, frame.id, "stderr", f"Agent delete error ({e})")
            raise

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"rm -rf {shlex.quote(remote_path)}"
        await exec_command(db, redis, frame, ssh, cmd)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def rename_path(
    db: Session,
    redis: Redis,
    frame: Frame,
    src: str,
    dst: str,
    *,
    timeout: int = 120,
) -> None:
    """Rename a file or directory on the device."""

    if await _use_agent(frame, redis):
        from app.ws.agent_ws import file_rename_on_frame

        try:
            await log(db, redis, frame.id, "stdout", f"> mv {src} {dst} (agent)")
            await file_rename_on_frame(frame.id, src, dst, timeout)
            return
        except Exception as e:  # noqa: BLE001
            await log(db, redis, frame.id, "stderr", f"Agent rename error ({e})")
            raise

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"mv {shlex.quote(src)} {shlex.quote(dst)}"
        await exec_command(db, redis, frame, ssh, cmd)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def make_dir(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
    *,
    timeout: int = 120,
) -> None:
    """Create a directory on the device."""

    if await _use_agent(frame, redis):
        from app.ws.agent_ws import file_mkdir_on_frame

        try:
            await log(
                db, redis, frame.id, "stdout", f"> mkdir -p {remote_path} (agent)"
            )
            await file_mkdir_on_frame(frame.id, remote_path, timeout)
            return
        except Exception as e:  # noqa: BLE001
            await log(db, redis, frame.id, "stderr", f"Agent mkdir error ({e})")
            raise

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"mkdir -p {shlex.quote(remote_path)}"
        await exec_command(db, redis, frame, ssh, cmd)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)