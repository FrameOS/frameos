from __future__ import annotations

import asyncio
import inspect
import os
import re
import shlex
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from sqlalchemy.orm import Session

from app.models.settings import get_settings_dict
from app.utils.build_environment import selected_build_environment_provider

LogFunc = Callable[[str, str], Awaitable[None]]

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODAL_APP_NAME = os.environ.get("FRAMEOS_MODAL_SANDBOX_APP", "frameos-build")
DEFAULT_MODAL_IMAGE = os.environ.get("FRAMEOS_MODAL_SANDBOX_IMAGE", "frameos/frameos:latest")
DEFAULT_MODAL_TIMEOUT = int(os.environ.get("FRAMEOS_MODAL_SANDBOX_TIMEOUT", str(6 * 60 * 60)))
DEFAULT_MODAL_IDLE_TIMEOUT = int(os.environ.get("FRAMEOS_MODAL_SANDBOX_IDLE_TIMEOUT", str(15 * 60)))
FRAMEOS_SANDBOX_PATH = "/opt/nim/bin:/root/.nimble/bin:/app/backend/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PATH_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?:[A-Za-z0-9_@%+=:,.-]+/?)+")
SKIP_PATH_PREFIXES = (
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/lib64",
    "/opt",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/usr",
    "/var/lib",
    "/var/log",
    "/var/run",
)


@dataclass(slots=True)
class ModalSandboxConfig:
    token_id: str
    token_secret: str
    app_name: str = DEFAULT_MODAL_APP_NAME
    image: str = DEFAULT_MODAL_IMAGE
    enabled: bool = False
    timeout: int = DEFAULT_MODAL_TIMEOUT
    idle_timeout: int = DEFAULT_MODAL_IDLE_TIMEOUT
    cpu: float | None = None
    memory: int | None = None
    region: str | None = None
    cloud: str | None = None
    environment_name: str | None = None
    enable_docker: bool = True

    @classmethod
    def from_settings(cls, raw: object) -> ModalSandboxConfig | None:
        if not isinstance(raw, dict):
            return None
        enabled = bool(raw.get("enabled"))
        token_id = str(raw.get("tokenId") or raw.get("token_id") or "").strip()
        token_secret = str(raw.get("tokenSecret") or raw.get("token_secret") or "").strip()
        if not enabled or not token_id or not token_secret:
            return None

        def optional_int(key: str, default: int) -> int:
            try:
                return int(raw.get(key) or default)
            except (TypeError, ValueError):
                return default

        def optional_float(key: str) -> float | None:
            value = raw.get(key)
            if value in (None, ""):
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        return cls(
            token_id=token_id,
            token_secret=token_secret,
            app_name=str(raw.get("appName") or raw.get("app_name") or DEFAULT_MODAL_APP_NAME).strip()
            or DEFAULT_MODAL_APP_NAME,
            image=str(raw.get("image") or DEFAULT_MODAL_IMAGE).strip() or DEFAULT_MODAL_IMAGE,
            enabled=True,
            timeout=optional_int("timeout", DEFAULT_MODAL_TIMEOUT),
            idle_timeout=optional_int("idleTimeout", optional_int("idle_timeout", DEFAULT_MODAL_IDLE_TIMEOUT)),
            cpu=optional_float("cpu"),
            memory=optional_int("memory", 0) or None,
            region=str(raw.get("region") or "").strip() or None,
            cloud=str(raw.get("cloud") or "").strip() or None,
            environment_name=str(raw.get("environmentName") or raw.get("environment_name") or "").strip() or None,
            enable_docker=raw.get("enableDocker", raw.get("enable_docker", True)) is not False,
        )


@dataclass(slots=True)
class DockerRunMount:
    source: Path
    target: str
    read_only: bool = False


@dataclass(slots=True)
class DockerRunSpec:
    image: str
    args: list[str]
    mounts: list[DockerRunMount]
    env: dict[str, str]
    workdir: str | None = None
    platform: str | None = None


