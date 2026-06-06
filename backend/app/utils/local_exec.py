from arq import ArqRedis
import asyncio
from dataclasses import replace
import shlex
from typing import Literal, Optional, Tuple
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame
from app.utils.modal_sandbox import (
    ModalSandboxConfig,
    ModalSandboxSession,
    get_modal_sandbox_config,
    parse_docker_run_command,
    sandbox_sync_paths_for_command,
)

async def exec_local_command(
    db: Session | None,
    redis: ArqRedis | None,
    frame: Frame,
    command: str,
    log_command: str | bool = True,
    log_output: bool = True,
    stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
) -> Tuple[int, Optional[str], Optional[str]]:
    project_id = getattr(frame, "project_id", None)
    modal_config = get_modal_sandbox_config(db, project_id) if project_id is not None else None
    if modal_config:
        return await exec_modal_sandbox_command(
            db,
            redis,
            frame,
            command,
            modal_config=modal_config,
            log_command=log_command,
            log_output=log_output,
            stderr_log_tag=stderr_log_tag,
        )

    if log_command:
        if db and redis:
            await log(db, redis, int(frame.id), "stdout", f"$ {log_command if isinstance(log_command, str) else command}")
        else:
            print(f"$ {log_command if isinstance(log_command, str) else command}")

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def pump(stream, tag, buf):
        pending = ""

        async def _flush(segment: str, *, terminated: bool):
            if not segment:
                return
            buf.append(f"{segment}\n" if terminated else segment)
            if log_output:
                if db and redis:
                    await log(db, redis, int(frame.id), tag, segment)
                else:
                    print(segment)

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
                await _flush(segment, terminated=True)

        pending = pending.strip("\r")
        if pending:
            await _flush(pending, terminated=False)

    out_buf: list[str] = []
    err_buf: list[str] = []
    await asyncio.gather(
        pump(proc.stdout, "stdout", out_buf),
        pump(proc.stderr, stderr_log_tag, err_buf),
    )

    exit_code = await proc.wait()
    if exit_code:
        if db and redis:
            await log(db, redis, int(frame.id), "exit_status", f"The command exited with status {exit_code}")
        else:
            print( f"The command exited with status {exit_code}")

    return (
        exit_code,
        "".join(out_buf) or None,
        "".join(err_buf) or None,
    )


async def exec_modal_sandbox_command(
    db: Session | None,
    redis: ArqRedis | None,
    frame: Frame,
    command: str,
    *,
    modal_config,
    log_command: str | bool = True,
    log_output: bool = True,
    stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
) -> Tuple[int, Optional[str], Optional[str]]:
    async def sandbox_log(level: str, message: str) -> None:
        tag = "stdout" if level == "stderr" and stderr_log_tag == "stdout" else level
        if db and redis:
            await log(db, redis, int(frame.id), tag, message)
        else:
            print(message)

    docker_run = parse_docker_run_command(command)
    if docker_run:
        return await exec_modal_docker_run_command(
            db,
            redis,
            frame,
            command,
            modal_config=modal_config,
            log_command=log_command,
            log_output=log_output,
            stderr_log_tag=stderr_log_tag,
        )

    sync_paths = sandbox_sync_paths_for_command(command)
    async with ModalSandboxSession(modal_config, logger=sandbox_log) as sandbox:
        if sync_paths:
            await sandbox_log(
                "stdout",
                f"Preparing Modal sandbox with {len(sync_paths)} local path"
                + ("s" if len(sync_paths) != 1 else ""),
            )
        for path in sync_paths:
            if path.is_dir():
                await sandbox.sync_dir_tarball(str(path), str(path))
            elif path.is_file():
                await sandbox.sync_file(str(path), str(path))

        status, out, err = await sandbox.run(
            command,
            log_command=log_command,
            log_output=log_output,
        )

        for path in sync_paths:
            if path.is_dir():
                await sandbox.download_dir_tarball(str(path), str(path))
            elif path.is_file():
                await sandbox.download_file(str(path), str(path))

    return status, out, err


async def exec_modal_docker_run_command(
    db: Session | None,
    redis: ArqRedis | None,
    frame: Frame,
    command: str,
    *,
    modal_config: ModalSandboxConfig,
    log_command: str | bool = True,
    log_output: bool = True,
    stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
) -> Tuple[int, Optional[str], Optional[str]]:
    docker_run = parse_docker_run_command(command)
    if docker_run is None:
        raise RuntimeError("Expected a docker run command")

    async def sandbox_log(level: str, message: str) -> None:
        tag = "stdout" if level == "stderr" and stderr_log_tag == "stdout" else level
        if db and redis:
            await log(db, redis, int(frame.id), tag, message)
        else:
            print(message)

    config = replace(modal_config, image=docker_run.image, enable_docker=False)
    args = docker_run.args or []
    run_command = " ".join(shlex.quote(arg) for arg in args) if args else "true"
    if docker_run.workdir:
        run_command = f"cd {shlex.quote(docker_run.workdir)} && {run_command}"
    if docker_run.env:
        exports = " ".join(f"{key}={shlex.quote(value)}" for key, value in docker_run.env.items())
        run_command = f"export {exports}; {run_command}"

    async with ModalSandboxSession(config, logger=sandbox_log) as sandbox:
        if docker_run.mounts:
            await sandbox_log(
                "stdout",
                f"Preparing Modal sandbox from {docker_run.image} with {len(docker_run.mounts)} mount"
                + ("s" if len(docker_run.mounts) != 1 else ""),
            )
        for mount in docker_run.mounts:
            if mount.source.is_dir():
                await sandbox.sync_dir_tarball(str(mount.source), mount.target)
            elif mount.source.is_file():
                await sandbox.sync_file(str(mount.source), mount.target)

        status, out, err = await sandbox.run(
            run_command,
            log_command=log_command if log_command is not True else f"Modal run {docker_run.image}",
            log_output=log_output,
        )

        for mount in docker_run.mounts:
            if mount.read_only:
                continue
            if mount.source.is_dir():
                await sandbox.download_dir_tarball(mount.target, str(mount.source))
            elif mount.source.is_file():
                await sandbox.download_file(mount.target, str(mount.source))

    return status, out, err
