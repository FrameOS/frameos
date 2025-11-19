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
class RemotePathSpec:
    name: str
    patterns: list[str]
    parent_depth: int


@dataclass(slots=True)
class RemoteComponent:
    name: str
    predicate: Callable[[dict[str, object]], bool]
    paths: tuple[RemotePathSpec, ...]


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


REMOTE_COMPONENTS: tuple[RemoteComponent, ...] = (
    RemoteComponent(
        name="lgpio",
        predicate=lambda _drivers: True,
        paths=(
            RemotePathSpec(
                name="lgpio-libs",
                patterns=[
                    "/usr/lib/**/liblgpio.so",
                    "/usr/lib/**/liblgpio.so.*",
                    "/usr/local/lib/**/liblgpio.so*",
                ],
                parent_depth=1,
            ),
            RemotePathSpec(
                name="lgpio-includes",
                patterns=[
                    "/usr/include/**/lgpio.h",
                    "/usr/local/include/**/lgpio.h",
                ],
                parent_depth=0,
            ),
        ),
    ),
)


PLATFORM_MAP = {
    "aarch64": "linux/arm64",
    "arm64": "linux/arm64",
    "armv8": "linux/arm64",
    "armv7l": "linux/arm/v7",
    "armv7": "linux/arm/v7",
    "armhf": "linux/arm/v7",
    "armv6l": "linux/arm/v6",
}

def can_cross_compile_target(arch: str | None) -> bool:
    """Return ``True`` when *arch* has a known Docker platform mapping."""

    return (arch or "").lower() in PLATFORM_MAP


DISTRO_DEFAULTS = {
    "raspios": ("debian", "bookworm"),
    "debian": ("debian", "bookworm"),
    "ubuntu": ("ubuntu", "22.04"),
}


