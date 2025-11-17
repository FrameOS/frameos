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
from typing import Callable, Iterable

import asyncssh
import httpx

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.models.frame import Frame
from app.models.log import new_log as log
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.prebuilt_deps import (
    PrebuiltEntry,
    fetch_prebuilt_manifest,
    resolve_prebuilt_target,
)
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
PREBUILT_TIMEOUT = float(os.environ.get("FRAMEOS_PREBUILT_TIMEOUT", "20"))


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
        prebuilt_entry: PrebuiltEntry | None = None,
        prebuilt_target: str | None = None,
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
        self.prebuilt_entry = prebuilt_entry
        self.prebuilt_target = prebuilt_target
        self.prebuilt_dir = cache_root / "prebuilt" / key
        self.prebuilt_dir.mkdir(parents=True, exist_ok=True)
        self.prebuilt_components: dict[str, Path] = {}
        self.prebuilt_timeout = PREBUILT_TIMEOUT
        for rel in ("usr/include", "usr/local/include", "usr/lib", "usr/local/lib"):
            (self.sysroot_dir / rel).mkdir(parents=True, exist_ok=True)

    async def build(self, source_dir: str) -> str:
        await self._log(
            "stdout",
            f"- Cross compiling for {self.target.arch} on {self._docker_image()} via {self._platform()}",
        )
        await self._prepare_prebuilt_components()
        self._ensure_quickjs_sources(source_dir)
        build_dir = await self._generate_c_sources(source_dir)
        await self._prepare_sysroot()
        self._ensure_quickjs_in_build_dir(source_dir, build_dir)
        binary_path = await self._run_docker_build(str(build_dir))
        if not os.path.exists(binary_path):
            raise RuntimeError("Cross compilation completed but frameos binary is missing")
        return binary_path

    async def _prepare_sysroot(self) -> None:
        drivers = drivers_for_frame(self.frame)
        required = [spec for spec in REMOTE_REQUIREMENTS if spec.predicate(drivers)]
        if not required:
            await self._log("stdout", "- No device-specific libraries required from frame")
            return

        if self.prebuilt_components.get("lgpio"):
            await self._log("stdout", "- Using prebuilt lgpio headers and libraries")
            self._inject_prebuilt_lgpio()
            required = [
                spec
                for spec in required
                if not spec.name.startswith("lgpio")
            ]
            if not required:
                await self._log(
                    "stdout",
                    "- Remaining sysroot requirements satisfied by prebuilt components",
                )
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

    async def _run_docker_build(self, build_dir: str) -> str:
        build_dir = os.path.abspath(build_dir)
        script_path = self.temp_dir / "frameos-cross-build.sh"
        include_dirs = self._dedupe_preserve_order(
            self._existing_container_dirs(["/sysroot/usr/include", "/sysroot/usr/local/include"])
        )
        lib_dirs = self._dedupe_preserve_order(
            self._existing_container_dirs(["/sysroot/usr/lib", "/sysroot/usr/local/lib"])
        )
        extra_cflags = shlex.quote(" ".join(f"-I{path}" for path in include_dirs)) if include_dirs else "''"
        extra_libs = shlex.quote(" ".join(f"-L{path}" for path in lib_dirs)) if lib_dirs else "''"
        script_path.write_text(
            dedent(
                f"""
                #!/usr/bin/env bash
                set -euo pipefail

                log_debug() {{
                    printf '[frameos-cross] %s\n' "$*" >&2
                }}

                export DEBIAN_FRONTEND=noninteractive
                log_debug "Container uname: $(uname -a)"
                log_debug "Working directory before build: $(pwd)"
                apt-get update
                apt-get install -y --no-install-recommends build-essential ca-certificates curl git make pkg-config python3 python3-pip unzip xz-utils zlib1g-dev libssl-dev libffi-dev libjpeg-dev libfreetype6-dev

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
                log_debug "Compiling generated C sources"
                make -j"$(nproc)"
                log_debug "make completed"
                """
            ).strip()
            + "\n"
        )
        os.chmod(script_path, 0o755)

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"--platform {self._platform()}",
                f"-v {shlex.quote(build_dir)}:/src",
                f"-v {shlex.quote(str(self.sysroot_dir))}:/sysroot:ro",
                f"-v {shlex.quote(str(script_path))}:/tmp/build.sh:ro",
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
        return os.path.join(build_dir, "frameos")

    def _ensure_quickjs_sources(self, source_dir: str) -> None:
        quickjs_root = Path(source_dir) / "quickjs"
        libquickjs = quickjs_root / "libquickjs.a"
        if libquickjs.exists():
            return
        self._stage_quickjs(source_dir)
        if libquickjs.exists():
            return
        raise RuntimeError(
            "QuickJS sources are missing; run `nimble build_quickjs` or publish a prebuilt component.",
        )

    async def _generate_c_sources(self, source_dir: str) -> Path:
        build_dir = self.temp_dir / f"build_{self.deployer.build_id}"
        build_dir.mkdir(parents=True, exist_ok=True)
        await self.deployer.create_local_build_archive(
            str(build_dir),
            source_dir,
            self.target.arch,
        )
        return build_dir

    def _ensure_quickjs_in_build_dir(self, source_dir: str, build_dir: Path) -> None:
        dest = Path(build_dir) / "quickjs"
        libquickjs = dest / "libquickjs.a"
        if libquickjs.exists():
            return
        source_quickjs = Path(source_dir) / "quickjs"
        if source_quickjs.exists():
            shutil.copytree(source_quickjs, dest, dirs_exist_ok=True)
        else:
            self._stage_quickjs(str(build_dir))
        if not libquickjs.exists():
            raise RuntimeError(
                "QuickJS libraries missing from generated C sources; unable to continue cross compilation",
            )

    async def _prepare_prebuilt_components(self) -> None:
        if not self.prebuilt_entry:
            return

        if self.prebuilt_target:
            await self._log(
                "stdout",
                f"- Attempting to use prebuilt components for {self.prebuilt_target}",
            )

        for component in ("quickjs", "lgpio"):
            path = await self._ensure_prebuilt_component(component)
            if path:
                self.prebuilt_components[component] = path

    async def _ensure_prebuilt_component(self, component: str) -> Path | None:
        if not self.prebuilt_entry:
            return None
        url = self.prebuilt_entry.url_for(component)
        if not url:
            return None
        version = self.prebuilt_entry.version_for(component, "unknown") or "unknown"
        safe_version = self._sanitize(version)
        dest_dir = self.prebuilt_dir / f"{component}-{safe_version}"
        marker = dest_dir / ".build-info"
        expected_marker = f"{component}|{version}|{url}|{self.prebuilt_entry.md5_for(component) or ''}"
        if marker.exists() and marker.read_text() == expected_marker:
            return dest_dir

        await self._log("stdout", f"- Downloading prebuilt {component} ({version})")
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        try:
            await self._download_and_extract(url, dest_dir, self.prebuilt_entry.md5_for(component))
        except Exception as exc:
            await self._log(
                "stderr",
                f"- Failed to download prebuilt {component}: {exc}; falling back",
            )
            shutil.rmtree(dest_dir, ignore_errors=True)
            return None

        marker.write_text(expected_marker)
        return dest_dir

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
    def _file_md5sum(path: Path) -> str:
        hasher = hashlib.md5()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def _stage_quickjs(self, source_dir: str) -> None:
        quickjs_dir = self.prebuilt_components.get("quickjs")
        if not quickjs_dir:
            return
        dest = Path(source_dir) / "quickjs"
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True, exist_ok=True)
        include_src = quickjs_dir / "include" / "quickjs"
        if include_src.exists():
            shutil.copytree(include_src, dest / "include" / "quickjs", dirs_exist_ok=True)
        for header in ("quickjs.h", "quickjs-libc.h"):
            for candidate in (
                include_src / header,
                quickjs_dir / header,
            ):
                if candidate.exists():
                    shutil.copy2(candidate, dest / header)
                    break
        lib_candidates = [
            quickjs_dir / "lib" / "libquickjs.a",
            quickjs_dir / "libquickjs.a",
        ]
        for candidate in lib_candidates:
            if candidate.exists():
                shutil.copy2(candidate, dest / "libquickjs.a")
                break

    def _inject_prebuilt_lgpio(self) -> None:
        lgpio_dir = self.prebuilt_components.get("lgpio")
        if not lgpio_dir:
            return
        include_src = lgpio_dir / "include"
        lib_src = lgpio_dir / "lib"
        if include_src.exists():
            shutil.copytree(include_src, self.sysroot_dir / "usr/local/include", dirs_exist_ok=True)
        if lib_src.exists():
            shutil.copytree(lib_src, self.sysroot_dir / "usr/local/lib", dirs_exist_ok=True)

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
    prebuilt_entry: PrebuiltEntry | None = None
    prebuilt_target = resolve_prebuilt_target(distro, version, arch)
    if prebuilt_target:
        try:
            manifest = await fetch_prebuilt_manifest()
        except Exception as exc:  # pragma: no cover - network failure
            await log(
                db,
                redis,
                int(frame.id),
                "stderr",
                f"- Failed to load prebuilt manifest for {prebuilt_target}: {exc}",
            )
        else:
            prebuilt_entry = manifest.get(prebuilt_target)
            if prebuilt_entry:
                await log(
                    db,
                    redis,
                    int(frame.id),
                    "stdout",
                    f"- Using prebuilt dependencies for {prebuilt_target}",
                )
            else:
                await log(
                    db,
                    redis,
                    int(frame.id),
                    "stdout",
                    f"- No prebuilt dependencies published for {prebuilt_target}",
                )
    else:
        await log(
            db,
            redis,
            int(frame.id),
            "stdout",
            "- No matching prebuilt target for this distro/version/arch combination",
        )
    compiler = CrossCompiler(
        db=db,
        redis=redis,
        frame=frame,
        deployer=deployer,
        target=target,
        temp_dir=temp_dir,
        prebuilt_entry=prebuilt_entry,
        prebuilt_target=prebuilt_target,
    )
    return await compiler.build(source_dir)

