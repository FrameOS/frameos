from __future__ import annotations

import asyncio
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

import asyncssh
from sqlalchemy.orm import Session

from app.models.settings import get_settings_dict

LogFunc = Callable[[str, str], Awaitable[None]]


@dataclass(slots=True)
class BuildHostConfig:
    host: str
    user: str
    port: int = 22
    ssh_key: str | None = None
    enabled: bool = False

    @classmethod
    def from_settings(cls, raw: object) -> BuildHostConfig | None:
        if not isinstance(raw, dict):
            return None
        enabled = bool(raw.get("enabled"))
        host = (raw.get("host") or "").strip()
        user = (raw.get("user") or "").strip()
        ssh_key = raw.get("sshKey") or raw.get("ssh_key")
        port = int(raw.get("port") or 22)
        if not enabled:
            return None
        if not (host and user and ssh_key):
            return None
        return cls(host=host, user=user, port=port, ssh_key=str(ssh_key), enabled=True)


def get_build_host_config(db: Session | None) -> BuildHostConfig | None:
    if db is None:
        return None
    settings = get_settings_dict(db)
    return BuildHostConfig.from_settings(settings.get("buildHost"))


class BuildHostSession:
    def __init__(
        self,
        config: BuildHostConfig,
        *,
        logger: LogFunc | None = None,
    ) -> None:
        self.config = config
        self._logger = logger
        self._conn: asyncssh.SSHClientConnection | None = None
        self._cleanup_paths: list[str] = []

    async def __aenter__(self) -> "BuildHostSession":
        await self._connect()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        for path in self._cleanup_paths:
            try:
                await self.remove_path(path)
            except Exception:
                pass
        if self._conn:
            self._conn.close()
            try:
                await self._conn.wait_closed()
            except Exception:
                pass

    async def _connect(self) -> None:
        client_keys = []
        if self.config.ssh_key:
            try:
                client_keys.append(asyncssh.import_private_key(self.config.ssh_key))
            except (asyncssh.KeyImportError, TypeError) as exc:
                raise ValueError("Invalid build host SSH key") from exc
        self._conn = await asyncssh.connect(
            self.config.host,
            port=self.config.port,
            username=self.config.user,
            client_keys=client_keys or None,
            known_hosts=None,
        )
        await self._log(
            "stdout",
            f"🟢 Connected to build host {self.config.user}@{self.config.host}:{self.config.port}",
        )

    async def _log(self, level: str, message: str) -> None:
        if self._logger:
            await self._logger(level, message)

    async def run(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
    ) -> tuple[int, str | None, str | None]:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")

        if log_command:
            await self._log("stdout", f"$ {log_command if isinstance(log_command, str) else command}")

        proc = await self._conn.create_process(command)

        async def pump(stream: asyncio.StreamReader, level: str, buf: list[str]) -> None:
            pending = ""

            async def _flush(segment: str) -> None:
                if not segment:
                    return
                buf.append(segment)
                if log_output:
                    await self._log(level, segment)

            while True:
                chunk = await stream.read(1024)
                if not chunk:
                    break
                pending += chunk.decode() if isinstance(chunk, (bytes, bytearray)) else str(chunk)
                while True:
                    split_index = pending.find("\n")
                    if split_index == -1:
                        break
                    segment = pending[:split_index]
                    pending = pending[split_index + 1 :]
                    await _flush(segment.rstrip("\r"))
            pending = pending.rstrip("\r")
            if pending:
                await _flush(pending)

        out_buf: list[str] = []
        err_buf: list[str] = []
        await asyncio.gather(
            pump(proc.stdout, "stdout", out_buf),
            pump(proc.stderr, "stderr", err_buf),
        )

        status = await proc.wait()
        if status and log_output and status.returncode != 0:
            await self._log("exit_status", f"The command exited with status {status.returncode}")
        return status.returncode or 0, "".join(out_buf) or None, "".join(err_buf) or None

    async def mktemp_dir(self, prefix: str = "frameos-build-") -> str:
        status, out, _err = await self.run(
            f"mktemp -d -p /tmp {prefix}XXXXXX", log_output=False, log_command=False
        )
        if status != 0 or not out:
            raise RuntimeError("Failed to allocate temporary directory on build host")
        path = out.strip().splitlines()[-1]
        self._cleanup_paths.append(path)
        return path

    async def ensure_dir(self, remote_path: str) -> None:
        await self.run(f"mkdir -p {shlex.quote(remote_path)}", log_command=False, log_output=False)

    async def remove_path(self, remote_path: str) -> None:
        await self.run(f"rm -rf {shlex.quote(remote_path)}", log_command=False, log_output=False)

    async def sync_dir(self, local_path: str, remote_path: str) -> None:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")
        await self.remove_path(remote_path)
        await self.ensure_dir(str(Path(remote_path).parent))
        await asyncssh.scp(local_path, (self._conn, remote_path), recurse=True, preserve=True)

    async def write_file(self, remote_path: str, content: str, mode: int = 0o644) -> None:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")
        remote_path = str(remote_path)
        await self.ensure_dir(str(Path(remote_path).parent))
        sftp = await self._conn.start_sftp_client()
        try:
            async with sftp.open(remote_path, "w") as fh:
                await fh.write(content)
            await sftp.chmod(remote_path, mode)
        finally:
            sftp.exit()

    async def download_file(self, remote_path: str, local_path: str) -> None:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        await asyncssh.scp((self._conn, remote_path), local_path)