LogFunc = Callable[[str, str], Awaitable[None]]


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
        logger: LogFunc | None = None,
        enable_remote_sysroot: bool = True,
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
        self.logger = logger
        self.enable_remote_sysroot = enable_remote_sysroot
        self._sysroot_include_dirs: set[str] = set()
        self._sysroot_lib_dirs: set[str] = set()
        for rel in ("usr/include", "usr/local/include", "usr/lib", "usr/local/lib"):
            (self.sysroot_dir / rel).mkdir(parents=True, exist_ok=True)

    async def build(self, source_dir: str) -> str:
        await self._log(
            "stdout",
            f"- Cross compiling for {self.target.arch} on {self._docker_image()} via {self._platform()}",
        )
        await self._prepare_prebuilt_components()
        await self._ensure_quickjs_sources(source_dir)
        build_dir = await self._generate_c_sources(source_dir)
        await self._prepare_sysroot()
        await self._ensure_quickjs_in_build_dir(source_dir, build_dir)
        binary_path = await self._run_docker_build(str(build_dir))
        if not os.path.exists(binary_path):
            raise RuntimeError("Cross compilation completed but frameos binary is missing")
        return binary_path

    async def _prepare_sysroot(self) -> None:
        if not self.enable_remote_sysroot:
            await self._log(
                "stdout",
                "- Remote sysroot synchronization disabled; using default include/lib paths",
            )
            return

        drivers = drivers_for_frame(self.frame)
        components = [
            component for component in REMOTE_COMPONENTS if component.predicate(drivers)
        ]

        remote_specs: list[RemotePathSpec] = []
        used_prebuilt = False
        for component in components:
            if component.name in self.prebuilt_components:
                used_prebuilt = True
                await self._log(
                    "stdout",
                    f"- Using prebuilt {component.name} headers and libraries",
                )
                self._inject_prebuilt_component(component.name)
                continue
            remote_specs.extend(component.paths)

        if not remote_specs:
            if used_prebuilt:
                await self._log(
                    "stdout",
                    "- Remaining sysroot requirements satisfied by prebuilt components",
                )
            else:
                await self._log(
                    "stdout",
                    "- No device-specific libraries required from frame",
                )
            return

        remote_paths: list[str] = []
        for spec in remote_specs:
            match = await self._remote_first_match(spec.patterns)
            if not match:
                await self._log("stderr", f"- Unable to locate {spec.name} on frame; continuing")
                continue
            target_path = self._apply_parent(match, spec.parent_depth)
            if target_path:
                remote_paths.append(target_path)

        unique_paths = list(dict.fromkeys(remote_paths))
        for path in unique_paths:
            self._register_sysroot_dir(path)
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
                "- Enabling CPU feature flags for cross-compile: "
                + " ".join(feature_flags),
            )
        include_flags = [f"-I{path}" for path in include_dirs]
        extra_cflags_parts = [*feature_flags, *include_flags]
        extra_cflags = (
            shlex.quote(" ".join(extra_cflags_parts)) if extra_cflags_parts else "''"
        )
        extra_libs = shlex.quote(" ".join(f"-L{path}" for path in lib_dirs)) if lib_dirs else "''"
        script_path.write_text(
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
                log_debug "Compiling generated C sources"
                make -j"$(nproc)"
                log_debug "make completed"
                """
            ).strip()
            + "\n"
        )
        os.chmod(script_path, 0o755)

        image = await self._ensure_toolchain_image()

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"--platform {self._platform()}",
                f"-v {shlex.quote(build_dir)}:/src",
                f"-v {shlex.quote(str(self.sysroot_dir))}:/sysroot:ro",
                f"-v {shlex.quote(str(script_path))}:/tmp/build.sh:ro",
                "-w /src",
                shlex.quote(image),
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

    def _cpu_feature_cflags(self) -> list[str]:
        arch = (self.target.arch or "").lower()
        flags = list(DEFAULT_FEATURE_CFLAGS.get(arch, []))
        override = os.environ.get(FEATURE_FLAG_ENV)
        if override:
            flags.extend(arg for arg in shlex.split(override) if arg)
        return flags

    async def _ensure_quickjs_sources(self, source_dir: str) -> None:
        quickjs_root = Path(source_dir) / "quickjs"
        libquickjs = quickjs_root / "libquickjs.a"
        await self._log(
            "stdout",
            f"- Ensuring QuickJS sources are available at {quickjs_root} (exists={quickjs_root.exists()})",
        )
        prebuilt_path = self.prebuilt_components.get("quickjs")
        if prebuilt_path:
            await self._log(
                "stdout",
                f"  • Prebuilt QuickJS component detected at {prebuilt_path}; staging into source tree",
            )
            self._stage_quickjs(source_dir)
        if libquickjs.exists():
            await self._log("stdout", f"  • Found QuickJS archive at {libquickjs}")
            return
        await self._log("stderr", "  • QuickJS archive missing after initial stage; retrying")
        self._stage_quickjs(source_dir)
        if libquickjs.exists():
            await self._log("stdout", f"  • QuickJS archive found after restage at {libquickjs}")
            return
        await self._log_quickjs_probe(Path(source_dir), "source directory")
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

    async def _ensure_quickjs_in_build_dir(self, source_dir: str, build_dir: Path) -> None:
        dest = Path(build_dir) / "quickjs"
        libquickjs = dest / "libquickjs.a"
        await self._log(
            "stdout",
            f"- Ensuring QuickJS assets exist within build dir {dest} (exists={dest.exists()})",
        )
        if self.prebuilt_components.get("quickjs"):
            await self._log(
                "stdout",
                "  • Staging prebuilt QuickJS component directly into build directory",
            )
            self._stage_quickjs(str(build_dir))
        if libquickjs.exists():
            await self._log("stdout", f"  • Build directory already contains {libquickjs}")
            return
        source_quickjs = Path(source_dir) / "quickjs"
        if source_quickjs.exists():
            await self._log(
                "stdout",
                f"  • Copying QuickJS tree from source directory ({source_quickjs}) into build directory",
            )
            shutil.copytree(source_quickjs, dest, dirs_exist_ok=True)
        else:
            await self._log(
                "stderr",
                f"  • Source directory missing QuickJS folder at {source_quickjs}; attempting to restage",
            )
            self._stage_quickjs(str(build_dir))
        if not libquickjs.exists():
            await self._log_quickjs_probe(Path(build_dir), "build directory")
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
            self._normalize_component_dir(dest_dir)
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

    def _stage_quickjs(self, source_dir: str) -> None:
        quickjs_dir = self.prebuilt_components.get("quickjs")
        if not quickjs_dir:
            return
        dest = Path(source_dir) / "quickjs"
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
        if direct.exists():
            return direct
        candidates = sorted(
            path
            for path in root.rglob("quickjs")
            if path.is_dir() and (path / "quickjs.h").exists()
        )
        return candidates[0] if candidates else None

    @staticmethod
    def _first_file_match(root: Path, pattern: str) -> Path | None:
        matches = sorted(root.rglob(pattern))
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
        if self.logger:
            await self.logger(level, message)
            return
        await log(self.db, self.redis, int(self.frame.id), level, message)

    def _apply_parent(self, path: str, depth: int) -> str:
        target = Path(path)
        for _ in range(depth):
            target = target.parent
        return str(target)

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

    async def _log_quickjs_probe(self, root: Path, context: str) -> None:
        await self._log(
            "stderr",
            f"  • Probing {context} {root} for QuickJS artifacts",
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
        return PLATFORM_MAP.get(self.target.arch, "linux/amd64")

    def _docker_image(self) -> str:
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
        status, _out, _err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
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
        context_dir = str(Path(dockerfile).parent)
        build_cmd = " ".join(
            [
                "docker buildx build --load",
                f"--platform {self._platform()}",
                f"--build-arg BASE_IMAGE={shlex.quote(self._docker_image())}",
                f"--build-arg TOOLCHAIN_PACKAGES={shlex.quote(TOOLCHAIN_PACKAGES)}",
                f"-t {shlex.quote(image)}",
                f"-f {shlex.quote(dockerfile)}",
                shlex.quote(context_dir),
            ]
        )

        status, _stdout, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            build_cmd,
            log_command="docker buildx build (cross toolchain)",
        )
        if status != 0:
            raise RuntimeError(f"Failed to build cross toolchain image: {err or 'see logs'}")
        return image

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

