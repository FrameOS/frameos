from __future__ import annotations

import hashlib
import os
import re
import shlex
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from textwrap import dedent
from typing import Awaitable, Callable, Iterable

import httpx

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.prebuilt_deps import (
    PrebuiltEntry,
    fetch_prebuilt_manifest,
    resolve_prebuilt_target,
)
from app.utils.build_host import BuildHostConfig, BuildHostSession
from app.utils.local_exec import exec_local_command

icon = "🔶"


@dataclass(slots=True)
class TargetMetadata:
    arch: str
    distro: str
    version: str
    platform: str | None = None
    image: str | None = None


@dataclass(slots=True)
class CrossCompileArtifacts:
    binary_path: str | None
    scenes_dir: str | None
    drivers_dir: str | None


SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_.-]+")
CACHE_ENV = "FRAMEOS_CROSS_CACHE"
DEFAULT_CACHE = Path.home() / ".cache/frameos/cross"
PREBUILT_TIMEOUT = float(os.environ.get("FRAMEOS_PREBUILT_TIMEOUT", "20"))
FEATURE_FLAG_ENV = "FRAMEOS_CROSS_FEATURE_CFLAGS"
DEFAULT_FEATURE_CFLAGS = {
    "amd64": ["-mavx2", "-mavx", "-msse4.1", "-mssse3", "-mpclmul", "-mvpclmulqdq"],
    "x86_64": ["-mavx2", "-mavx", "-msse4.1", "-mssse3", "-mpclmul", "-mvpclmulqdq"],
}
TOOLCHAIN_IMAGE_VERSION = "1"
BACKEND_ROOT = Path(__file__).resolve().parents[2]
CROSS_TOOLCHAIN_DOCKERFILE = BACKEND_ROOT / "tools" / "cross-toolchain.Dockerfile"
TOOLCHAIN_PACKAGES = (
    "build-essential ca-certificates curl git make pkg-config python3 python3-pip "
    "unzip xz-utils zlib1g-dev libssl-dev libffi-dev libjpeg-dev libfreetype6-dev libevdev-dev"
)


PLATFORM_MAP = {
    "amd64": "linux/amd64",
    "x86_64": "linux/amd64",
    "aarch64": "linux/arm64",
    "arm64": "linux/arm64",
    "armv8": "linux/arm64",
    "armv7l": "linux/arm/v7",
    "armv7": "linux/arm/v7",
    "armhf": "linux/arm/v7",
    "armv6l": "linux/arm/v6",
}


def _pluralize(count: int, singular: str, plural: str | None = None) -> str:
    if count == 1:
        return singular
    return plural or f"{singular}s"


def _short_scene_id(scene_id: str) -> str:
    normalized = str(scene_id or "default")
    if len(normalized) <= 12:
        return normalized
    return f"{normalized[:8]}..."


def _format_scene_label(frame: Frame, scene_id: str) -> str:
    for scene in (getattr(frame, "scenes", None) or []):
        current_id = str(scene.get("id") or "default")
        if current_id != scene_id:
            continue
        scene_name = str(scene.get("name") or "").strip()
        short_id = _short_scene_id(scene_id)
        if scene_name and scene_name != scene_id:
            return f"{scene_name} ({short_id})"
        return short_id
    return _short_scene_id(scene_id)

def can_cross_compile_target(arch: str | None) -> bool:
    """Return ``True`` when *arch* has a known Docker platform mapping."""

    return (arch or "").lower() in PLATFORM_MAP


DISTRO_DEFAULTS = {
    "raspios": ("debian", "bookworm"),
    "debian": ("debian", "bookworm"),
    "ubuntu": ("ubuntu", "22.04"),
    "buildroot": ("ubuntu", "22.04"),
}


LogFunc = Callable[[str, str], Awaitable[None]]


