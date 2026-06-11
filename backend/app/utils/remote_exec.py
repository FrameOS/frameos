from __future__ import annotations
from typing import Literal, Tuple

import asyncio
import base64
import json
import time
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
from app.ws.agent_bridge import frame_command_slot

from app.utils.ssh_utils import (
    get_ssh_connection,
    exec_command,
    remove_ssh_connection,
)

__all__ = [
    "RemoteTransport",
    "run_commands",
    "run_command",
    "upload_file",
    "delete_path",
    "rename_path",
    "make_dir",
]  # what the tasks import

CHUNK_SIZE   = 2* 1024 * 1024  # 2 Mib
CHUNK_ZLEVEL = 6               # good compromise

UPLOAD_PROGRESS_INTERVAL_SECONDS = 30  # how often to log upload progress
SCP_STALL_TIMEOUT_SECONDS = 90         # abort the transfer when no bytes move for this long
SCP_MAX_ATTEMPTS = 3

RemoteTransport = Literal["auto", "agent", "ssh"]

# ---------------------------------------------------------------------------#
# internal helpers                                                           #
# ---------------------------------------------------------------------------#


async def _use_agent(frame: Frame, redis: Redis, transport: RemoteTransport = "auto") -> bool:
    """
    Returns True if we can use the WebSocket agent for this frame.
    """
    if transport not in {"auto", "agent", "ssh"}:
        raise ValueError(f"Invalid remote transport: {transport}")
    if transport == "ssh":
        return False

    agent = frame.agent or {}
    if agent.get("agentEnabled") and agent.get("agentRunCommands"):
        if transport == "auto" and agent.get("deployWithAgent") is False:
            return False
        if (await number_of_connections_for_frame(redis, frame.id)) <= 0:
            raise RuntimeError(f"Frame {frame.id} agent disconnected, can't run commands. Try running over SSH instead.")
        return True
    if transport == "agent":
        raise RuntimeError(f"Frame {frame.id} agent command transport is not enabled")
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
    async with frame_command_slot(frame.id):
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
    async with frame_command_slot(frame.id):
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
    size = len(data)
    last_report = time.monotonic()
    await file_write_open_on_frame(frame.id, remote_path,
                                   meta={"compression": "zlib"}, redis=redis)
    for off in range(0, len(data), CHUNK_SIZE):
        raw  = data[off:off+CHUNK_SIZE]
        comp = zlib.compress(raw, CHUNK_ZLEVEL)
        await file_write_chunk_on_frame(frame.id, comp, timeout, redis=redis)
        if time.monotonic() - last_report >= UPLOAD_PROGRESS_INTERVAL_SECONDS:
            last_report = time.monotonic()
            sent = min(off + CHUNK_SIZE, size)
            await log(db, redis, frame.id, "stdout",
                      f"> upload progress: {print_size(sent)} / {print_size(size)}")
    await file_write_close_on_frame(frame.id, redis=redis)

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
    transport: RemoteTransport = "auto",
) -> None:
    """
    Execute *commands* (in order) on the frame. Either via the WebSocket agent or via SSH.
    """

    if await _use_agent(frame, redis, transport):
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

async def _scp_with_progress(
    db: Session,
    redis: Redis,
    frame: Frame,
    ssh: asyncssh.SSHClientConnection,
    local_path: str,
    remote_path: str,
    size: int,
) -> None:
    """
    Run one scp transfer, logging progress every UPLOAD_PROGRESS_INTERVAL_SECONDS
    and raising TimeoutError when no bytes move for SCP_STALL_TIMEOUT_SECONDS.
    """
    progress = {"sent": 0, "at": time.monotonic()}

    def _on_progress(_srcpath, _dstpath, bytes_sent, _total_bytes):
        if bytes_sent > progress["sent"]:
            progress["sent"] = bytes_sent
            progress["at"] = time.monotonic()

    scp_task = asyncio.ensure_future(asyncssh.scp(
        local_path,
        (ssh, shlex.quote(remote_path)),
        recurse=False,
        progress_handler=_on_progress,
    ))
    last_report = time.monotonic()
    try:
        while True:
            done, _ = await asyncio.wait({scp_task}, timeout=1.0)
            if done:
                scp_task.result()
                return
            now = time.monotonic()
            if now - progress["at"] >= SCP_STALL_TIMEOUT_SECONDS:
                raise TimeoutError(
                    f"scp upload stalled: no progress for {SCP_STALL_TIMEOUT_SECONDS}s "
                    f"({print_size(progress['sent'])} / {print_size(size)} sent)"
                )
            if now - last_report >= UPLOAD_PROGRESS_INTERVAL_SECONDS:
                last_report = now
                percent = progress["sent"] * 100 // size if size else 100
                await log(db, redis, frame.id, "stdout",
                          f"> scp progress: {print_size(progress['sent'])} / {print_size(size)} ({percent}%)")
    finally:
        if not scp_task.done():
            scp_task.cancel()
            try:
                await scp_task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                pass


