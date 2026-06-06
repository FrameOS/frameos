from __future__ import annotations

import asyncio
import os
import shlex
import shutil
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Awaitable, Callable, Literal

from arq import ArqRedis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.utils.build_environment import BuildEnvironmentProvider
from app.utils.build_host import BuildHostConfig, BuildHostSession
from app.utils.modal_sandbox import ModalSandboxConfig, ModalSandboxSession

LogFunc = Callable[[str, str], Awaitable[None]]
RunResult = tuple[int, str | None, str | None]


@dataclass(slots=True)
class DockerMount:
    source: Path
    target: str
    read_only: bool = False


class BuildExecutor:
    display_name: str = "local Docker"
    uses_local_filesystem: bool = True
    uses_container_images_directly: bool = False

    async def __aenter__(self) -> "BuildExecutor":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        return None

    async def run(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        raise NotImplementedError

    async def docker_run(
        self,
        *,
        image: str,
        args: list[str],
        mounts: list[DockerMount],
        env: dict[str, str] | None = None,
        workdir: str | None = None,
        platform: str | None = None,
        ulimits: list[str] | None = None,
        workspace: str = "docker-run",
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        command = self._docker_run_command(
            image=image,
            args=args,
            mounts=mounts,
            env=env,
            workdir=workdir,
            platform=platform,
            ulimits=ulimits,
        )
        return await self.run(
            command,
            log_command=log_command,
            log_output=log_output,
            stderr_log_tag=stderr_log_tag,
        )

    async def prepare_docker_build_context(self, dockerfile: Path, workspace: str) -> tuple[str, str]:
        return str(dockerfile.parent), str(dockerfile)

    async def mktemp_dir(self, prefix: str = "frameos-build-") -> str:
        raise RuntimeError(f"{self.display_name} does not allocate remote workspaces")

    async def ensure_dir(self, path: str) -> None:
        Path(path).mkdir(parents=True, exist_ok=True)

    async def remove_path(self, path: str) -> None:
        target = Path(path)
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=True)

    async def sync_dir_tarball(self, local_path: str, remote_path: str) -> None:
        local = Path(local_path)
        remote = Path(remote_path)
        if remote.exists():
            shutil.rmtree(remote)
        if local.is_dir():
            shutil.copytree(local, remote, symlinks=True)

    async def sync_file(self, local_path: str, remote_path: str) -> None:
        local = Path(local_path)
        if not local.is_file():
            return
        remote = Path(remote_path)
        remote.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local, remote)

    async def write_file(self, remote_path: str, content: str, mode: int = 0o644) -> None:
        path = Path(remote_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        os.chmod(path, mode)

    async def download_file(self, remote_path: str, local_path: str) -> None:
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(remote_path, local_path)

    async def download_dir_tarball(self, remote_path: str, local_path: str) -> None:
        remote = Path(remote_path)
        local = Path(local_path)
        if not remote.exists():
            return
        if local.exists():
            shutil.rmtree(local)
        shutil.copytree(remote, local, symlinks=True)

    @staticmethod
    def _docker_run_command(
        *,
        image: str,
        args: list[str],
        mounts: list[DockerMount],
        env: dict[str, str] | None,
        workdir: str | None,
        platform: str | None,
        ulimits: list[str] | None,
    ) -> str:
        parts = ["docker run --rm"]
        if platform:
            parts.append(f"--platform {shlex.quote(platform)}")
        for ulimit in ulimits or []:
            parts.append(f"--ulimit {shlex.quote(ulimit)}")
        for mount in mounts:
            source = shlex.quote(str(mount.source))
            suffix = ":ro" if mount.read_only else ""
            parts.append(f"-v {source}:{shlex.quote(mount.target)}{suffix}")
        for key, value in (env or {}).items():
            parts.append(f"-e {key}={shlex.quote(value)}")
        if workdir:
            parts.append(f"-w {shlex.quote(workdir)}")
        parts.append(shlex.quote(image))
        parts.extend(shlex.quote(arg) for arg in args)
        return " ".join(parts)


class LocalBuildExecutor(BuildExecutor):
    def __init__(
        self,
        *,
        db: Session | None,
        redis: ArqRedis | None,
        frame: Frame,
    ) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame

    async def run(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        if log_command:
            if self.db and self.redis:
                await log(
                    self.db,
                    self.redis,
                    int(self.frame.id),
                    "stdout",
                    f"$ {log_command if isinstance(log_command, str) else command}",
                )
            else:
                print(f"$ {log_command if isinstance(log_command, str) else command}")

        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def pump(stream, tag, buf):
            pending = ""

            async def _flush(segment: str, *, terminated: bool) -> None:
                if not segment:
                    return
                buf.append(f"{segment}\n" if terminated else segment)
                if not log_output:
                    return
                if self.db and self.redis:
                    await log(self.db, self.redis, int(self.frame.id), tag, segment)
                else:
                    print(segment)

            while True:
                raw = await stream.read(1024)
                if not raw:
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
        if exit_code and log_output:
            if self.db and self.redis:
                await log(
                    self.db,
                    self.redis,
                    int(self.frame.id),
                    "exit_status",
                    f"The command exited with status {exit_code}",
                )
            else:
                print(f"The command exited with status {exit_code}")
        return exit_code, "".join(out_buf) or None, "".join(err_buf) or None


class BuildHostExecutor(BuildExecutor):
    uses_local_filesystem = False

    def __init__(
        self,
        config: BuildHostConfig,
        *,
        logger: LogFunc | None = None,
        workspace_prefix: str = "frameos-build-",
    ) -> None:
        self.config = config
        self.display_name = f"build host {config.user}@{config.host}:{config.port}"
        self.logger = logger
        self.workspace_prefix = workspace_prefix
        self.session: BuildHostSession | None = None
        self.remote_root: PurePosixPath | None = None

    async def __aenter__(self) -> "BuildHostExecutor":
        self.session = await BuildHostSession(self.config, logger=self.logger).__aenter__()
        self.remote_root = PurePosixPath(await self.session.mktemp_dir(self.workspace_prefix))
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        if self.session:
            await self.session.__aexit__(exc_type, exc, tb)
        self.session = None
        self.remote_root = None

    def workspace_path(self, name: str) -> PurePosixPath:
        if self.remote_root is None:
            raise RuntimeError("Build host workspace is not available")
        return self.remote_root / name

    async def run(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        return await self.session.run(command, log_command=log_command, log_output=log_output)

    async def docker_run(
        self,
        *,
        image: str,
        args: list[str],
        mounts: list[DockerMount],
        env: dict[str, str] | None = None,
        workdir: str | None = None,
        platform: str | None = None,
        ulimits: list[str] | None = None,
        workspace: str = "docker-run",
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        remote_mounts: list[DockerMount] = []
        workspace_root = self.workspace_path(workspace)
        await self.session.remove_path(str(workspace_root))
        for index, mount in enumerate(mounts):
            remote_source = workspace_root / f"mount-{index}-{mount.source.name}"
            if mount.source.is_dir():
                await self.session.sync_dir_tarball(str(mount.source), str(remote_source))
            elif mount.source.is_file():
                await self.session.sync_file(str(mount.source), str(remote_source))
            remote_mounts.append(DockerMount(Path(str(remote_source)), mount.target, mount.read_only))

        command = self._docker_run_command(
            image=image,
            args=args,
            mounts=remote_mounts,
            env=env,
            workdir=workdir,
            platform=platform,
            ulimits=ulimits,
        )
        status, out, err = await self.run(
            command,
            log_command=log_command,
            log_output=log_output,
            stderr_log_tag=stderr_log_tag,
        )
        if status == 0:
            for mount, remote_mount in zip(mounts, remote_mounts):
                if mount.read_only:
                    continue
                if mount.source.is_dir():
                    await self.session.download_dir_tarball(str(remote_mount.source), str(mount.source))
                elif mount.source.is_file():
                    await self.session.download_file(str(remote_mount.source), str(mount.source))
        return status, out, err

    async def prepare_docker_build_context(self, dockerfile: Path, workspace: str) -> tuple[str, str]:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        remote_dir = self.workspace_path(workspace)
        dockerfile_path = remote_dir / dockerfile.name
        await self.session.ensure_dir(str(remote_dir))
        await self.session.write_file(str(dockerfile_path), dockerfile.read_text(encoding="utf-8"))
        return str(remote_dir), str(dockerfile_path)

    async def mktemp_dir(self, prefix: str = "frameos-build-") -> str:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        return await self.session.mktemp_dir(prefix)

    async def ensure_dir(self, path: str) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.ensure_dir(path)

    async def remove_path(self, path: str) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.remove_path(path)

    async def sync_dir_tarball(self, local_path: str, remote_path: str) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.sync_dir_tarball(local_path, remote_path)

    async def sync_file(self, local_path: str, remote_path: str) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.sync_file(local_path, remote_path)

    async def write_file(self, remote_path: str, content: str, mode: int = 0o644) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.write_file(remote_path, content, mode=mode)

    async def download_file(self, remote_path: str, local_path: str) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.download_file(remote_path, local_path)

    async def download_dir_tarball(self, remote_path: str, local_path: str) -> None:
        if self.session is None:
            raise RuntimeError("Build host executor is not connected")
        await self.session.download_dir_tarball(remote_path, local_path)


class ModalBuildExecutor(BuildExecutor):
    uses_local_filesystem = False
    uses_container_images_directly = True

    def __init__(
        self,
        config: ModalSandboxConfig,
        *,
        logger: LogFunc | None = None,
    ) -> None:
        self.config = config
        self.logger = logger
        self.display_name = f"Modal sandbox app {config.app_name} ({config.image})"

    async def _sandbox_log(self, level: str, message: str) -> None:
        if self.logger:
            await self.logger(level, message)

    def _sandbox_logger(self, stderr_log_tag: Literal["stderr", "stdout"]) -> LogFunc:
        async def sandbox_log(level: str, message: str) -> None:
            tag = "stdout" if level == "stderr" and stderr_log_tag == "stdout" else level
            if self.logger:
                await self.logger(tag, message)

        return sandbox_log

    async def run(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        async with ModalSandboxSession(self.config, logger=self._sandbox_logger(stderr_log_tag)) as sandbox:
            return await sandbox.run(command, log_command=log_command, log_output=log_output)

    async def docker_run(
        self,
        *,
        image: str,
        args: list[str],
        mounts: list[DockerMount],
        env: dict[str, str] | None = None,
        workdir: str | None = None,
        platform: str | None = None,
        ulimits: list[str] | None = None,
        workspace: str = "docker-run",
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> RunResult:
        config = replace(self.config, image=image, enable_docker=False)
        run_command = " ".join(shlex.quote(arg) for arg in args) if args else "true"
        if workdir:
            run_command = f"cd {shlex.quote(workdir)} && {run_command}"
        for ulimit in ulimits or []:
            if ulimit.startswith("nofile="):
                soft = ulimit.removeprefix("nofile=").split(":", 1)[0]
                run_command = f"ulimit -n {shlex.quote(soft)} && {run_command}"
        if env:
            exports = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())
            run_command = f"export {exports}; {run_command}"

        async with ModalSandboxSession(config, logger=self._sandbox_logger(stderr_log_tag)) as sandbox:
            if mounts:
                await self._sandbox_log(
                    "stdout",
                    f"Preparing Modal sandbox from {image} with {len(mounts)} mount"
                    + ("s" if len(mounts) != 1 else ""),
                )
            for mount in mounts:
                if mount.source.is_dir():
                    await sandbox.sync_dir_tarball(str(mount.source), mount.target)
                elif mount.source.is_file():
                    await sandbox.sync_file(str(mount.source), mount.target)

            status, out, err = await sandbox.run(
                run_command,
                log_command=log_command if log_command is not True else f"Modal run {image}",
                log_output=log_output,
            )
            if status == 0:
                for mount in mounts:
                    if mount.read_only:
                        continue
                    if mount.source.is_dir():
                        await sandbox.download_dir_tarball(mount.target, str(mount.source))
                    elif mount.source.is_file():
                        await sandbox.download_file(mount.target, str(mount.source))
        return status, out, err


def build_executor_display_name(config: BuildHostConfig | ModalSandboxConfig) -> str:
    if isinstance(config, ModalSandboxConfig):
        return f"Modal sandbox app {config.app_name} ({config.image})"
    return f"build host {config.user}@{config.host}:{config.port}"


def build_executor_kind_name(config: BuildHostConfig | ModalSandboxConfig) -> str:
    if isinstance(config, ModalSandboxConfig):
        return "Modal sandbox"
    return "build host"


def build_environment_requires_executor_config(provider: BuildEnvironmentProvider) -> bool:
    return provider in {"buildHost", "modal"}


def ensure_build_executor_configured(
    provider: BuildEnvironmentProvider,
    config: BuildHostConfig | ModalSandboxConfig | None,
) -> None:
    if build_environment_requires_executor_config(provider) and config is None:
        raise RuntimeError(f"Selected build environment '{provider}' is not configured")


def create_build_executor(
    config: BuildHostConfig | ModalSandboxConfig | None,
    *,
    db: Session | None,
    redis: ArqRedis | None,
    frame: Frame,
    logger: LogFunc | None = None,
    workspace_prefix: str = "frameos-build-",
) -> BuildExecutor:
    if isinstance(config, ModalSandboxConfig):
        return ModalBuildExecutor(config, logger=logger)
    if isinstance(config, BuildHostConfig):
        return BuildHostExecutor(config, logger=logger, workspace_prefix=workspace_prefix)
    return LocalBuildExecutor(db=db, redis=redis, frame=frame)
