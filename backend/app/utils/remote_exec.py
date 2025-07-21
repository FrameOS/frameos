from __future__ import annotations
from typing import Tuple

import asyncio
import base64
import json
import uuid
import asyncssh
import gzip
import tempfile
import os
import shlex
import zlib

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.ws.agent_ws import number_of_connections_for_frame, file_write_open_on_frame, file_write_chunk_on_frame, file_write_close_on_frame

from app.utils.ssh_utils import (
    get_ssh_connection,
    exec_command,
    remove_ssh_connection,
)

__all__ = [
    "run_commands",
    "run_command",
    "upload_file",
    "delete_path",
    "rename_path",
    "make_dir",
]  # what the tasks import

CHUNK_SIZE   = 2* 1024 * 1024  # 2 Mib
CHUNK_ZLEVEL = 6               # good compromise

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

    await redis.rpush(f"agent:cmd:{frame.id}", json.dumps(message).encode())

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

    await redis.rpush(f"agent:cmd:{frame.id}", json.dumps(message).encode())

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

async def _stream_file_via_agent(db, redis, frame, remote_path, data, timeout: int = 120):
    await file_write_open_on_frame(frame.id, remote_path,
                                   meta={"compression": "zlib"})
    for off in range(0, len(data), CHUNK_SIZE):
        raw  = data[off:off+CHUNK_SIZE]
        comp = zlib.compress(raw, CHUNK_ZLEVEL)
        await file_write_chunk_on_frame(frame.id, comp, timeout)
    await file_write_close_on_frame(frame.id)

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
    log_output: bool = True,
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
            await exec_command(db, redis, frame, ssh, cmd, log_output=log_output)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


def print_size(size: int) -> str:
    """
    Format a size in bytes into a human-readable string.
    """
    if size < 1024:
        return f"{size} B"
    size //= 1024
    if size < 1024:
        return f"{size} KiB"
    size //= 1024
    if size < 1024:
        return f"{size} MiB"
    size //= 1024
    return f"{size} GiB"

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
    size = len(data)

    if await _use_agent(frame, redis):
        try:
            await log(db, redis, frame.id, "stdout", f"> uploading {remote_path} ({print_size(size)} via agent)")
            await _stream_file_via_agent(db, redis, frame, remote_path, data)
            # TODO: restore faster path for smaller files?
            # if len(data) > 2 * 1024 * 1024:           # >2 MiB → streamed
            # else:
            #     await _file_write_via_agent(redis, frame, remote_path, data, timeout)
            return
        except Exception as e:  # noqa: BLE001
            await log(
                db,
                redis,
                frame.id,
                "stderr",
                f"> ERROR writing {remote_path} ({print_size(size)} via agent) - {e}",
            )
            raise

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        await log(db, redis, frame.id, "stdout", f"> scp → {remote_path} ({print_size(size)})")
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


async def _run_command_agent(
    db: Session,
    redis: Redis,
    frame: Frame,
    cmd: str,
    timeout: int,
    *,
    log_output: bool = True,
) -> Tuple[int, str, str]:
    """
    Execute *cmd* via the WebSocket agent, collecting stdout/stderr that are
    streamed through Redis (see STREAM_KEY in app.ws.agent_bridge).
    Returns (exit_status, stdout, stderr).
    """
    cmd_id = str(uuid.uuid4())
    payload = {"type": "cmd", "name": "shell", "args": {"cmd": cmd}}

    await log(db, redis, frame.id, "stdout", f"> {cmd}")

    from app.ws.agent_bridge import CMD_KEY, STREAM_KEY, RESP_KEY

    job = {
        "id":       cmd_id,
        "frame_id": frame.id,
        "payload":  payload,
        "timeout":  timeout,
    }
    await redis.rpush(CMD_KEY.format(id=frame.id), json.dumps(job).encode())

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    exit_status: int | None = None

    # Wait for either stream chunks or the final response key
    stream_key = STREAM_KEY.format(id=cmd_id)
    resp_key   = RESP_KEY.format(id=cmd_id)

    while True:
        res = await redis.blpop([stream_key, resp_key], timeout=timeout)
        if res is None:
            raise TimeoutError(f"agent timed-out after {timeout}s (cmd: {cmd})")

        key_bytes, raw = res
        key = key_bytes.decode()

        # live stream -------------------------------------------------------
        if key == stream_key:
            chunk = json.loads(raw)
            (stdout_lines if chunk.get("stream") == "stdout"
                          else stderr_lines).append(chunk.get("data", ""))
            continue

        # final response ----------------------------------------------------
        if key == resp_key:
            reply = json.loads(raw)
            ok    = reply.get("ok", False)
            # shell reply → {"exit": <code>}
            if isinstance(reply.get("result"), dict) and "exit" in reply["result"]:
                exit_status = int(reply["result"]["exit"])
            else:  # fall-back
                exit_status = 0 if ok else 1
            break

    # drain anything still buffered
    leftover = await redis.lrange(stream_key, 0, -1)
    for raw in leftover:
        chunk = json.loads(raw)
        (stdout_lines if chunk.get("stream") == "stdout"
                      else stderr_lines).append(chunk.get("data", ""))
    await redis.delete(stream_key)

    return exit_status or 0, "\n".join(stdout_lines), "\n".join(stderr_lines)


async def _run_command_ssh(
    db: Session,
    redis: Redis,
    frame: Frame,
    cmd: str,
    timeout: int,
    *,
    log_output: bool = True,
) -> Tuple[int, str, str]:
    """
    Execute *cmd* over SSH, capturing stdout & stderr separately.
    Works whether the channel is opened in text (default) or binary mode.
    """
    ssh = await get_ssh_connection(db, redis, frame)
    try:
        await log(db, redis, frame.id, "stdout", f"> {cmd}")

        proc = await ssh.create_process(cmd)

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        async def _read_stream(stream, dest: list[str], log_type: str) -> None:
            while True:
                line = await stream.readline()
                if not line:
                    break
                if isinstance(line, (bytes, bytearray)):
                    line = line.decode(errors="ignore")
                line = line.rstrip("\n")
                dest.append(line)
                if log_output:
                    await log(db, redis, frame.id, log_type, line)

        stdout_task = asyncio.create_task(_read_stream(proc.stdout, stdout_lines, "stdout"))
        stderr_task = asyncio.create_task(_read_stream(proc.stderr, stderr_lines, "stderr"))

        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"SSH command timed-out after {timeout}s: {cmd}")

        await asyncio.gather(stdout_task, stderr_task)

        exit_status: int = proc.exit_status if proc.exit_status is not None else 1
        stdout = "\n".join(stdout_lines)
        stderr = "\n".join(stderr_lines)

        return exit_status, stdout, stderr
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def run_command(
    db: Session,
    redis: Redis,
    frame: Frame,
    command: str,
    *,
    timeout: int = 120,
    log_output: bool = True,
) -> Tuple[int, str, str]:
    """
    Run a single *command* on *frame* and capture its textual output.

    • If the WebSocket agent is enabled & connected it is used first
    • Otherwise the function falls back to SSH.

    Returns a tuple: **(exit_status, stdout, stderr)** – all text.
    """
    if await _use_agent(frame, redis):
        return await _run_command_agent(db, redis, frame, command, timeout, log_output=log_output)
    return await _run_command_ssh(db, redis, frame, command, timeout, log_output=log_output)