class CrossCompiler:
    def __init__(
        self,
        *,
        db: Session | None,
        redis: Redis | None,
        frame: Frame,
        deployer: FrameDeployer,
        target: TargetMetadata,
        temp_dir: str,
        prebuilt_entry: PrebuiltEntry | None = None,
        prebuilt_target: str | None = None,
        logger: LogFunc | None = None,
        build_dir: str | Path | None = None,
        build_host: BuildHostConfig | None = None,
    ) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame
        self.deployer = deployer
        self.target = target
        self.temp_dir = Path(temp_dir)
        cache_root = self._cache_root()
        cache_root.mkdir(parents=True, exist_ok=True)
        key = "-".join(self._sanitize(part) for part in (target.distro, target.version, target.arch))
        self.toolchain_dir = cache_root / key
        self.toolchain_dir.mkdir(parents=True, exist_ok=True)
        self.sysroot_dir = self.temp_dir / f"sysroot-{key}-{self._sanitize(getattr(deployer, 'build_id', 'build'))}"
        self.sysroot_dir.mkdir(parents=True, exist_ok=True)
        self.prebuilt_entry = prebuilt_entry
        self.prebuilt_target = prebuilt_target
        self.prebuilt_dir = cache_root / "prebuilt" / key
        self.prebuilt_dir.mkdir(parents=True, exist_ok=True)
        self.build_dir_override = Path(build_dir) if build_dir else None
        self.prebuilt_components: dict[str, Path] = {}
        self.prebuilt_timeout = PREBUILT_TIMEOUT
        self.logger = logger
        self.build_host = build_host
        self._build_host_session: BuildHostSession | None = None
        self._remote_root: Path | None = None
        self._sysroot_include_dirs: set[str] = set()
        self._sysroot_lib_dirs: set[str] = set()
        for rel in ("usr/include", "usr/local/include", "usr/lib", "usr/local/lib"):
            (self.sysroot_dir / rel).mkdir(parents=True, exist_ok=True)

    async def build(self, source_dir: str) -> str:
        result = await self.build_artifacts(source_dir)
        if not result.binary_path:
            raise RuntimeError("Cross compilation completed without producing a frameos binary")
        return result.binary_path

    async def build_artifacts(
        self,
        source_dir: str,
        *,
        build_binary: bool = True,
        build_scene_ids: list[str] | tuple[str, ...] | None = None,
        build_scene_dirs: list[str] | None = None,
        build_driver_ids: list[str] | tuple[str, ...] | None = None,
        build_driver_dirs: list[str] | None = None,
        build_all_scenes: bool = True,
    ) -> CrossCompileArtifacts:
        if self.build_host:
            await self._log(
                "stdout",
                f"{icon} Connecting to build host {self.build_host.user}@{self.build_host.host}:{self.build_host.port}",
            )
            async with BuildHostSession(self.build_host, logger=self._log) as session:
                self._build_host_session = session
                self._remote_root = Path(await session.mktemp_dir("frameos-cross-"))
                await self._log(
                    "stdout",
                    f"🟢 Connected to build host {self.build_host.user}@{self.build_host.host}:{self.build_host.port} for cross compilation",
                )
                try:
                    return await self._build_with_context(
                        source_dir,
                        build_binary=build_binary,
                        build_scene_ids=build_scene_ids,
                        build_scene_dirs=build_scene_dirs,
                        build_driver_ids=build_driver_ids,
                        build_driver_dirs=build_driver_dirs,
                        build_all_scenes=build_all_scenes,
                    )
                finally:
                    self._build_host_session = None
                    self._remote_root = None
        return await self._build_with_context(
            source_dir,
            build_binary=build_binary,
            build_scene_ids=build_scene_ids,
            build_scene_dirs=build_scene_dirs,
            build_driver_ids=build_driver_ids,
            build_driver_dirs=build_driver_dirs,
            build_all_scenes=build_all_scenes,
        )

    async def _build_with_context(
        self,
        source_dir: str,
        *,
        build_binary: bool,
        build_scene_ids: list[str] | tuple[str, ...] | None,
        build_scene_dirs: list[str] | None,
        build_driver_ids: list[str] | tuple[str, ...] | None,
        build_driver_dirs: list[str] | None,
        build_all_scenes: bool,
    ) -> CrossCompileArtifacts:
        await self._log(
            "stdout",
            f"{icon} Cross compiling for {self.target.arch} on {self._docker_image()} via {self._platform()}",
        )
        await self._prepare_prebuilt_components()
        if build_binary:
            await self._ensure_quickjs_sources(source_dir)
        build_dir = self.build_dir_override
        if build_dir:
            build_dir = Path(build_dir)
            if not self._build_dir_has_requested_sources(
                build_dir,
                build_binary=build_binary,
                build_scene_dirs=build_scene_dirs,
                build_driver_dirs=build_driver_dirs,
                build_all_scenes=build_all_scenes,
            ):
                await self._log(
                    "stderr",
                    f"{icon} Provided build directory {build_dir} is missing generated sources; regenerating",
                )
                build_dir = await self._generate_c_sources(
                    source_dir,
                    build_binary=build_binary,
                    build_scene_ids=build_scene_ids,
                    build_scene_dirs=build_scene_dirs,
                    build_driver_ids=build_driver_ids,
                    build_driver_dirs=build_driver_dirs,
                    build_all_scenes=build_all_scenes,
                )
        else:
            build_dir = await self._generate_c_sources(
                source_dir,
                build_binary=build_binary,
                build_scene_ids=build_scene_ids,
                build_scene_dirs=build_scene_dirs,
                build_driver_ids=build_driver_ids,
                build_driver_dirs=build_driver_dirs,
                build_all_scenes=build_all_scenes,
            )
        await self._prepare_sysroot()
        await self._ensure_lgpio_in_sysroot()
        if build_binary:
            await self._ensure_quickjs_in_build_dir(source_dir, build_dir)
        return await self._run_docker_build(
            str(build_dir),
            build_binary=build_binary,
            build_scene_ids=build_scene_ids,
            build_scene_dirs=build_scene_dirs,
            build_driver_ids=build_driver_ids,
            build_driver_dirs=build_driver_dirs,
            build_all_scenes=build_all_scenes,
        )

    @staticmethod
    def _build_dir_has_requested_sources(
        build_dir: Path,
        *,
        build_binary: bool,
        build_scene_dirs: list[str] | None,
        build_driver_dirs: list[str] | None,
        build_all_scenes: bool,
    ) -> bool:
        if build_binary and not (build_dir / "compile_frameos.sh").exists():
            return False

        if build_all_scenes or build_scene_dirs:
            scene_root = build_dir / "scene_builds"
            if not scene_root.is_dir():
                return False
            if build_scene_dirs:
                if not all((build_dir / scene_dir).is_dir() for scene_dir in build_scene_dirs):
                    return False

        if build_driver_dirs:
            driver_root = build_dir / "driver_builds"
            if not driver_root.is_dir():
                return False
            if not all((build_dir / driver_dir).is_dir() for driver_dir in build_driver_dirs):
                return False

        return True

    async def _prepare_sysroot(self) -> None:
        if self.prebuilt_components:
            await self._log(
                "stdout",
                f"{icon} Staging prebuilt sysroot components",
            )
            for component in self.prebuilt_components:
                self._inject_prebuilt_component(component)
        else:
            await self._log(
                "stdout",
                f"{icon} Using default include/lib paths without remote sysroot synchronization",
            )

    async def _run_docker_build(
        self,
        build_dir: str,
        *,
        build_binary: bool = True,
        build_scene_ids: list[str] | tuple[str, ...] | None = None,
        build_scene_dirs: list[str] | None = None,
        build_driver_ids: list[str] | tuple[str, ...] | None = None,
        build_driver_dirs: list[str] | None = None,
        build_all_scenes: bool = True,
    ) -> CrossCompileArtifacts:
        build_dir = os.path.abspath(build_dir)
        script_path = self.temp_dir / "frameos-cross-build.sh"
        if build_binary:
            await self._log("stdout", f"{icon} FrameOS compile: cross-compiling")
        if build_all_scenes:
            await self._log("stdout", f"{icon} Scene compile: cross-compiling all requested scenes")
        elif build_scene_dirs:
            await self._log(
                "stdout",
                f"{icon} Scene compile: cross-compiling {len(build_scene_dirs)} {_pluralize(len(build_scene_dirs), 'scene')}",
            )
        for scene_id in build_scene_ids or ():
            await self._log("stdout", f"{icon} Compiling scene: {_format_scene_label(self.frame, scene_id)}")
        if build_driver_dirs:
            await self._log(
                "stdout",
                f"{icon} Driver compile: cross-compiling {len(build_driver_dirs)} {_pluralize(len(build_driver_dirs), 'driver')}",
            )
        for driver_id in build_driver_ids or ():
            await self._log("stdout", f"{icon} Compiling driver: {driver_id}")
        include_candidates = (
            [f"/sysroot{path}" for path in sorted(self._sysroot_include_dirs)]
            if self._sysroot_include_dirs
            else ["/sysroot/usr/include", "/sysroot/usr/local/include"]
        )
        include_dirs = self._dedupe_preserve_order(
            self._existing_container_dirs(include_candidates)
        )
        lib_candidates = (
            [f"/sysroot{path}" for path in sorted(self._sysroot_lib_dirs)]
            if self._sysroot_lib_dirs
            else ["/sysroot/usr/lib", "/sysroot/usr/local/lib"]
        )
        lib_dirs = self._dedupe_preserve_order(
            self._existing_container_dirs(lib_candidates)
        )
        feature_flags = self._cpu_feature_cflags()
        if feature_flags:
            await self._log(
                "stdout",
                f"{icon} Enabling CPU feature flags for cross-compile: "
                + " ".join(feature_flags),
            )
        include_flags = [f"-I{path}" for path in include_dirs]
        extra_cflags_parts = [*feature_flags, *include_flags]
        extra_cflags = (
            shlex.quote(" ".join(extra_cflags_parts)) if extra_cflags_parts else "''"
        )
        extra_libs = shlex.quote(" ".join(f"-L{path}" for path in lib_dirs)) if lib_dirs else "''"
        build_commands: list[str] = []
        if build_binary and build_all_scenes:
            build_commands.append('make -j"$(nproc)"')
        else:
            if build_binary:
                build_commands.append('make -j"$(nproc)" frameos')
            if build_scene_dirs:
                quoted_dirs = " ".join(shlex.quote(scene_dir) for scene_dir in build_scene_dirs)
                build_commands.append(
                    "mkdir -p scenes && "
                    f"for dir in {quoted_dirs}; do make --no-print-directory -C \"$dir\" || exit $?; done"
                )
            elif build_all_scenes:
                build_commands.append("make compiled-scenes")
        if build_driver_dirs:
            quoted_dirs = " ".join(shlex.quote(driver_dir) for driver_dir in build_driver_dirs)
            build_commands.append(
                "mkdir -p drivers && "
                f"for dir in {quoted_dirs}; do make --no-print-directory -C \"$dir\" || exit $?; done"
            )
        if not build_commands:
            await self._log(
                "stdout",
                f"{icon} Cross compilation skipped; no binary, scene, or driver artifacts requested",
            )

        script_content = (
            dedent(
                f"""
                #!/usr/bin/env bash
                set -euo pipefail

                log_debug() {{
                    printf '[frameos-cross] %s\n' "$*" >&2
                }}

                log_debug "Container uname: $(uname -a)"
                log_debug "Working directory before build: $(pwd)"

                extra_cflags={extra_cflags}
                extra_libs={extra_libs}
                if [ -n "$extra_cflags" ]; then
                    log_debug "Using extra CFLAGS: $extra_cflags"
                    export EXTRA_CFLAGS="$extra_cflags"
                fi
                if [ -n "$extra_libs" ]; then
                    log_debug "Using extra LIBS: $extra_libs"
                    export EXTRA_LIBS="$extra_libs"
                fi

                cd /src
                log_debug "Compiling requested generated C targets"
                {chr(10).join(build_commands) if build_commands else 'log_debug "Nothing to compile"'}
                log_debug "build completed"
                """
            ).strip()
            + "\n"
        )

        image = await self._ensure_toolchain_image()

        if self._build_host_session:
            return await self._run_remote_docker_build(
                build_dir,
                script_content,
                image,
                build_binary=build_binary,
                build_scene_dirs=build_scene_dirs,
                build_driver_dirs=build_driver_dirs,
                build_all_scenes=build_all_scenes,
            )

        script_path.write_text(script_content)
        os.chmod(script_path, 0o755)

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"--platform {self._platform()}",
                f"-v {shlex.quote(build_dir)}:/src",
                f"-v {shlex.quote(str(self.sysroot_dir))}:/sysroot:ro",
                f"-v {shlex.quote(str(script_path))}:/tmp/frameos-cross/build.sh:ro",
                "-w /src",
                shlex.quote(image),
                "bash /tmp/frameos-cross/build.sh",
            ]
        )

        status, _, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            docker_cmd,
            log_command=False,
            log_output=False,
        )
        if status != 0:
            raise RuntimeError(f"Cross compilation failed: {err or 'see logs'}")
        binary_path = os.path.join(build_dir, "frameos") if build_binary else None
        if binary_path and not os.path.exists(binary_path):
            raise RuntimeError("Cross compilation completed but frameos binary is missing")
        scenes_dir = os.path.join(build_dir, "scenes") if build_scene_dirs or build_all_scenes else None
        if scenes_dir and not os.path.isdir(scenes_dir):
            scenes_dir = None
        drivers_dir = os.path.join(build_dir, "drivers") if build_driver_dirs else None
        if drivers_dir and not os.path.isdir(drivers_dir):
            drivers_dir = None
        return CrossCompileArtifacts(binary_path=binary_path, scenes_dir=scenes_dir, drivers_dir=drivers_dir)

    async def _run_remote_docker_build(
        self,
        build_dir: str,
        script_content: str,
        image: str,
        *,
        build_binary: bool = True,
        build_scene_dirs: list[str] | None = None,
        build_driver_dirs: list[str] | None = None,
        build_all_scenes: bool = True,
    ) -> CrossCompileArtifacts:
        if not self._build_host_session or not self._remote_root:
            raise RuntimeError("Build host session unavailable during cross compilation")

        host = self._build_host_session
        remote_build_dir = str(self._remote_root / "src")
        remote_sysroot_dir = str(self._remote_root / "sysroot")
        remote_script_path = str(self._remote_root / "build.sh")

        build_dir_size = self._dir_size_bytes(Path(build_dir))
        await self._log(
            "stdout",
            f"{icon} Syncing build directory ({self._format_size(build_dir_size)}) to build host"
        )
        await host.sync_dir_tarball(build_dir, remote_build_dir)
        sysroot_size = self._dir_size_bytes(self.sysroot_dir)
        await self._log(
            "stdout",
            f"{icon} Syncing sysroot ({self._format_size(sysroot_size)}) to build host"
        )
        await host.sync_dir_tarball(str(self.sysroot_dir), remote_sysroot_dir)
        await host.write_file(remote_script_path, script_content, mode=0o755)

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"--platform {self._platform()}",
                f"-v {shlex.quote(remote_build_dir)}:/src",
                f"-v {shlex.quote(remote_sysroot_dir)}:/sysroot:ro",
                f"-v {shlex.quote(remote_script_path)}:/tmp/build.sh:ro",
                "-w /src",
                shlex.quote(image),
                "bash /tmp/build.sh",
            ]
        )

        status, _, err = await host.run(
            docker_cmd,
            log_command=False,
            log_output=False,
        )
        if status != 0:
            raise RuntimeError(f"Cross compilation failed: {err or 'see logs'}")

        local_binary = os.path.join(build_dir, "frameos") if build_binary else None
        if local_binary:
            await host.download_file(f"{remote_build_dir}/frameos", local_binary)
        remote_scenes_dir = f"{remote_build_dir}/scenes"
        local_scenes_dir = os.path.join(build_dir, "scenes")
        scenes_status, _stdout, _stderr = await host.run(
            f"test -d {shlex.quote(remote_scenes_dir)}",
            log_command=False,
            log_output=False,
        )
        if scenes_status == 0:
            await self._log(
                "stdout",
                f"{icon} Downloading compiled scene artifacts from build host",
            )
            await host.download_dir_tarball(remote_scenes_dir, local_scenes_dir)
        elif build_scene_dirs or build_all_scenes:
            local_scenes_dir = None
        local_drivers_dir: str | None = None
        if build_driver_dirs:
            remote_drivers_dir = f"{remote_build_dir}/drivers"
            local_drivers_dir = os.path.join(build_dir, "drivers")
            drivers_status, _stdout, _stderr = await host.run(
                f"test -d {shlex.quote(remote_drivers_dir)}",
                log_command=False,
                log_output=False,
            )
            if drivers_status == 0:
                await self._log(
                    "stdout",
                    f"{icon} Downloading compiled driver artifacts from build host",
                )
                await host.download_dir_tarball(remote_drivers_dir, local_drivers_dir)
            else:
                local_drivers_dir = None
        return CrossCompileArtifacts(
            binary_path=local_binary,
            scenes_dir=local_scenes_dir,
            drivers_dir=local_drivers_dir,
        )

    async def _run_command(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
    ) -> tuple[int, str | None, str | None]:
        if self._build_host_session:
            return await self._build_host_session.run(
                command, log_command=log_command, log_output=log_output
            )
        return await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            command,
            log_command=log_command,
            log_output=log_output,
        )

    def _cpu_feature_cflags(self) -> list[str]:
        arch = (self.target.arch or "").lower()
        flags = list(DEFAULT_FEATURE_CFLAGS.get(arch, []))
        override = os.environ.get(FEATURE_FLAG_ENV)
        if override:
            flags.extend(arg for arg in shlex.split(override) if arg)
        return flags

    async def _ensure_quickjs_sources(self, source_dir: str) -> None:
        quickjs_root = Path(source_dir) / "quickjs"
        await self._log(
            "stdout",
            f"{icon} Ensuring QuickJS sources are available at {quickjs_root} (exists={quickjs_root.exists()})",
        )
        await self._ensure_quickjs_tree(
            quickjs_root,
            context="source directory",
            fallback_src=None,
            error_message=(
                "QuickJS sources are missing; run `nimble build_quickjs` "
                "or publish a prebuilt component."
            ),
        )

    async def _generate_c_sources(
        self,
        source_dir: str,
        *,
        build_binary: bool,
        build_scene_ids: list[str] | tuple[str, ...] | None,
        build_scene_dirs: list[str] | None,
        build_driver_ids: list[str] | tuple[str, ...] | None,
        build_driver_dirs: list[str] | None,
        build_all_scenes: bool,
    ) -> Path:
        build_dir = self.temp_dir / f"build_{self.deployer.build_id}"
        build_dir.mkdir(parents=True, exist_ok=True)
        await self.deployer.create_local_build_archive(
            str(build_dir),
            source_dir,
            self.target.arch,
            build_binary=build_binary,
            build_scene_ids=build_scene_ids,
            build_driver_ids=build_driver_ids,
            build_all_scenes=build_all_scenes,
        )
        return build_dir

    async def _ensure_quickjs_in_build_dir(self, source_dir: str, build_dir: Path) -> None:
        dest = Path(build_dir) / "quickjs"
        source_quickjs = Path(source_dir) / "quickjs"
        await self._log(
            "stdout",
            f"{icon} Ensuring QuickJS assets exist within build dir {dest} (exists={dest.exists()})",
        )
        fallback_src = source_quickjs if source_quickjs.exists() else None
        await self._ensure_quickjs_tree(
            dest,
            context="build directory",
            fallback_src=fallback_src,
            error_message=(
                "QuickJS libraries missing from generated C sources; unable to continue cross compilation"
            ),
        )

    async def _ensure_quickjs_tree(
        self,
        dest: Path,
        *,
        context: str,
        fallback_src: Path | None,
        error_message: str,
    ) -> None:
        if self._quickjs_tree_is_usable(dest):
            await self._log("stdout", f"{icon} Found QuickJS assets at {dest}")
            return

        prebuilt_quickjs = self.prebuilt_components.get("quickjs")
        if prebuilt_quickjs:
            await self._log(
                "stdout",
                f"{icon} Staging prebuilt QuickJS component from {prebuilt_quickjs} into {dest}",
            )
            self._stage_prebuilt_quickjs(dest)
            if self._quickjs_tree_is_usable(dest):
                await self._log("stdout", f"{icon} Found QuickJS assets at {dest}")
                return

        if fallback_src and fallback_src != dest and self._quickjs_tree_is_usable(fallback_src):
            if dest.exists():
                shutil.rmtree(dest)
            await self._log(
                "stdout",
                f"{icon} Copying QuickJS tree from {fallback_src} into {dest}",
            )
            shutil.copytree(fallback_src, dest, dirs_exist_ok=True)
            if self._quickjs_tree_is_usable(dest):
                await self._log("stdout", f"{icon} Found QuickJS assets at {dest}")
                return

        await self._log_quickjs_probe(dest.parent, context)
        raise RuntimeError(error_message)

    async def _prepare_prebuilt_components(self) -> None:
        if not self.prebuilt_entry:
            return

        if self.prebuilt_target:
            await self._log(
                "stdout",
                f"{icon} Attempting to use prebuilt components for {self.prebuilt_target}",
            )

        for component in ("quickjs", "lgpio"):
            path = await self._ensure_prebuilt_component(component)
            if path:
                self.prebuilt_components[component] = path

    async def _ensure_lgpio_in_sysroot(self) -> None:
        """Guarantee lgpio headers and libraries are staged in the sysroot."""

        header = self.sysroot_dir / "usr/local/include/lgpio.h"
        static_lib = self.sysroot_dir / "usr/local/lib/liblgpio.a"
        if header.exists() and static_lib.exists():
            return

        # Attempt to (re)download the prebuilt component if it's missing.
        if self.prebuilt_entry:
            if "lgpio" not in self.prebuilt_components:
                path = await self._ensure_prebuilt_component("lgpio")
                if path:
                    self.prebuilt_components["lgpio"] = path
            self._inject_prebuilt_component("lgpio")

        if header.exists() and static_lib.exists():
            return

        await self._log(
            "stderr",
            "lgpio headers or libraries are missing from the sysroot after staging; "
            "publish a prebuilt lgpio archive to archive.frameos.org and retry the build.",
        )
        raise RuntimeError("lgpio libraries missing from sysroot; unable to continue cross compilation")

    async def _ensure_prebuilt_component(self, component: str) -> Path | None:
        if not self.prebuilt_entry:
            return None
        local_path = self.prebuilt_entry.path_for(component)
        url = self.prebuilt_entry.url_for(component)
        if not local_path and not url:
            return None
        version = self.prebuilt_entry.version_for(component, "unknown") or "unknown"
        safe_version = self._sanitize(version)
        dest_dir = self.prebuilt_dir / f"{component}-{safe_version}"
        marker = dest_dir / ".build-info"
        source_ref = local_path or url or ""
        expected_marker = f"{component}|{version}|{source_ref}|{self.prebuilt_entry.md5_for(component) or ''}"
        if marker.exists() and marker.read_text() == expected_marker:
            if self._prebuilt_component_is_usable(component, dest_dir):
                return dest_dir
            await self._log(
                "stdout",
                f"{icon} Cached prebuilt {component} at {dest_dir} is incomplete; refreshing",
            )
            shutil.rmtree(dest_dir, ignore_errors=True)
            dest_dir.mkdir(parents=True, exist_ok=True)

        if local_path:
            source_dir = Path(local_path)
            if not source_dir.exists():
                await self._log(
                    "stderr",
                    f"{icon} Local prebuilt {component} path does not exist: {source_dir}",
                )
                return None

            await self._log("stdout", f"{icon} Staging local prebuilt {component} from {source_dir}")
            if not self._prebuilt_component_is_usable(component, source_dir):
                await self._log(
                    "stderr",
                    f"{icon} Local prebuilt {component} at {source_dir} is incomplete; falling back",
                )
                return None
            return source_dir

        await self._log("stdout", f"{icon} Downloading prebuilt {component} ({version})")
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        try:
            await self._download_and_extract(url, dest_dir, self.prebuilt_entry.md5_for(component))
            self._normalize_component_dir(dest_dir)
            if not self._prebuilt_component_is_usable(component, dest_dir):
                raise RuntimeError(
                    f"prebuilt {component} archive did not contain the expected files"
                )
        except Exception as exc:
            await self._log(
                "stderr",
                f"{icon} Failed to download prebuilt {component}: {exc}; falling back",
            )
            shutil.rmtree(dest_dir, ignore_errors=True)
            return None

        marker.write_text(expected_marker)
        return dest_dir

    def _prebuilt_component_is_usable(self, component: str, root: Path) -> bool:
        if component == "quickjs":
            return self._quickjs_tree_is_usable(root)
        if component == "lgpio":
            return self._lgpio_tree_is_usable(root)
        return root.exists()

    def _quickjs_tree_is_usable(self, root: Path) -> bool:
        return (
            self._first_file_match(root, "quickjs.h") is not None
            and self._first_file_match(root, "quickjs-libc.h") is not None
            and self._first_file_match(root, "libquickjs.a") is not None
        )

    def _lgpio_tree_is_usable(self, root: Path) -> bool:
        return (
            self._first_file_match(root, "lgpio.h") is not None
            and (
                self._first_file_match(root, "liblgpio.a") is not None
                or self._first_file_match(root, "liblgpio.so*") is not None
            )
        )

    async def _download_and_extract(self, url: str, dest_dir: Path, expected_md5: str | None) -> None:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
        os.close(tmp_fd)
        try:
            async with httpx.AsyncClient(timeout=self.prebuilt_timeout) as client:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    with open(tmp_path, "wb") as fh:
                        async for chunk in response.aiter_bytes():
                            fh.write(chunk)
            if expected_md5:
                actual = self._file_md5sum(Path(tmp_path))
                if actual != expected_md5:
                    raise RuntimeError(
                        f"MD5 mismatch for {url}: expected {expected_md5}, got {actual}"
                    )
            with tarfile.open(tmp_path, "r:gz") as tar:
                self._safe_extract(tar, dest_dir)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    @staticmethod
    def _safe_extract(tar: tarfile.TarFile, path: Path) -> None:
        for member in tar.getmembers():
            member_path = path / member.name
            if not str(member_path.resolve()).startswith(str(path.resolve())):
                raise RuntimeError("Tar file attempted to escape target directory")
        tar.extractall(path=path)

    @staticmethod
    def _normalize_component_dir(dest_dir: Path) -> None:
        entries = [p for p in dest_dir.iterdir() if p.name not in {".build-info",}]
        subdirs = [p for p in entries if p.is_dir()]
        files = [p for p in entries if p.is_file()]
        if files or not subdirs:
            return
        if len(subdirs) != 1:
            return
        inner = subdirs[0]
        for child in inner.iterdir():
            shutil.move(str(child), dest_dir / child.name)
        shutil.rmtree(inner)

    @staticmethod
    def _file_md5sum(path: Path) -> str:
        hasher = hashlib.md5()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def _stage_prebuilt_quickjs(self, dest: Path) -> None:
        quickjs_dir = self.prebuilt_components.get("quickjs")
        if not quickjs_dir:
            return
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True, exist_ok=True)
        include_src = self._find_quickjs_include_dir(quickjs_dir)
        if include_src:
            target_include = dest / "include" / "quickjs"
            target_include.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(include_src, target_include, dirs_exist_ok=True)

        header = self._first_file_match(quickjs_dir, "quickjs.h")
        if header:
            shutil.copy2(header, dest / "quickjs.h")

        libc_header = self._first_file_match(quickjs_dir, "quickjs-libc.h")
        if libc_header:
            shutil.copy2(libc_header, dest / "quickjs-libc.h")

        libquickjs = self._first_file_match(quickjs_dir, "libquickjs.a")
        if libquickjs:
            shutil.copy2(libquickjs, dest / "libquickjs.a")

    @staticmethod
    def _find_quickjs_include_dir(root: Path) -> Path | None:
        direct = root / "include" / "quickjs"
        if (
            direct.is_dir()
            and (direct / "quickjs.h").is_file()
            and (direct / "quickjs-libc.h").is_file()
        ):
            return direct
        candidates = sorted(
            path
            for path in root.rglob("quickjs")
            if path.is_dir()
            and (path / "quickjs.h").is_file()
            and (path / "quickjs-libc.h").is_file()
        )
        return candidates[0] if candidates else None

    @staticmethod
    def _first_file_match(root: Path, pattern: str) -> Path | None:
        matches = sorted(path for path in root.rglob(pattern) if path.is_file())
        return matches[0] if matches else None

    def _inject_prebuilt_component(self, component: str) -> None:
        if component == "lgpio":
            self._inject_prebuilt_lgpio()

    def _inject_prebuilt_lgpio(self) -> None:
        lgpio_dir = self.prebuilt_components.get("lgpio")
        if not lgpio_dir:
            return
        include_src = lgpio_dir / "include"
        lib_src = lgpio_dir / "lib"
        if include_src.exists():
            shutil.copytree(include_src, self.sysroot_dir / "usr/local/include", dirs_exist_ok=True)
            self._register_sysroot_dir("/usr/local/include")
        if lib_src.exists():
            shutil.copytree(lib_src, self.sysroot_dir / "usr/local/lib", dirs_exist_ok=True)
            self._register_sysroot_dir("/usr/local/lib")

    async def _log(self, level: str, message: str) -> None:
        if self.logger:
            await self.logger(level, message)
            return
        elif self.db and self.redis:
            await log(self.db, self.redis, int(self.frame.id), level, message)
        else:
            print(f"[{level}] {message}")

    def _existing_container_dirs(self, candidates: Iterable[str]) -> list[str]:
        existing: list[str] = []
        for candidate in candidates:
            rel = candidate.lstrip("/")
            if rel.startswith("sysroot/"):
                rel = rel[len("sysroot/") :]
            host_path = self.sysroot_dir / rel
            if host_path.exists():
                existing.append(candidate)
        return existing

    def _register_sysroot_dir(self, path: str) -> None:
        normalized = "/" + path.lstrip("/")
        if normalized.startswith("/usr/include"):
            self._sysroot_include_dirs.add(normalized)
        elif normalized.startswith("/usr/local/include"):
            self._sysroot_include_dirs.add(normalized)
        elif normalized.startswith("/usr/lib"):
            self._sysroot_lib_dirs.add(normalized)
        elif normalized.startswith("/usr/local/lib"):
            self._sysroot_lib_dirs.add(normalized)

    @staticmethod
    def _dedupe_preserve_order(values: Iterable[str]) -> list[str]:
        seen: set[str] = set()
        ordered: list[str] = []
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            ordered.append(value)
        return ordered

    def _dir_size_bytes(self, path: Path) -> int:
        total = 0
        if not path.exists():
            return total

        stack = [path]
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(Path(entry.path))
                            elif entry.is_file(follow_symlinks=False):
                                total += entry.stat(follow_symlinks=False).st_size
                        except FileNotFoundError:
                            continue
            except FileNotFoundError:
                continue

        return total

    @staticmethod
    def _format_size(size: int) -> str:
        units = ["B", "KiB", "MiB", "GiB", "TiB"]
        value = float(size)
        for unit in units:
            if value < 1024 or unit == units[-1]:
                if unit == "B":
                    return f"{int(value)} {unit}"
                return f"{value:.1f} {unit}"
            value /= 1024

        return f"{value:.1f} TiB"

    async def _log_quickjs_probe(self, root: Path, context: str) -> None:
        await self._log(
            "stderr",
            f"{icon} Probing {context} {root} for QuickJS artifacts",
        )
        libs = sorted(root.rglob("libquickjs.a"))
        headers = sorted(root.rglob("quickjs.h"))
        folders = [p for p in root.rglob("quickjs") if p.is_dir()]

        await self._log(
            "stderr",
            f"    - Found {len(libs)} libquickjs.a file(s), {len(headers)} quickjs.h file(s), and {len(folders)} quickjs directory matches",
        )

        async def _log_subset(paths: list[Path], label: str) -> None:
            if not paths:
                return
            preview = paths[:5]
            for candidate in preview:
                await self._log("stderr", f"      {label}: {candidate}")
            if len(paths) > len(preview):
                await self._log(
                    "stderr",
                    f"      … {len(paths) - len(preview)} additional {label} entries suppressed",
                )

        await _log_subset(libs, "lib")
        await _log_subset(headers, "header")
        await _log_subset(folders[:5], "dir")

    def _platform(self) -> str:
        if getattr(self.target, "platform", None):
            return str(self.target.platform)
        return PLATFORM_MAP.get(self.target.arch, "linux/amd64")

    def _docker_image(self) -> str:
        if getattr(self.target, "image", None):
            return str(self.target.image)
        distro = self.target.distro or "unknown"
        version = self.target.version or "latest"
        base, default_version = DISTRO_DEFAULTS.get(distro, ("debian", "bookworm"))
        safe_version = version if re.match(r"^[A-Za-z0-9_.-]+$", version) else default_version
        return f"{base}:{safe_version}"

    def _toolchain_image(self) -> str:
        base = self._sanitize(self._docker_image().replace("/", "_"))
        platform = self._sanitize(self._platform().replace("/", "_"))
        return f"frameos-cross-{base}-{platform}-v{TOOLCHAIN_IMAGE_VERSION}"

    async def _ensure_toolchain_image(self) -> str:
        image = self._toolchain_image()
        inspect_cmd = f"docker image inspect {shlex.quote(image)} >/dev/null 2>&1"
        status, _out, _err = await self._run_command(
            inspect_cmd,
            log_command=False,
            log_output=False,
        )
        if status == 0:
            return image

        dockerfile = str(CROSS_TOOLCHAIN_DOCKERFILE)
        if not os.path.exists(dockerfile):
            raise RuntimeError(
                "Cross toolchain Dockerfile is missing; expected at backend/tools/cross-toolchain.Dockerfile",
            )

        if self._build_host_session:
            if not self._remote_root:
                raise RuntimeError("Build host workspace missing for toolchain build")
            remote_dir = self._remote_root / "cross-toolchain"
            dockerfile_path = remote_dir / Path(dockerfile).name
            await self._build_host_session.ensure_dir(str(remote_dir))
            await self._build_host_session.write_file(
                str(dockerfile_path), Path(dockerfile).read_text()
            )
            context_dir = str(remote_dir)
            dockerfile_arg = str(dockerfile_path)
        else:
            context_dir = str(Path(dockerfile).parent)
            dockerfile_arg = dockerfile

        build_cmd = " ".join(
            [
                "docker buildx build --load",
                f"--platform {self._platform()}",
                f"--build-arg BASE_IMAGE={shlex.quote(self._docker_image())}",
                f"--build-arg TOOLCHAIN_PACKAGES={shlex.quote(TOOLCHAIN_PACKAGES)}",
                f"-t {shlex.quote(image)}",
                f"-f {shlex.quote(dockerfile_arg)}",
                shlex.quote(context_dir),
            ]
        )

        status, _stdout, err = await self._run_command(
            build_cmd,

            # log_command="docker buildx build (cross toolchain)",
        )
        if status != 0:
            raise RuntimeError(f"Failed to build cross toolchain image: {err or 'see logs'}")
        return image

    @staticmethod
    def _sanitize(value: str) -> str:
        value = value or "unknown"
        return SAFE_SEGMENT.sub("_", value)

    @staticmethod
    def _cache_root() -> Path:
        """Return the base cache directory for cross compilation artifacts.

        When running inside a container that shells out to the host Docker daemon
        (docker-in-docker via a mounted ``/var/run/docker.sock``), host paths must
        be mountable by the daemon. Honour ``FRAMEOS_CROSS_CACHE`` when provided;
        otherwise, prefer ``TMPDIR`` so operators can bind-mount a shared
        directory (e.g. ``/tmp/frameos-cross``). Fall back to the legacy location
        under ``~/.cache`` when no hints are available.
        """

        cache_root = os.environ.get(CACHE_ENV)
        if cache_root:
            return Path(cache_root)

        tmpdir = os.environ.get("TMPDIR")
        if tmpdir:
            return Path(tmpdir) / "frameos-cross-cache"

        return DEFAULT_CACHE


