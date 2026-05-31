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
from app.drivers.devices import drivers_for_frame
from app.codegen.drivers_nim import (
    COMPILATION_MODE_PRECOMPILED,
    COMPILATION_MODE_STATIC,
    COMPILATION_MODE_SHARED_SCENES,
    frame_compilation_mode,
    normalize_compilation_mode,
)
from app.tasks.precompiled_frameos import (
    download_precompiled_frameos_release,
    frame_compiled_scene_count,
    precompiled_frameos_release_url,
)
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

LINKER_ERROR_HINTS = (
    "linker",
    "ld:",
    "collect2: error",
    "undefined reference",
)


def should_suggest_clearing_build_cache(error_message: str) -> bool:
    normalized = error_message.lower()
    return any(hint in normalized for hint in LINKER_ERROR_HINTS)


@dataclass(slots=True)
class FrameBinaryPlan:
    build_id: str
    target: TargetMetadata
    compilation_mode: str
    allow_cross_compile: bool
    force_cross_compile: bool
    cross_compile_supported: bool
    build_host_configured: bool
    will_attempt_cross_compile: bool
    prebuilt_entry: PrebuiltEntry | None
    prebuilt_target: str | None
    requested_compilation_mode: str | None = None
    will_attempt_precompiled: bool = False
    precompiled_release_url: str | None = None
    precompiled_skip_reason: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "build_id": self.build_id,
            "target": {
                "arch": self.target.arch,
                "distro": self.target.distro,
                "version": self.target.version,
            },
            "requested_compilation_mode": self.requested_compilation_mode or self.compilation_mode,
            "compilation_mode": self.compilation_mode,
            "allow_cross_compile": self.allow_cross_compile,
            "force_cross_compile": self.force_cross_compile,
            "cross_compile_supported": self.cross_compile_supported,
            "build_host_configured": self.build_host_configured,
            "will_attempt_cross_compile": self.will_attempt_cross_compile,
            "prebuilt_target": self.prebuilt_target,
            "has_prebuilt_entry": self.prebuilt_entry is not None,
            "will_attempt_precompiled": self.will_attempt_precompiled,
            "precompiled_release_url": self.precompiled_release_url,
            "precompiled_skip_reason": self.precompiled_skip_reason,
        }


