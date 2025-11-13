from arq import ArqRedis
import asyncio
from typing import Optional, Tuple
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame

async def exec_local_command(
    db: Session,
    redis: ArqRedis,
    frame: Frame,
    command: str,
    log_command: str | bool = True,
    log_output: bool = True
) -> Tuple[int, Optional[str], Optional[str]]:

    if log_command:
        await log(db, redis, int(frame.id), "stdout", f"$ {log_command if isinstance(log_command, str) else command}")

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def pump(stream, tag, buf):
        pending = ""

        async def _flush(segment: str):
            if not segment:
                return
            buf.append(segment)
            if log_output:
                await log(db, redis, int(frame.id), tag, segment)

        while True:
            raw = await stream.read(1024)
            if not raw:  # EOF
                break

            chunk = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            pending += chunk

            while True:
                newline_index = pending.find("\n")
                carriage_index = pending.find("\r")

                split_index = -1
                if newline_index != -1 and carriage_index != -1:
                    split_index = min(newline_index, carriage_index)
                elif newline_index != -1:
                    split_index = newline_index
                elif carriage_index != -1:
                    split_index = carriage_index

                if split_index == -1:
                    break

                segment = pending[:split_index].strip("\r")
                pending = pending[split_index + 1 :]
                await _flush(segment)

        pending = pending.strip("\r")
        if pending:
            await _flush(pending)

    out_buf: list[str] = []
    err_buf: list[str] = []
    await asyncio.gather(
        pump(proc.stdout, "stdout", out_buf),
        pump(proc.stderr, "stderr", err_buf),
    )

    exit_code = await proc.wait()
    if exit_code:
        await log(db, redis, int(frame.id), "exit_status",
                  f"The command exited with status {exit_code}")

    return (
        exit_code,
        "".join(out_buf) or None,
        "".join(err_buf) or None,
    )
