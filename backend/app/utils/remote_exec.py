from __future__ import annotations
from typing import Literal, Tuple, cast

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
from app.ws.remote_ws import number_of_connections_for_frame, file_write_open_on_frame, file_write_chunk_on_frame, file_write_close_on_frame
from app.ws.remote_bridge import frame_command_slot

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
SHELL_UPLOAD_BASE64_CHUNK_SIZE = 48 * 1024
REMOTE_SHELL_UPLOAD_MAX_SIZE = 8 * 1024 * 1024

RemoteTransport = Literal["auto", "remote", "ssh"]
REMOTE_TRANSPORT_VALUES = {"auto", "remote", "agent", "ssh"}


def normalize_remote_transport(transport: str) -> RemoteTransport:
    if transport == "agent":
        return "remote"
    if transport not in {"auto", "remote", "ssh"}:
        raise ValueError(f"Invalid remote transport: {transport}")
    return cast(RemoteTransport, transport)

# ---------------------------------------------------------------------------#
# internal helpers                                                           #
# ---------------------------------------------------------------------------#


async def _use_remote(frame: Frame, redis: Redis, transport: str = "auto") -> bool:
    """
    Returns True if we can use the WebSocket Remote for this frame.
    """
    transport = normalize_remote_transport(transport)
    if transport == "ssh":
        return False

    agent = frame.agent or {}
    if agent.get("agentEnabled") and agent.get("agentRunCommands"):
        if transport == "auto" and agent.get("deployWithAgent") is False:
            return False
        if (await number_of_connections_for_frame(redis, frame.id)) <= 0:
            raise RuntimeError(f"Frame {frame.id} remote disconnected, can't run commands. Try running over SSH instead.")
        return True
    if transport == "remote":
        raise RuntimeError(f"Frame {frame.id} remote command transport is not enabled")
    return False


