import subprocess
from arq import ArqRedis
import asyncio
from typing import Optional
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame


async def exec_local_command(db: Session, redis: ArqRedis, frame: Frame, command: str, generate_log=True) -> tuple[int, Optional[str], Optional[str]]:
    if generate_log:
        await log(db, redis, int(frame.id), "stdout", f"$ {command}")
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    errors = []
    outputs = []
    break_next = False

    while True:
        if process.stdout:
            while True:
                output = process.stdout.readline()
                if not output:
                    break
                await log(db, redis, int(frame.id), "stdout", output)
                outputs.append(output)

        if process.stderr:
            while True:
                error = process.stderr.readline()
                if not error:
                    break
                await log(db, redis, int(frame.id), "stderr", error)
                errors.append(error)

        if break_next:
            break
        if process.poll() is not None:
            break_next = True
        await asyncio.sleep(0.1)

    exit_status = process.returncode
    if exit_status != 0:
        await log(db, redis, int(frame.id), "exit_status", f"The command exited with status {exit_status}")

    return (exit_status,
            ''.join(outputs) if len(outputs) > 0 else None,
            ''.join(errors) if len(errors) > 0 else None)