def get_modal_sandbox_config(db: Session | None, project_id: int | None = None) -> ModalSandboxConfig | None:
    if db is None or project_id is None:
        return None
    settings = get_settings_dict(db, project_id=project_id)
    if selected_build_environment_provider(settings) != "modal":
        return None
    return ModalSandboxConfig.from_settings(settings.get("modalSandbox"))


def parse_docker_run_command(command: str) -> DockerRunSpec | None:
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if len(tokens) < 3 or tokens[0:2] != ["docker", "run"]:
        return None

    mounts: list[DockerRunMount] = []
    env: dict[str, str] = {}
    workdir: str | None = None
    platform: str | None = None
    index = 2
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            break
        if token in {"--rm", "-i", "-t", "-it", "--init"}:
            index += 1
            continue
        if token in {"-v", "--volume"} and index + 1 < len(tokens):
            mount = _parse_docker_mount(tokens[index + 1])
            if mount:
                mounts.append(mount)
            index += 2
            continue
        if token.startswith("--volume="):
            mount = _parse_docker_mount(token.split("=", 1)[1])
            if mount:
                mounts.append(mount)
            index += 1
            continue
        if token.startswith("-v") and len(token) > 2:
            mount = _parse_docker_mount(token[2:])
            if mount:
                mounts.append(mount)
            index += 1
            continue
        if token in {"-e", "--env"} and index + 1 < len(tokens):
            _add_docker_env(env, tokens[index + 1])
            index += 2
            continue
        if token.startswith("--env="):
            _add_docker_env(env, token.split("=", 1)[1])
            index += 1
            continue
        if token in {"-w", "--workdir"} and index + 1 < len(tokens):
            workdir = tokens[index + 1]
            index += 2
            continue
        if token.startswith("--workdir="):
            workdir = token.split("=", 1)[1]
            index += 1
            continue
        if token == "--platform" and index + 1 < len(tokens):
            platform = tokens[index + 1]
            index += 2
            continue
        if token.startswith("--platform="):
            platform = token.split("=", 1)[1]
            index += 1
            continue
        if token in {"--ulimit", "--name", "--user", "-u", "--entrypoint"} and index + 1 < len(tokens):
            index += 2
            continue
        if token.startswith("--ulimit=") or token.startswith("--name=") or token.startswith("--user=") or token.startswith("--entrypoint="):
            index += 1
            continue
        if token.startswith("-"):
            return None
        image = token
        return DockerRunSpec(image=image, args=tokens[index + 1 :], mounts=mounts, env=env, workdir=workdir, platform=platform)
    return None


def _parse_docker_mount(value: str) -> DockerRunMount | None:
    parts = value.split(":")
    if len(parts) < 2 or not parts[0].startswith("/") or not parts[1].startswith("/"):
        return None
    options = set(parts[2].split(",")) if len(parts) > 2 else set()
    return DockerRunMount(source=Path(parts[0]), target=parts[1], read_only="ro" in options)


def _add_docker_env(env: dict[str, str], value: str) -> None:
    if "=" in value:
        key, env_value = value.split("=", 1)
        if key:
            env[key] = env_value
    elif value in os.environ:
        env[value] = os.environ[value]


async def _maybe_await(value):
    if hasattr(value, "__await__"):
        return await value
    return value