async def upload_file(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
    data: bytes,
    *,
    timeout: int = 120,
    transport: RemoteTransport = "auto",
) -> None:
    """
    Write *data* to *remote_path* on the device:
    """
    size = len(data)

    if await _use_agent(frame, redis, transport):
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

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        last_error: Exception | None = None
        for attempt in range(1, SCP_MAX_ATTEMPTS + 1):
            ssh = await get_ssh_connection(db, redis, frame)
            broken = False
            try:
                suffix = f" (attempt {attempt}/{SCP_MAX_ATTEMPTS})" if attempt > 1 else ""
                await log(db, redis, frame.id, "stdout", f"> scp → {remote_path} ({print_size(size)}){suffix}")
                await _scp_with_progress(db, redis, frame, ssh, tmp_path, remote_path, size)
                return
            except (TimeoutError, asyncssh.Error, OSError) as e:
                last_error = e
                broken = True
                await log(db, redis, frame.id, "stderr", f"> scp upload failed: {e}")
            finally:
                if broken:
                    # A stalled or failed transfer usually means a dead TCP
                    # connection; close it so the pool can't hand it out again.
                    ssh.abort()
                await remove_ssh_connection(db, redis, ssh, frame)
        raise RuntimeError(
            f"scp upload of {remote_path} failed after {SCP_MAX_ATTEMPTS} attempts"
        ) from last_error
    finally:
        os.remove(tmp_path)


async def delete_path(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
    *,
    timeout: int = 120,
    transport: RemoteTransport = "auto",
) -> None:
    """Delete a file or directory on the device."""

    if await _use_agent(frame, redis, transport):
        from app.ws.agent_ws import file_delete_on_frame

        try:
            await log(db, redis, frame.id, "stdout", f"> rm -rf {remote_path} (agent)")
            await file_delete_on_frame(frame.id, remote_path, timeout, redis=redis)
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
    transport: RemoteTransport = "auto",
) -> None:
    """Rename a file or directory on the device."""

    if await _use_agent(frame, redis, transport):
        from app.ws.agent_ws import file_rename_on_frame

        try:
            await log(db, redis, frame.id, "stdout", f"> mv {src} {dst} (agent)")
            await file_rename_on_frame(frame.id, src, dst, timeout, redis=redis)
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
    transport: RemoteTransport = "auto",
) -> None:
    """Create a directory on the device."""

    if await _use_agent(frame, redis, transport):
        from app.ws.agent_ws import file_mkdir_on_frame

        try:
            await log(
                db, redis, frame.id, "stdout", f"> mkdir -p {remote_path} (agent)"
            )
            await file_mkdir_on_frame(frame.id, remote_path, timeout, redis=redis)
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
    log_command: str | bool = True,
) -> Tuple[int, str, str]:
    """
    Execute *cmd* via the WebSocket agent, collecting stdout/stderr that are
    streamed through Redis (see STREAM_KEY in app.ws.agent_bridge).
    Returns (exit_status, stdout, stderr).
    """
    async with frame_command_slot(frame.id):
        cmd_id = str(uuid.uuid4())
        payload = {"type": "cmd", "name": "shell", "args": {"cmd": cmd}}

        if log_command:
            await log(db, redis, frame.id, "stdout", f"> {log_command if isinstance(log_command, str) else cmd}")

        from app.ws.agent_bridge import CMD_KEY, STREAM_KEY, RESP_KEY

        job = {
            "id":       cmd_id,
            "frame_id": frame.id,
            "payload":  payload,
            "timeout":  timeout,
            "log": bool(log_output),
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
    log_command: str | bool = True
) -> Tuple[int, str, str]:
    """
    Execute *cmd* over SSH, capturing stdout & stderr separately.
    Works whether the channel is opened in text (default) or binary mode.
    """
    ssh = await get_ssh_connection(db, redis, frame)
    try:
        if log_command:
            await log(db, redis, frame.id, "stdout", f"> {log_command if isinstance(log_command, str) else cmd}")

        proc = await ssh.create_process(cmd)

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        async def _read_stream(stream, dest: list[str], log_type: str) -> None:
            buf = ""
            while True:
                chunk = await stream.read(32768)
                if not chunk:
                    break
                if isinstance(chunk, (bytes, bytearray)):
                    chunk = chunk.decode(errors="ignore")
                buf += chunk

                # Emit complete lines; keep last partial in buf
                *lines, buf = buf.split("\n")
                for ln in lines:
                    ln = ln.rstrip("\r")
                    dest.append(ln)              # <<< store it
                    if log_output:
                        await log(db, redis, frame.id, log_type, ln)

            # Flush any leftover partial line at EOF
            if buf:
                ln = buf.rstrip("\r")
                dest.append(ln)                  # <<< store the final partial
                if log_output:
                    await log(db, redis, frame.id, log_type, ln)

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
    log_command: str | bool = True,
    transport: RemoteTransport = "auto",
) -> Tuple[int, str, str]:
    """
    Run a single *command* on *frame* and capture its textual output.

    • If the WebSocket agent is enabled & connected it is used first
    • Otherwise the function falls back to SSH.

    Returns a tuple: **(exit_status, stdout, stderr)** – all text.
    """
    if await _use_agent(frame, redis, transport):
        return await _run_command_agent(db, redis, frame, command, timeout, log_output=log_output, log_command=log_command)
    return await _run_command_ssh(db, redis, frame, command, timeout, log_output=log_output, log_command=log_command)