async def _exec_via_remote(
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

        await redis.rpush(f"remote:cmd:{frame.id}", json.dumps(message).encode())

        resp_key = f"remote:resp:{cmd_id}"
        res = await redis.blpop(resp_key, timeout=timeout)
        if res is None:  # ⬅︎ handle timeout
            raise TimeoutError(
                f"_exec_via_remote via remote timed-out after {timeout}s "
                f"(frame {frame.id}, command: {cmd})"
            )

        _key, raw = res
        reply = json.loads(raw)

        if not reply.get("ok"):
            raise RuntimeError(reply.get("error", "remote error"))


async def _file_write_via_remote(
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
            "args": {"path": remote_path, "size": len(zipped), "compression": "gzip"},
        }

        message = {
            "id": cmd_id,
            "frame_id": frame.id,
            "payload": payload,
            "timeout": timeout,
            "blob": base64.b64encode(zipped).decode(),
        }

        await redis.rpush(f"remote:cmd:{frame.id}", json.dumps(message).encode())

        resp_key = f"remote:resp:{cmd_id}"
        res = await redis.blpop(resp_key, timeout=timeout)
        if res is None:  # ⬅︎ handle timeout
            raise TimeoutError(
                f"file_write via remote timed-out after {timeout}s "
                f"(frame {frame.id}, path {remote_path})"
            )

        _key, raw = res
        reply = json.loads(raw)

        if not reply.get("ok"):
            raise RuntimeError(reply.get("error", "remote error"))

async def _stream_file_via_remote(db, redis, frame, remote_path, data, timeout: int = 120):
    size = len(data)
    last_report = time.monotonic()
    try:
        await file_write_open_on_frame(frame.id, remote_path,
                                       meta={"compression": "zlib"}, redis=redis)
    except Exception as exc:
        raise RuntimeError(f"file_write_open failed: {exc}") from exc

    for off in range(0, len(data), CHUNK_SIZE):
        raw  = data[off:off+CHUNK_SIZE]
        comp = zlib.compress(raw, CHUNK_ZLEVEL)
        try:
            await file_write_chunk_on_frame(frame.id, comp, timeout, redis=redis)
        except Exception as exc:
            raise RuntimeError(f"file_write_chunk failed: {exc}") from exc
        if time.monotonic() - last_report >= UPLOAD_PROGRESS_INTERVAL_SECONDS:
            last_report = time.monotonic()
            sent = min(off + CHUNK_SIZE, size)
            await log(db, redis, frame.id, "stdout",
                      f"> upload progress: {print_size(sent)} / {print_size(size)}")
    try:
        await file_write_close_on_frame(frame.id, redis=redis)
    except Exception as exc:
        raise RuntimeError(f"file_write_close failed: {exc}") from exc


def _remote_stream_upload_can_fallback(exc: Exception) -> bool:
    message = str(exc).lower()
    if "file_write_open missing" in message:
        return True
    if "file_write_open" not in message and "file_write_chunk" not in message:
        return False
    return any(token in message for token in ("unknown", "missing", "timed-out", "timeout"))


async def _shell_upload_via_remote(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
    data: bytes,
    timeout: int,
) -> None:
    encoded = base64.b64encode(data).decode("ascii")
    parent = os.path.dirname(remote_path) or "."
    upload_id = uuid.uuid4().hex
    b64_path = f"{remote_path}.frameos-upload-{upload_id}.b64"
    tmp_path = f"{remote_path}.frameos-upload-{upload_id}.tmp"
    quoted_remote = shlex.quote(remote_path)
    quoted_parent = shlex.quote(parent)
    quoted_b64 = shlex.quote(b64_path)
    quoted_tmp = shlex.quote(tmp_path)

    await log(
        db,
        redis,
        frame.id,
        "stdout",
        f"> falling back to shell/base64 upload for {remote_path} ({print_size(len(data))})",
    )
    try:
        await _exec_via_remote(
            redis,
            frame,
            f"set -eu; mkdir -p {quoted_parent}; : > {quoted_b64}; rm -f {quoted_tmp}",
            timeout,
        )
        last_report = time.monotonic()
        for off in range(0, len(encoded), SHELL_UPLOAD_BASE64_CHUNK_SIZE):
            chunk = encoded[off:off + SHELL_UPLOAD_BASE64_CHUNK_SIZE]
            await _exec_via_remote(
                redis,
                frame,
                f"printf %s {shlex.quote(chunk)} >> {quoted_b64}",
                timeout,
            )
            if time.monotonic() - last_report >= UPLOAD_PROGRESS_INTERVAL_SECONDS:
                last_report = time.monotonic()
                sent = min((off + SHELL_UPLOAD_BASE64_CHUNK_SIZE) * 3 // 4, len(data))
                await log(
                    db,
                    redis,
                    frame.id,
                    "stdout",
                    f"> shell/base64 upload progress: {print_size(sent)} / {print_size(len(data))}",
                )

        await _exec_via_remote(
            redis,
            frame,
            "set -eu; "
            "if command -v base64 >/dev/null 2>&1; then "
            f"base64 -d {quoted_b64} > {quoted_tmp}; "
            "elif command -v python3 >/dev/null 2>&1; then "
            "python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))' "
            f"< {quoted_b64} > {quoted_tmp}; "
            "else echo 'base64 command missing' >&2; exit 127; fi; "
            f"mv {quoted_tmp} {quoted_remote}; rm -f {quoted_b64}",
            timeout,
        )
    except Exception:
        try:
            await _exec_via_remote(
                redis,
                frame,
                f"rm -f {quoted_b64} {quoted_tmp}",
                min(timeout, 30),
            )
        except Exception:  # noqa: BLE001
            pass
        raise

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
    Execute *commands* (in order) on the frame. Either via the WebSocket Remote or via SSH.
    """

    if await _use_remote(frame, redis, transport):
        for cmd in commands:
            await log(db, redis, frame.id, "stdout", f"> {cmd}")
            try:
                await _exec_via_remote(redis, frame, cmd, timeout)
            except Exception as e:
                await log(
                    db,
                    redis,
                    frame.id,
                    "stderr",
                    f"Remote exec error: {e}",
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

    if await _use_remote(frame, redis, transport):
        try:
            await log(db, redis, frame.id, "stdout", f"> uploading {remote_path} ({print_size(size)} via remote)")
            if size <= REMOTE_SHELL_UPLOAD_MAX_SIZE:
                await _shell_upload_via_remote(db, redis, frame, remote_path, data, timeout)
                return
            await _stream_file_via_remote(db, redis, frame, remote_path, data)
            return
        except Exception as e:  # noqa: BLE001
            if _remote_stream_upload_can_fallback(e):
                await log(
                    db,
                    redis,
                    frame.id,
                    "stdout",
                    f"> remote streaming upload unavailable for {remote_path}: {e}",
                )
                try:
                    await _shell_upload_via_remote(db, redis, frame, remote_path, data, timeout)
                    return
                except Exception as fallback_exc:
                    await log(
                        db,
                        redis,
                        frame.id,
                        "stderr",
                        f"> ERROR writing {remote_path} ({print_size(size)} via remote fallback) - {fallback_exc}",
                    )
                    raise
            await log(
                db,
                redis,
                frame.id,
                "stderr",
                f"> ERROR writing {remote_path} ({print_size(size)} via remote) - {e}",
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

    if await _use_remote(frame, redis, transport):
        from app.ws.remote_ws import file_delete_on_frame

        try:
            await log(db, redis, frame.id, "stdout", f"> rm -rf {remote_path} (remote)")
            await file_delete_on_frame(frame.id, remote_path, timeout, redis=redis)
            return
        except Exception as e:  # noqa: BLE001
            await log(db, redis, frame.id, "stderr", f"Remote delete error ({e})")
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

    if await _use_remote(frame, redis, transport):
        from app.ws.remote_ws import file_rename_on_frame

        try:
            await log(db, redis, frame.id, "stdout", f"> mv {src} {dst} (remote)")
            await file_rename_on_frame(frame.id, src, dst, timeout, redis=redis)
            return
        except Exception as e:  # noqa: BLE001
            await log(db, redis, frame.id, "stderr", f"Remote rename error ({e})")
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

    if await _use_remote(frame, redis, transport):
        from app.ws.remote_ws import file_mkdir_on_frame

        try:
            await log(
                db, redis, frame.id, "stdout", f"> mkdir -p {remote_path} (remote)"
            )
            await file_mkdir_on_frame(frame.id, remote_path, timeout, redis=redis)
            return
        except Exception as e:  # noqa: BLE001
            await log(db, redis, frame.id, "stderr", f"Remote mkdir error ({e})")
            raise

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"mkdir -p {shlex.quote(remote_path)}"
        await exec_command(db, redis, frame, ssh, cmd)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def _run_command_remote(
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
    Execute *cmd* via the WebSocket Remote, collecting stdout/stderr that are
    streamed through Redis (see STREAM_KEY in app.ws.remote_bridge).
    Returns (exit_status, stdout, stderr).
    """
    async with frame_command_slot(frame.id):
        cmd_id = str(uuid.uuid4())
        payload = {"type": "cmd", "name": "shell", "args": {"cmd": cmd}}

        if log_command:
            await log(db, redis, frame.id, "stdout", f"> {log_command if isinstance(log_command, str) else cmd}")

        from app.ws.remote_bridge import CMD_KEY, STREAM_KEY, RESP_KEY

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
                raise TimeoutError(f"remote timed-out after {timeout}s (cmd: {cmd})")

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

    • If the WebSocket Remote is enabled & connected it is used first
    • Otherwise the function falls back to SSH.

    Returns a tuple: **(exit_status, stdout, stderr)** – all text.
    """
    if await _use_remote(frame, redis, transport):
        return await _run_command_remote(db, redis, frame, command, timeout, log_output=log_output, log_command=log_command)
    return await _run_command_ssh(db, redis, frame, command, timeout, log_output=log_output, log_command=log_command)