@dataclass(slots=True)
class FrameBinaryBuildResult:
    build_id: str
    target: TargetMetadata
    compilation_mode: str
    source_dir: str
    build_dir: str
    archive_path: str
    binary_path: str | None
    driver_library_paths: list[str]
    driver_library_names: list[str]
    scene_library_paths: list[str]
    scene_library_names: list[str]
    cross_compiled: bool
    prebuilt_entry: PrebuiltEntry | None
    prebuilt_target: str | None
    log_path: str | None
    precompiled: bool = False


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

    async def plan_build(
        self,
        *,
        allow_cross_compile: bool = True,
        force_cross_compile: bool = False,
        target_override: TargetMetadata | None = None,
        compilation_mode: str | None = None,
    ) -> FrameBinaryPlan:
        target = target_override or await self._detect_target()
        requested_compilation_mode = normalize_compilation_mode(
            compilation_mode or frame_compilation_mode(self.frame)
        )
        resolved_compilation_mode = requested_compilation_mode
        prebuilt_entry, prebuilt_target = await resolve_prebuilt_entry(
            distro=target.distro,
            distro_version=target.version,
            arch=target.arch,
            logger=self._log,
        )
        will_attempt_precompiled = False
        precompiled_url = None
        precompiled_skip_reason = None
        if requested_compilation_mode == COMPILATION_MODE_PRECOMPILED and force_cross_compile:
            resolved_compilation_mode = COMPILATION_MODE_STATIC
            precompiled_skip_reason = "cross compilation is required"
        elif requested_compilation_mode == COMPILATION_MODE_PRECOMPILED:
            compiled_scene_count = frame_compiled_scene_count(self.frame)
            precompiled_url = precompiled_frameos_release_url(prebuilt_target or "")
            if compiled_scene_count > 0:
                precompiled_skip_reason = (
                    f"{compiled_scene_count} compiled scene"
                    + ("s are" if compiled_scene_count != 1 else " is")
                    + " configured"
                )
            elif not prebuilt_target:
                precompiled_skip_reason = "no matching precompiled target"
            elif not precompiled_url:
                precompiled_skip_reason = "no matching precompiled release URL"
            else:
                will_attempt_precompiled = True
            if not will_attempt_precompiled:
                resolved_compilation_mode = (
                    COMPILATION_MODE_SHARED_SCENES if compiled_scene_count > 0 else COMPILATION_MODE_STATIC
                )

        build_host = get_build_host_config(self.db)
        cross_compile_supported = can_cross_compile_target(target.arch)
        will_attempt_cross_compile = (
            allow_cross_compile and cross_compile_supported and not will_attempt_precompiled
        )

        return FrameBinaryPlan(
            build_id=self.deployer.build_id,
            target=target,
            compilation_mode=resolved_compilation_mode,
            allow_cross_compile=allow_cross_compile,
            force_cross_compile=force_cross_compile,
            cross_compile_supported=cross_compile_supported,
            build_host_configured=build_host is not None,
            will_attempt_cross_compile=will_attempt_cross_compile,
            prebuilt_entry=prebuilt_entry,
            prebuilt_target=prebuilt_target,
            requested_compilation_mode=requested_compilation_mode,
            will_attempt_precompiled=will_attempt_precompiled,
            precompiled_release_url=precompiled_url,
            precompiled_skip_reason=precompiled_skip_reason,
        )

    async def build(
        self,
        plan: FrameBinaryPlan,
        *,
        precompiled_install_all_drivers: bool = False,
    ) -> FrameBinaryBuildResult:
        build_host = get_build_host_config(self.db)
        await self._log(
            "stdout",
            f"{icon} Preparing local build sources",
        )
        source_dir = self.deployer.create_local_source_folder(
            self.temp_dir, source_root=self.source_root
        )
        await self._log("stdout", f"{icon} Applying local modifications")
        await self.deployer.make_local_modifications(source_dir, compilation_mode=plan.compilation_mode)
        if self.db:
            await copy_custom_fonts_to_local_source_folder(self.db, source_dir)

        build_dir = create_build_folder(self.temp_dir, self.deployer.build_id)
        if plan.will_attempt_precompiled:
            await self._log("stdout", f"{icon} Using precompiled FrameOS release")
            precompiled_result = await download_precompiled_frameos_release(
                frame=self.frame,
                target=plan.prebuilt_target or "",
                build_dir=build_dir,
                temp_dir=self.temp_dir,
                build_id=self.deployer.build_id,
                logger=self._log,
                install_all_drivers=precompiled_install_all_drivers,
            )
            release_action = "Using cached" if precompiled_result.cache_hit else "Downloaded"
            await self._log(
                "stdout",
                f"{icon} {release_action} precompiled FrameOS release: {precompiled_result.release_url}",
            )
            return FrameBinaryBuildResult(
                build_id=self.deployer.build_id,
                target=plan.target,
                compilation_mode=plan.compilation_mode,
                source_dir=source_dir,
                build_dir=build_dir,
                archive_path=precompiled_result.archive_path,
                binary_path=precompiled_result.binary_path,
                driver_library_paths=precompiled_result.driver_library_paths,
                driver_library_names=precompiled_result.driver_library_names,
                scene_library_paths=precompiled_result.scene_library_paths,
                scene_library_names=precompiled_result.scene_library_names,
                cross_compiled=True,
                prebuilt_entry=plan.prebuilt_entry,
                prebuilt_target=plan.prebuilt_target,
                log_path=str(self.log_path) if self.log_path.exists() else None,
                precompiled=True,
            )

        await self._log("stdout", f"{icon} Creating build archive")
        archive_path = await self.deployer.create_local_build_archive(
            build_dir, source_dir, plan.target.arch, compilation_mode=plan.compilation_mode
        )

        cross_compiled = False
        binary_path: str | None = None
        if plan.will_attempt_cross_compile:
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
                    prebuilt_entry=plan.prebuilt_entry,
                    prebuilt_target=plan.prebuilt_target,
                    target_override=plan.target,
                    logger=self._log,
                    build_host=build_host,
                )
            except Exception as exc:
                error_message = str(exc)
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
                        f"{icon} Read the README at https://github.com/FrameOS/frameos to learn how to enable Docker access for source cross-compilation, or configure a build server from global settings.",
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
                if should_suggest_clearing_build_cache(error_message):
                    await self._log(
                        "stderr",
                        f"{icon} If the failure is caused by a stale linker cache, clear the build cache (press ... in logs or settings) and try deploying again.",
                    )
                if plan.force_cross_compile:
                    raise
                else:
                    await self._log(
                        "stderr",
                        f"{icon} Falling back to on-device build!",
                    )
            else:
                cross_compiled = True
                await self._log("stdout", f"{icon} Cross compilation succeeded; skipping remote build")
        elif plan.force_cross_compile:
            raise RuntimeError("Cross compilation required but not supported for this target")

        return FrameBinaryBuildResult(
            build_id=self.deployer.build_id,
            target=plan.target,
            compilation_mode=plan.compilation_mode,
            source_dir=source_dir,
            build_dir=build_dir,
            archive_path=archive_path,
            binary_path=binary_path,
            driver_library_paths=self.deployer.driver_library_paths(
                build_dir,
                drivers_for_frame(self.frame),
                plan.compilation_mode,
            ),
            driver_library_names=self.deployer.driver_library_names(
                drivers_for_frame(self.frame),
                plan.compilation_mode,
            ),
            scene_library_paths=self.deployer.scene_library_paths(
                build_dir,
                self.frame,
                plan.compilation_mode,
            ),
            scene_library_names=self.deployer.scene_library_names(
                self.frame,
                plan.compilation_mode,
            ),
            cross_compiled=cross_compiled,
            prebuilt_entry=plan.prebuilt_entry,
            prebuilt_target=plan.prebuilt_target,
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
