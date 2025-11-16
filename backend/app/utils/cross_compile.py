from __future__ import annotations

import os
import re
import shlex
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from textwrap import dedent
from typing import Callable, Iterable

import asyncssh

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.models.frame import Frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.utils.local_exec import exec_local_command
from app.utils.ssh_utils import get_ssh_connection, remove_ssh_connection


@dataclass(slots=True)
class TargetMetadata:
    arch: str
    distro: str
    version: str


@dataclass(slots=True)
class RemoteRequirement:
    name: str
    patterns: list[str]
    parent_depth: int
    predicate: Callable[[dict[str, object]], bool]


SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_.-]+")
CACHE_ENV = "FRAMEOS_CROSS_CACHE"
DEFAULT_CACHE = Path.home() / ".cache/frameos/cross"


REMOTE_REQUIREMENTS: tuple[RemoteRequirement, ...] = (
    RemoteRequirement(
        name="libevdev-libs",
        patterns=[
            "/usr/lib/**/libevdev.so",
            "/usr/lib/**/libevdev.so.*",
            "/lib/**/libevdev.so*",
        ],
        parent_depth=1,
        predicate=lambda drivers: bool(drivers.get("evdev")),
    ),
    RemoteRequirement(
        name="libevdev-includes",
        patterns=["/usr/include/**/libevdev.h"],
        parent_depth=2,
        predicate=lambda drivers: bool(drivers.get("evdev")),
    ),
    RemoteRequirement(
        name="lgpio-libs",
        patterns=[
            "/usr/lib/**/liblgpio.so",
            "/usr/lib/**/liblgpio.so.*",
            "/usr/local/lib/**/liblgpio.so*",
        ],
        parent_depth=1,
        predicate=lambda drivers: bool(drivers.get("waveshare"))
        or bool(drivers.get("gpioButton")),
    ),
    RemoteRequirement(
        name="lgpio-includes",
        patterns=[
            "/usr/include/**/lgpio.h",
            "/usr/local/include/**/lgpio.h",
        ],
        parent_depth=0,
        predicate=lambda drivers: bool(drivers.get("waveshare"))
        or bool(drivers.get("gpioButton")),
    ),
)


PLATFORM_MAP = {
    "aarch64": "linux/arm64",
    "arm64": "linux/arm64",
    "armv8": "linux/arm64",
    "armv7l": "linux/arm/v7",
    "armv7": "linux/arm/v7",
    "armv6l": "linux/arm/v6",
}


DISTRO_DEFAULTS = {
    "raspios": ("debian", "bookworm"),
    "debian": ("debian", "bookworm"),
    "ubuntu": ("ubuntu", "22.04"),
}