async def _call_modal(method, *args, **kwargs):
    aio = getattr(method, "aio", None)
    if aio is not None:
        return await aio(*args, **kwargs)
    result = method(*args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def _is_timeout_error(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    name = exc.__class__.__name__.lower()
    message = str(exc).lower()
    return "timeout" in name or "timed out" in message or "timeout" in message


class ModalSandboxSession:
    def __init__(self, config: ModalSandboxConfig, *, logger: LogFunc | None = None) -> None:
        self.config = config
        self._logger = logger
        self._modal = None
        self._client = None
        self._sandbox = None
        self._cleanup_paths: list[str] = []

    async def __aenter__(self) -> "ModalSandboxSession":
        await self._connect()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        if self._sandbox:
            try:
                await _call_modal(self._sandbox.terminate, wait=True)
            except Exception:
                pass
            try:
                await _call_modal(self._sandbox.detach)
            except Exception:
                pass

    async def _connect(self) -> None:
        try:
            import modal
        except ImportError as exc:  # pragma: no cover - depends on deployment deps
            raise RuntimeError("Modal sandbox execution requires the 'modal' Python package") from exc

        self._modal = modal
        self._client = modal.Client.from_credentials(self.config.token_id, self.config.token_secret)
        app = await _call_modal(
            modal.App.lookup,
            self.config.app_name,
            client=self._client,
            environment_name=self.config.environment_name,
            create_if_missing=True,
        )
        image = (
            modal.Image.from_registry(
                self.config.image,
                setup_dockerfile_commands=[f"ENV PATH={FRAMEOS_SANDBOX_PATH}"],
            )
            if self.config.image
            else None
        )
        kwargs = {
            "app": app,
            "client": self._client,
            "image": image,
            "env": {"PATH": FRAMEOS_SANDBOX_PATH, "HOME": "/root"},
            "timeout": self.config.timeout,
            "idle_timeout": self.config.idle_timeout,
            "cpu": self.config.cpu,
            "memory": self.config.memory,
            "region": self.config.region,
            "cloud": self.config.cloud,
            "environment_name": self.config.environment_name,
            "experimental_options": {"enable_docker": True} if self.config.enable_docker else None,
        }
        kwargs = {key: value for key, value in kwargs.items() if value is not None}
        try:
            self._sandbox = await _call_modal(modal.Sandbox.create, "sleep", str(self.config.timeout), **kwargs)
        except Exception as exc:
            if _is_timeout_error(exc):
                await self._log_timeout_notice("creating Modal sandbox")
            raise
        identity = await self._sandbox_identity()
        await self._log("stdout", self._connection_summary(identity))

    async def _sandbox_identity(self) -> dict[str, str]:
        if not self._sandbox:
            return {}
        command = (
            "printf 'host=%s\\n' \"$(hostname 2>/dev/null || printf unknown)\"; "
            "printf 'cpu_count=%s\\n' \"$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf unknown)\"; "
            "awk '/MemTotal/ {printf \"memory_mib=%d\\n\", $2 / 1024}' /proc/meminfo 2>/dev/null || true"
        )
        try:
            proc = await _call_modal(self._sandbox.exec, "bash", "-lc", command, timeout=min(self.config.timeout, 30))
            out_buf: list[str] = []
            async for chunk in proc.stdout:
                out_buf.append(chunk.decode("utf-8", errors="replace") if isinstance(chunk, (bytes, bytearray)) else str(chunk))
            async for _chunk in proc.stderr:
                pass
            await _call_modal(proc.wait)
        except Exception:
            return {}
        identity: dict[str, str] = {}
        for raw_line in "".join(out_buf).splitlines():
            key, separator, value = raw_line.partition("=")
            if separator and key and value:
                identity[key.strip()] = value.strip()
        return identity

    def _connection_summary(self, identity: dict[str, str]) -> str:
        sandbox_id = ""
        if self._sandbox:
            for attr in ("object_id", "sandbox_id", "id", "_object_id"):
                value = getattr(self._sandbox, attr, None)
                if value:
                    sandbox_id = str(value)
                    break
        cpu = f"{self.config.cpu:g} requested" if self.config.cpu is not None else identity.get("cpu_count", "auto")
        memory = (
            f"{self.config.memory} MiB requested"
            if self.config.memory is not None
            else f"{identity['memory_mib']} MiB reported"
            if identity.get("memory_mib")
            else "auto"
        )
        parts = [
            "Connected to Modal sandbox",
            f"app={self.config.app_name}",
            f"environment={self.config.environment_name or 'default'}",
            f"sandbox={sandbox_id or 'unknown'}",
            f"host={identity.get('host') or 'unknown'}",
            f"image={self.config.image}",
            f"cpu={cpu}",
            f"memory={memory}",
            f"region={self.config.region or 'auto'}",
            f"cloud={self.config.cloud or 'auto'}",
            f"timeout={self.config.timeout}s",
            f"idle_timeout={self.config.idle_timeout}s",
            f"nested_docker={'enabled' if self.config.enable_docker else 'disabled'}",
        ]
        return f"{parts[0]}: " + ", ".join(parts[1:])

    async def _log(self, level: str, message: str) -> None:
        if self._logger:
            await self._logger(level, message)

    async def _log_timeout_notice(self, action: str) -> None:
        await self._log(
            "stderr",
            "Modal sandbox timed out while "
            f"{action}. Configured timeout={self.config.timeout}s, "
            f"idle_timeout={self.config.idle_timeout}s, app={self.config.app_name}, "
            f"image={self.config.image}. Increase the Modal sandbox timeout/idle timeout "
            "in global settings if this build legitimately needs longer.",
        )

    async def run(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
    ) -> tuple[int, str | None, str | None]:
        if not self._sandbox:
            raise RuntimeError("Modal sandbox session is not connected")

        if log_command:
            await self._log("stdout", f"$ {log_command if isinstance(log_command, str) else command}")

        wrapped_command = f"export PATH={shlex.quote(FRAMEOS_SANDBOX_PATH)} HOME=/root; {command}"
        try:
            proc = await _call_modal(self._sandbox.exec, "bash", "-lc", wrapped_command, timeout=self.config.timeout)
            out_buf: list[str] = []
            err_buf: list[str] = []

            async def pump(stream, level: str, buf: list[str]) -> None:
                pending = ""
                async for chunk in stream:
                    text = chunk.decode("utf-8", errors="replace") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
                    pending += text
                    while True:
                        split_index = pending.find("\n")
                        if split_index == -1:
                            break
                        segment = pending[:split_index].rstrip("\r")
                        pending = pending[split_index + 1 :]
                        buf.append(f"{segment}\n")
                        if log_output and segment:
                            await self._log(level, segment)
                pending = pending.rstrip("\r")
                if pending:
                    buf.append(pending)
                    if log_output:
                        await self._log(level, pending)

            await asyncio.gather(pump(proc.stdout, "stdout", out_buf), pump(proc.stderr, "stderr", err_buf))
            return_code = await _call_modal(proc.wait)
        except Exception as exc:
            if _is_timeout_error(exc):
                await self._log_timeout_notice("running Modal command")
            raise
        if return_code and log_output:
            await self._log("exit_status", f"The command exited with status {return_code}")
        return int(return_code or 0), "".join(out_buf) or None, "".join(err_buf) or None

    async def mktemp_dir(self, prefix: str = "frameos-build-") -> str:
        status, out, _err = await self.run(f"mktemp -d -p /tmp {prefix}XXXXXX", log_command=False, log_output=False)
        if status != 0 or not out:
            raise RuntimeError("Failed to allocate temporary directory in Modal sandbox")
        path = out.strip().splitlines()[-1]
        self._cleanup_paths.append(path)
        return path

    async def ensure_dir(self, remote_path: str) -> None:
        await self.run(f"mkdir -p {shlex.quote(remote_path)}", log_command=False, log_output=False)

    async def remove_path(self, remote_path: str) -> None:
        await self.run(f"rm -rf {shlex.quote(remote_path)}", log_command=False, log_output=False)

    async def sync_dir_tarball(self, local_path: str, remote_path: str) -> None:
        local = Path(local_path)
        if not local.exists():
            return
        await self.ensure_dir(str(Path(remote_path).parent))
        with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
            archive_path = Path(tmp.name)
        try:
            with tarfile.open(archive_path, "w:gz") as tar:
                tar.add(local, arcname=".")
            remote_archive = f"{remote_path}.tar.gz"
            await self.remove_path(remote_path)
            await self._copy_from_local(str(archive_path), remote_archive)
            status, _out, err = await self.run(
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
            if status != 0:
                raise RuntimeError(f"Failed to extract Modal sandbox archive: {err or 'see logs'}")
        finally:
            archive_path.unlink(missing_ok=True)

    async def sync_file(self, local_path: str, remote_path: str) -> None:
        if not Path(local_path).is_file():
            return
        await self.ensure_dir(str(Path(remote_path).parent))
        await self._copy_from_local(local_path, remote_path)

    async def write_file(self, remote_path: str, content: str, mode: int = 0o644) -> None:
        await self.ensure_dir(str(Path(remote_path).parent))
        await _call_modal(self._sandbox.filesystem.write_text, content, remote_path)
        await self.run(f"chmod {oct(mode)[2:]} {shlex.quote(remote_path)}", log_command=False, log_output=False)

    async def download_file(self, remote_path: str, local_path: str) -> None:
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        await _call_modal(self._sandbox.filesystem.copy_to_local, remote_path, local_path)

    async def download_dir_tarball(self, remote_path: str, local_path: str) -> None:
        local = Path(local_path)
        with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
            archive_path = Path(tmp.name)
        remote_archive = f"/tmp/frameos-download-{os.getpid()}-{abs(hash(remote_path))}.tar.gz"
        try:
            status, _out, err = await self.run(
                f"test -e {shlex.quote(remote_path)} && tar -czf {shlex.quote(remote_archive)} -C {shlex.quote(remote_path)} .",
                log_command=False,
                log_output=False,
            )
            if status != 0:
                return
            await self.download_file(remote_archive, str(archive_path))
            if local.exists() and local.is_dir():
                for child in local.iterdir():
                    if child.is_dir():
                        import shutil

                        shutil.rmtree(child)
                    else:
                        child.unlink()
            local.mkdir(parents=True, exist_ok=True)
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(local)
        finally:
            archive_path.unlink(missing_ok=True)
            await self.remove_path(remote_archive)

    async def _copy_from_local(self, local_path: str, remote_path: str) -> None:
        await _call_modal(self._sandbox.filesystem.copy_from_local, local_path, remote_path)


def _path_is_allowed(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    resolved_str = str(resolved)
    if any(resolved_str == prefix or resolved_str.startswith(f"{prefix}/") for prefix in SKIP_PATH_PREFIXES):
        return False
    if resolved_str == "/tmp" or resolved_str == "/private/tmp":
        return False
    if resolved_str.startswith(str(REPO_ROOT)):
        return True
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir and resolved_str.startswith(str(Path(tmpdir).resolve())):
        return True
    return resolved_str.startswith("/tmp/") or resolved_str.startswith("/private/tmp/")


def _docker_mount_sources(command: str) -> set[Path]:
    paths: set[Path] = set()
    try:
        tokens = shlex.split(command)
    except ValueError:
        return paths
    for index, token in enumerate(tokens):
        value = ""
        if token in {"-v", "--volume"} and index + 1 < len(tokens):
            value = tokens[index + 1]
        elif token.startswith("-v") and len(token) > 2:
            value = token[2:]
        elif token.startswith("--volume="):
            value = token.split("=", 1)[1]
        if not value:
            continue
        source = value.split(":", 1)[0]
        if source.startswith("/"):
            paths.add(Path(source))
    return paths


def _absolute_paths(command: str) -> set[Path]:
    paths: set[Path] = set()
    for match in PATH_TOKEN_RE.finditer(command):
        raw = match.group(0).rstrip(".,;:)")
        if raw:
            paths.add(Path(raw))
    return paths


def sandbox_sync_paths_for_command(command: str) -> list[Path]:
    candidates = _docker_mount_sources(command) | _absolute_paths(command)
    existing: list[tuple[Path, Path]] = []
    for candidate in candidates:
        path = candidate
        while not path.exists() and path != path.parent:
            path = path.parent
        if not path.exists() or not _path_is_allowed(path):
            continue
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if any(
            resolved == existing_resolved or str(resolved).startswith(f"{existing_resolved}/")
            for _existing_path, existing_resolved in existing
        ):
            continue
        existing = [
            (existing_path, existing_resolved)
            for existing_path, existing_resolved in existing
            if not str(existing_resolved).startswith(f"{resolved}/")
        ]
        existing.append((path, resolved))
    return [path for path, _resolved in sorted(existing, key=lambda item: len(str(item[0])))]
