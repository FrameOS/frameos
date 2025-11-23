from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.assets import copy_custom_fonts_to_local_source_folder
from app.models.frame import Frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.prebuilt_deps import PrebuiltEntry, fetch_prebuilt_manifest, resolve_prebuilt_target
from app.utils.build_host import get_build_host_config
from app.utils.cross_compile import (
    TargetMetadata,
    build_binary_with_cross_toolchain,
    can_cross_compile_target,
)


LogFn = Callable[[str, str], Awaitable[None]]
DEFAULT_BUILD_LOG = "frameos-build.log"
icon = "🔶"


@dataclass(slots=True)
class FrameBinaryBuildResult:
    build_id: str
    target: TargetMetadata
    source_dir: str
    build_dir: str
    archive_path: str
    binary_path: str | None
    cross_compiled: bool
    prebuilt_entry: PrebuiltEntry | None
    prebuilt_target: str | None
    log_path: str | None


def create_build_folder(temp_dir: str, build_id: str) -> str:
    build_dir = os.path.join(temp_dir, f"build_{build_id}")
    os.makedirs(build_dir, exist_ok=True)
    return build_dir


async def resolve_prebuilt_entry(
    *,
    distro: str,
    distro_version: str,
    arch: str,
    logger: LogFn | None,
) -> tuple[PrebuiltEntry | None, str | None]:
    prebuilt_entry = None
    prebuilt_target = resolve_prebuilt_target(distro, distro_version, arch)
    if prebuilt_target:
        try:
            manifest = await fetch_prebuilt_manifest()
        except Exception as exc:  # pragma: no cover - network/manifest failures vary
            if logger:
                await logger(
                    "stderr",
                    f"{icon} Could not load prebuilt manifest for target {prebuilt_target}: {exc}",
                )
        else:
            prebuilt_entry = manifest.get(prebuilt_target)
            if logger:
                if prebuilt_entry:
                    await logger("stdout", f"{icon} Using prebuilt target '{prebuilt_target}' for deps when possible")
                else:
                    await logger("stdout", f"{icon} No prebuilt components published for '{prebuilt_target}'")
    elif logger and distro in ("raspios", "debian"):
        await logger(
            "stdout",
            f"{icon} No matching prebuilt target for this distro/version/arch combination",
        )
    return prebuilt_entry, prebuilt_target


class FrameBinaryBuilder:
    def __init__(
        self,
        *,
        db: Session | None,
        redis: Redis | None,
        frame: Frame,
        deployer: FrameDeployer,
        temp_dir: str,
        source_root: str | None = None,
        logger: LogFn | None = None,
    ) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame
        self.deployer = deployer
        self.temp_dir = temp_dir
        self.source_root = source_root
        self.log_path = Path(temp_dir) / DEFAULT_BUILD_LOG
        self.logger = logger

    async def build(
        self,
        *,
        allow_cross_compile: bool = True,
        force_cross_compile: bool = False,
        target_override: TargetMetadata | None = None,
    ) -> FrameBinaryBuildResult:
        target = target_override or await self._detect_target()
        prebuilt_entry, prebuilt_target = await resolve_prebuilt_entry(
            distro=target.distro,
            distro_version=target.version,
            arch=target.arch,
            logger=self._log,
        )
        build_host = get_build_host_config(self.db)

        source_dir = self.deployer.create_local_source_folder(
            self.temp_dir, source_root=self.source_root
        )
        await self._log("stdout", f"{icon} Applying local modifications")
        await self.deployer.make_local_modifications(source_dir)
        if self.db:
            await copy_custom_fonts_to_local_source_folder(self.db, source_dir)

        build_dir = create_build_folder(self.temp_dir, self.deployer.build_id)
        await self._log("stdout", f"{icon} Creating build archive")
        archive_path = await self.deployer.create_local_build_archive(
            build_dir, source_dir, target.arch
        )

        cross_compiled = False
        binary_path: str | None = None
        if allow_cross_compile and can_cross_compile_target(target.arch):
            if build_host:
                await self._log(
                    "stdout",
                    f"{icon} Target supports cross compilation; building binary via build host",
                )
            else:
                await self._log("stdout", f"{icon} Target supports cross compilation; building binary locally")
            try:
                binary_path = await build_binary_with_cross_toolchain(
                    db=self.db,
                    redis=self.redis,
                    frame=self.frame,
                    deployer=self.deployer,
                    source_dir=source_dir,
                    temp_dir=self.temp_dir,
                    build_dir=build_dir,
                    prebuilt_entry=prebuilt_entry,
                    prebuilt_target=prebuilt_target,
                    target_override=target,
                    logger=self._log,
                    build_host=build_host,
                )
            except Exception as exc:
                failure_msg = f"Cross compilation failed ({exc})"
                if build_host:
                    failure_msg = f"Cross compilation failed on build host ({exc})"
                await self._log(
                    "stderr",
                    f"{icon} {failure_msg}",
                )
                if "unix:///var/run/docker.sock" in str(exc).lower():
                    await self._log(
                        "stderr",
                        f"{icon} Read the README at https://github.com/FrameOS/frameos to learn how to enable docker-in-docker, or configure a build server from global settings.",
                    )
                elif "command not found" in str(exc).lower() or "buildx" in str(exc).lower():
                    await self._log(
                        "stderr",
                        f"{icon} Ensure Docker and the Docker Buildx plugin are installed on the build host",
                    )
                elif "permission denied" in str(exc).lower():
                    await self._log(
                        "stderr",
                        f"{icon} Ensure you can connect to the build host and run Docker commands (e.g., is in the 'docker' group)",
                    )
                if force_cross_compile:
                    raise
                else:
                    await self._log(
                        "stderr",
                        f"{icon} Falling back to on-device build!",
                    )
            else:
                cross_compiled = True
                await self._log("stdout", f"{icon} Cross compilation succeeded; skipping remote build")
        elif force_cross_compile:
            raise RuntimeError("Cross compilation required but not supported for this target")

        return FrameBinaryBuildResult(
            build_id=self.deployer.build_id,
            target=target,
            source_dir=source_dir,
            build_dir=build_dir,
            archive_path=archive_path,
            binary_path=binary_path,
            cross_compiled=cross_compiled,
            prebuilt_entry=prebuilt_entry,
            prebuilt_target=prebuilt_target,
            log_path=str(self.log_path) if self.log_path.exists() else None,
        )

    async def _detect_target(self) -> TargetMetadata:
        arch = await self.deployer.get_cpu_architecture()
        distro = await self.deployer.get_distro()
        distro_version = await self.deployer.get_distro_version()
        await self._log(
            "stdout",
            f"{icon} Detected distro: {distro} ({distro_version}), architecture: {arch}",
        )
        return TargetMetadata(arch=arch, distro=distro, version=distro_version)

    async def _log(self, level: str, message: str) -> None:
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(f"[{level}] {message}\n")
        if self.logger:
            await self.logger(level, message)
            return
        if self.db and self.redis:
            await log(self.db, self.redis, int(self.frame.id), level, message)