class CrossCompiler:
    def __init__(
        self,
        *,
        db: Session,
        redis: Redis,
        frame: Frame,
        deployer: FrameDeployer,
        target: TargetMetadata,
        temp_dir: str,
    ) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame
        self.deployer = deployer
        self.target = target
        self.temp_dir = Path(temp_dir)
        cache_root = Path(os.environ.get(CACHE_ENV, DEFAULT_CACHE))
        cache_root.mkdir(parents=True, exist_ok=True)
        key = "-".join(self._sanitize(part) for part in (target.distro, target.version, target.arch))
        self.toolchain_dir = cache_root / key
        self.toolchain_dir.mkdir(parents=True, exist_ok=True)
        self.sysroot_dir = self.toolchain_dir / "sysroot"
        self.sysroot_dir.mkdir(parents=True, exist_ok=True)
        self.home_dir = self.toolchain_dir / "home"
        self.home_dir.mkdir(parents=True, exist_ok=True)
        for rel in ("usr/include", "usr/local/include", "usr/lib", "usr/local/lib"):
            (self.sysroot_dir / rel).mkdir(parents=True, exist_ok=True)

    async def build(self, source_dir: str) -> str:
        await self._log(
            "stdout",
            f"- Cross compiling for {self.target.arch} on {self._docker_image()} via {self._platform()}",
        )
        await self._prepare_sysroot()
        binary_path = await self._run_docker_build(source_dir)
        if not os.path.exists(binary_path):
            raise RuntimeError("Cross compilation completed but frameos binary is missing")
        return binary_path

    async def _prepare_sysroot(self) -> None:
        drivers = drivers_for_frame(self.frame)
        required = [spec for spec in REMOTE_REQUIREMENTS if spec.predicate(drivers)]
        if not required:
            await self._log("stdout", "- No device-specific libraries required from frame")
            return

        remote_paths: list[str] = []
        for spec in required:
            match = await self._remote_first_match(spec.patterns)
            if not match:
                await self._log("stderr", f"- Unable to locate {spec.name} on frame; continuing")
                continue
            target_path = self._apply_parent(match, spec.parent_depth)
            if target_path:
                remote_paths.append(target_path)

        unique_paths = list(dict.fromkeys(remote_paths))
        needed = [path for path in unique_paths if not (self.sysroot_dir / path.lstrip("/")).exists()]
        if not needed:
            await self._log("stdout", "- Reusing cached sysroot libraries")
            return

        await self._log(
            "stdout",
            f"- Downloading {len(needed)} path(s) from frame for sysroot cache",
        )
        await self._download_remote_paths(needed)

    async def _run_docker_build(self, source_dir: str) -> str:
        source_dir = os.path.abspath(source_dir)
        script_path = self.temp_dir / "frameos-cross-build.sh"
        include_dirs = self._existing_container_dirs(["/sysroot/usr/include", "/sysroot/usr/local/include"])
        lib_dirs = self._existing_container_dirs(["/sysroot/usr/lib", "/sysroot/usr/local/lib"])
        pass_c = " ".join(f'--passC:"-I{path}"' for path in include_dirs)
        pass_l = " ".join(f'--passL:"-L{path}"' for path in lib_dirs)
        script_path.write_text(
            dedent(
                f"""
                #!/usr/bin/env bash
                set -euo pipefail

                export DEBIAN_FRONTEND=noninteractive
                apt-get update
                apt-get install -y --no-install-recommends \
                    build-essential \
                    ca-certificates \
                    curl \
                    git \
                    pkg-config \
                    python3 \
                    python3-pip \
                    unzip \
                    xz-utils \
                    zlib1g-dev \
                    libssl-dev \
                    libffi-dev \
                    libjpeg-dev \
                    libfreetype6-dev

                export HOME=/toolchain-home
                mkdir -p "$HOME/.nimble" "$HOME/.choosenim"
                export PATH="$HOME/.nimble/bin:$HOME/.choosenim/current/bin:$PATH"
                if [ ! -x "$HOME/.nimble/bin/nimble" ]; then
                    curl -L https://nim-lang.org/choosenim/init.sh -o /tmp/choosenim.sh
                    sh /tmp/choosenim.sh -y
                    rm -f /tmp/choosenim.sh
                fi

                cd /src
                nimble assets -y
                nimble setup
                nimble build -y {pass_c} {pass_l}
                """
            ).strip()
            + "\n"
        )
        os.chmod(script_path, 0o755)

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"--platform {self._platform()}",
                f"-v {shlex.quote(source_dir)}:/src",
                f"-v {shlex.quote(str(self.home_dir))}:/toolchain-home",
                f"-v {shlex.quote(str(self.sysroot_dir))}:/sysroot",
                f"-v {shlex.quote(str(script_path))}:/tmp/build.sh:ro",
                "-e HOME=/toolchain-home",
                "-w /src",
                shlex.quote(self._docker_image()),
                "bash /tmp/build.sh",
            ]
        )

        status, _, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            docker_cmd,
            log_command="docker run (cross compile)",
        )
        if status != 0:
            raise RuntimeError(f"Cross compilation failed: {err or 'see logs'}")
        return os.path.join(source_dir, "build", "frameos")

    async def _download_remote_paths(self, paths: Iterable[str]) -> None:
        remote_tar = f"/tmp/frameos_sysroot_{self.deployer.build_id}.tar.gz"
        tar_parts = " ".join(
            f"-C / {shlex.quote(path.lstrip('/'))}" for path in paths if path.startswith("/")
        )
        if not tar_parts:
            return
        await self.deployer.exec_command(
            f"tar -czf {remote_tar} {tar_parts}",
            # log_command="tar (collect sysroot)",
        )

        fd, local_tar = tempfile.mkstemp(suffix=".tar.gz")
        os.close(fd)
        try:
            await self._download_file(remote_tar, local_tar)
            await self.deployer.exec_command(
                f"rm -f {remote_tar}", log_output=False, raise_on_error=False
            )
            with tarfile.open(local_tar, "r:gz") as tf:
                tf.extractall(self.sysroot_dir)
        finally:
            os.unlink(local_tar)

    async def _download_file(self, remote_path: str, local_path: str) -> None:
        ssh = await get_ssh_connection(self.db, self.redis, self.frame)
        try:
            await asyncssh.scp((ssh, remote_path), local_path)
        finally:
            await remove_ssh_connection(self.db, self.redis, ssh, self.frame)

    async def _remote_first_match(self, patterns: list[str]) -> str | None:
        search_script = "python3 - <<'PY'\n" + "\n".join(
            [
                "import glob",
                "patterns = %r" % patterns,
                "for pat in patterns:",
                "    matches = glob.glob(pat, recursive=True)",
                "    if matches:",
                "        print(matches[0])",
                "        break",
                "PY",
            ]
        )
        output: list[str] = []
        await self.deployer.exec_command(
            search_script,
            output=output,
            # log_command="python3 (detect remote path)",
            log_output=False,
            raise_on_error=False,
        )
        if not output:
            return None
        found = output[0].strip()
        return found or None

    async def _log(self, level: str, message: str) -> None:
        await log(self.db, self.redis, int(self.frame.id), level, message)

    def _apply_parent(self, path: str, depth: int) -> str:
        target = Path(path)
        for _ in range(depth):
            target = target.parent
        return str(target)

    def _existing_container_dirs(self, candidates: list[str]) -> list[str]:
        existing: list[str] = []
        for candidate in candidates:
            rel = candidate.lstrip("/")
            if (self.sysroot_dir / rel).exists():
                existing.append(candidate)
        return existing

    def _platform(self) -> str:
        return PLATFORM_MAP.get(self.target.arch, "linux/amd64")

    def _docker_image(self) -> str:
        distro = self.target.distro or "unknown"
        version = self.target.version or "latest"
        base, default_version = DISTRO_DEFAULTS.get(distro, ("debian", "bookworm"))
        safe_version = version if re.match(r"^[A-Za-z0-9_.-]+$", version) else default_version
        return f"{base}:{safe_version}"

    @staticmethod
    def _sanitize(value: str) -> str:
        value = value or "unknown"
        return SAFE_SEGMENT.sub("_", value)


async def build_binary_with_cross_toolchain(
    *,
    db: Session,
    redis: Redis,
    frame: Frame,
    deployer: FrameDeployer,
    source_dir: str,
    temp_dir: str,
) -> str:
    arch = "armv7l" if frame.mode == "buildroot" else await deployer.get_cpu_architecture()
    distro = await deployer.get_distro()
    version = await deployer.get_distro_version()
    target = TargetMetadata(arch=arch, distro=distro, version=version)
    compiler = CrossCompiler(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        target=target,
        temp_dir=temp_dir,
    )
    return await compiler.build(source_dir)

