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
    generate_log: bool = True
) -> Tuple[int, Optional[str], Optional[str]]:

    if generate_log:
        await log(db, redis, int(frame.id), "stdout", f"$ {command}")

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def pump(stream, tag, buf):
        while True:
            raw = await stream.readline()
            if not raw:                       # EOF
                break
            line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            buf.append(line)
            await log(db, redis, int(frame.id), tag, line)

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