async def build_binary_with_cross_toolchain(
    *,
    db: Session | None,
    redis: Redis | None,
    frame: Frame,
    deployer: FrameDeployer,
    source_dir: str,
    temp_dir: str,
    build_dir: str | None = None,
    prebuilt_entry: PrebuiltEntry | None = None,
    prebuilt_target: str | None = None,
    target_override: TargetMetadata | None = None,
    logger: LogFunc | None = None,
    build_host: BuildHostConfig | None = None,
) -> str:
    result = await build_artifacts_with_cross_toolchain(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        source_dir=source_dir,
        temp_dir=temp_dir,
        build_dir=build_dir,
        prebuilt_entry=prebuilt_entry,
        prebuilt_target=prebuilt_target,
        target_override=target_override,
        logger=logger,
        build_host=build_host,
        build_binary=True,
        build_all_scenes=True,
    )
    if not result.binary_path:
        raise RuntimeError("Cross compilation completed without producing a frameos binary")
    return result.binary_path


async def build_artifacts_with_cross_toolchain(
    *,
    db: Session | None,
    redis: Redis | None,
    frame: Frame,
    deployer: FrameDeployer,
    source_dir: str,
    temp_dir: str,
    build_dir: str | None = None,
    prebuilt_entry: PrebuiltEntry | None = None,
    prebuilt_target: str | None = None,
    target_override: TargetMetadata | None = None,
    logger: LogFunc | None = None,
    build_host: BuildHostConfig | None = None,
    build_binary: bool = True,
    build_scene_ids: list[str] | tuple[str, ...] | None = None,
    build_scene_dirs: list[str] | None = None,
    build_driver_ids: list[str] | tuple[str, ...] | None = None,
    build_driver_dirs: list[str] | None = None,
    build_all_scenes: bool = True,
) -> CrossCompileArtifacts:
    arch: str | None
    distro: str | None
    version: str | None
    if target_override:
        arch = target_override.arch
        distro = target_override.distro
        version = target_override.version
    else:
        arch = await deployer.get_cpu_architecture()
        distro = await deployer.get_distro()
        version = await deployer.get_distro_version()
    target = TargetMetadata(arch=arch, distro=distro, version=version)
    resolved_target = prebuilt_target or resolve_prebuilt_target(distro, version, arch)
    if resolved_target and not prebuilt_entry:
        try:
            manifest = await fetch_prebuilt_manifest()
        except Exception as exc:  # pragma: no cover - network failure
            await _log_line(
                logger,
                db,
                redis,
                frame,
                "stderr",
                f"{icon} Failed to load prebuilt manifest for {resolved_target}: {exc}",
            )
        else:
            prebuilt_entry = manifest.get(resolved_target)
            if prebuilt_entry:
                await _log_line(
                    logger,
                    db,
                    redis,
                    frame,
                    "stdout",
                    f"{icon} Using prebuilt dependencies for {resolved_target}",
                )
            else:
                await _log_line(
                    logger,
                    db,
                    redis,
                    frame,
                    "stdout",
                    f"{icon} No prebuilt dependencies published for {resolved_target}",
                )
    elif not resolved_target:
        await _log_line(
            logger,
            db,
            redis,
            frame,
            "stdout",
            f"{icon} No matching prebuilt target for this distro/version/arch combination",
        )
    compiler = CrossCompiler(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        target=target,
        temp_dir=temp_dir,
        build_dir=build_dir,
        prebuilt_entry=prebuilt_entry,
        prebuilt_target=resolved_target,
        logger=logger,
        build_host=build_host,
    )
    return await compiler.build_artifacts(
        source_dir,
        build_binary=build_binary,
        build_scene_ids=build_scene_ids,
        build_scene_dirs=build_scene_dirs,
        build_driver_ids=build_driver_ids,
        build_driver_dirs=build_driver_dirs,
        build_all_scenes=build_all_scenes,
    )


async def _log_line(
    logger: LogFunc | None,
    db: Session | None,
    redis: Redis | None,
    frame: Frame,
    level: str,
    message: str,
) -> None:
    if logger:
        await logger(level, message)
    elif db and redis:
        await log(db, redis, int(frame.id), level, message)
    else:
        print(f"[{level}] {message}")
