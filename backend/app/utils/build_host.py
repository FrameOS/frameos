from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import tarfile
import tempfile
import inspect
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

import asyncssh
from sqlalchemy.orm import Session

from app.models.settings import get_settings_dict
from app.utils.build_environment import selected_build_environment_provider
from app.utils.modal_sandbox import ModalSandboxConfig, get_modal_sandbox_config
from app.utils.ssh_host_keys import (
    host_key_changed_message,
    host_key_fingerprint,
    host_key_type,
    openssh_host_key_line,
    trusted_known_hosts,
)

LogFunc = Callable[[str, str], Awaitable[None]]


@dataclass(slots=True)
class BuildHostConfig:
    host: str
    user: str
    port: int = 22
    ssh_key: str | None = None
    enabled: bool = False
    # The host key pinned on the first connect ("<type> <base64>"); None
    # until then (utils/ssh_host_keys.py).
    host_key: str | None = None

    @classmethod
    def from_settings(cls, raw: object) -> BuildHostConfig | None:
        if not isinstance(raw, dict):
            return None
        enabled = bool(raw.get("enabled"))
        host = (raw.get("host") or "").strip()
        user = (raw.get("user") or "").strip()
        ssh_key = raw.get("sshKey") or raw.get("ssh_key")
        host_key = (raw.get("hostKey") or raw.get("host_key") or "").strip() or None
        port = int(raw.get("port") or 22)
        if not enabled:
            return None
        if not (host and user and ssh_key):
            return None
        return cls(host=host, user=user, port=port, ssh_key=str(ssh_key), enabled=True, host_key=host_key)


def persist_build_host_key(db: Session | None, project_id: int | None, host_key_line: str) -> None:
    """Pin the build host key in the project's ``buildHost`` settings after a
    first connect (the settings form shows the fingerprint and can forget it)."""
    if db is None or project_id is None:
        return
    from app.models.settings import Settings

    row = db.query(Settings).filter_by(project_id=project_id, key="buildHost").first()
    if row is None or not isinstance(row.value, dict) or row.value.get("hostKey"):
        return
    row.value = {**row.value, "hostKey": host_key_line, "hostKeyFingerprint": host_key_fingerprint(host_key_line)}
    db.add(row)
    db.commit()


def get_build_host_config(db: Session | None, project_id: int | None = None) -> BuildHostConfig | None:
    if db is None:
        return None
    settings = get_settings_dict(db, project_id=project_id)
    if selected_build_environment_provider(settings) != "buildHost":
        return None
    return BuildHostConfig.from_settings(settings.get("buildHost"))


def get_build_executor_config(db: Session | None, project_id: int | None = None) -> BuildHostConfig | ModalSandboxConfig | None:
    if db is None or project_id is None:
        return None
    return get_modal_sandbox_config(db, project_id) or get_build_host_config(db, project_id)


class BuildHostSession:
    def __init__(
        self,
        config: BuildHostConfig,
        *,
        logger: LogFunc | None = None,
        on_host_key: Callable[[str], Awaitable[None] | None] | None = None,
    ) -> None:
        self.config = config
        self._logger = logger
        self._on_host_key = on_host_key
        # The key the host offered on a first (unpinned) connect.
        self.observed_host_key: str | None = None
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
        # Trust on first use (utils/ssh_host_keys.py): a pinned key refuses
        # any other; none pinned yet means this connect records the offer.
        try:
            known_hosts = trusted_known_hosts(self.config.host_key)
        except ValueError as exc:
            raise ValueError(f"{exc}. Forget the build host key in Settings and check the connection again.")
        try:
            self._conn = await asyncssh.connect(
                self.config.host,
                port=self.config.port,
                username=self.config.user,
                client_keys=client_keys or None,
                known_hosts=known_hosts,
                connect_timeout=30,
                login_timeout=30,
            )
        except asyncssh.HostKeyNotVerifiable:
            raise ValueError(
                host_key_changed_message(
                    f"{self.config.host}:{self.config.port}",
                    self.config.host_key,
                    "forget the build host key in Settings → Build environment and check the connection again",
                )
            )
        if not self.config.host_key:
            key = self._conn.get_server_host_key()
            if key is not None:
                self.observed_host_key = openssh_host_key_line(key)
                await self._log(
                    "stdinfo",
                    f"Recorded the build host's SSH key ({host_key_type(self.observed_host_key)} "
                    f"{host_key_fingerprint(self.observed_host_key)}); later connections refuse any other key",
                )
                if self._on_host_key is not None:
                    result = self._on_host_key(self.observed_host_key)
                    if inspect.isawaitable(result):
                        await result

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

            async def _flush(segment: str, *, terminated: bool) -> None:
                if not segment:
                    return
                buf.append(f"{segment}\n" if terminated else segment)
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
                    await _flush(segment.rstrip("\r"), terminated=True)
            pending = pending.rstrip("\r")
            if pending:
                await _flush(pending, terminated=False)

        out_buf: list[str] = []
        err_buf: list[str] = []
        await asyncio.gather(
            pump(proc.stdout, "stdout", out_buf), # type: ignore
            pump(proc.stderr, "stderr", err_buf), # type: ignore
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

    async def sync_dir_tarball(self, local_path: str, remote_path: str) -> None:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")

        fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
        os.close(fd)
        archive_path = Path(tmp_path)
        try:
            with tarfile.open(archive_path, "w:gz") as tar:
                tar.add(local_path, arcname=".")

            remote_archive = f"{remote_path}.tar.gz"
            await self.remove_path(remote_path)
            await self.ensure_dir(str(Path(remote_path).parent))
            await asyncssh.scp(str(archive_path), (self._conn, remote_archive))
            await self.run(
                " ".join(
                    [
                        "mkdir -p",
                        shlex.quote(remote_path),
                        "&& tar -xzf",
                        shlex.quote(remote_archive),
                        "-C",
                        shlex.quote(remote_path),
                        "&& rm -f",
                        shlex.quote(remote_archive),
                    ]
                ),
                log_command=False,
                log_output=False,
            )
        finally:
            archive_path.unlink(missing_ok=True)

    async def sync_file(self, local_path: str, remote_path: str) -> None:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")
        if not Path(local_path).is_file():
            return
        await self.ensure_dir(str(Path(remote_path).parent))
        await asyncssh.scp(local_path, (self._conn, remote_path), preserve=True)

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

    async def download_dir_tarball(self, remote_path: str, local_path: str) -> None:
        if not self._conn:
            raise RuntimeError("Build host session is not connected")

        fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
        os.close(fd)
        archive_path = Path(tmp_path)
        remote_archive = f"{remote_path}.download.tar.gz"
        local = Path(local_path)
        try:
            status, _out, _err = await self.run(
                " ".join(
                    [
                        "test -e",
                        shlex.quote(remote_path),
                        "&& tar -czf",
                        shlex.quote(remote_archive),
                        "-C",
                        shlex.quote(remote_path),
                        ".",
                    ]
                ),
                log_command=False,
                log_output=False,
            )
            if status != 0:
                return
            await self.download_file(remote_archive, str(archive_path))
            if local.exists() and local.is_dir():
                for child in local.iterdir():
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
            local.mkdir(parents=True, exist_ok=True)
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(local)
        finally:
            archive_path.unlink(missing_ok=True)
            await self.remove_path(remote_archive)
