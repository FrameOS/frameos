from __future__ import annotations

import json
import hashlib
import os
import re
import shlex
import shutil
import tarfile
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from textwrap import dedent, indent
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
from app.utils.build_host import BuildHostConfig
from app.utils.build_executor import (
    BuildExecutor,
    DockerMount,
    build_executor_display_name,
    create_build_executor,
)
from app.utils.cross_toolchain_packages import (
    TARGET_CROSS_TOOLCHAIN_DPKG_ARCHS,
    TARGET_CROSS_TOOLCHAIN_PACKAGES,
    TARGET_CROSS_TOOLCHAINS,
    TargetCrossToolchain,
)
from app.utils.modal_sandbox import ModalSandboxConfig

icon = "🔶"


@dataclass(slots=True)
class TargetMetadata:
    arch: str
    distro: str
    version: str
    platform: str | None = None
    image: str | None = None


SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_.-]+")
CACHE_ENV = "FRAMEOS_CROSS_CACHE"
DEFAULT_CACHE = Path.home() / ".cache/frameos/cross"
PREBUILT_TIMEOUT = float(os.environ.get("FRAMEOS_PREBUILT_TIMEOUT", "20"))
FEATURE_FLAG_ENV = "FRAMEOS_CROSS_FEATURE_CFLAGS"
DEFAULT_FEATURE_CFLAGS = {
    "amd64": ["-mavx2", "-mavx", "-msse4.1", "-mssse3", "-mpclmul", "-mvpclmulqdq"],
    "x86_64": ["-mavx2", "-mavx", "-msse4.1", "-mssse3", "-mpclmul", "-mvpclmulqdq"],
}
CROSS_TOOLCHAIN_IMAGE = os.environ.get("FRAMEOS_CROSS_TOOLCHAIN_IMAGE")
TOOLCHAIN_IMAGE_REPO = os.environ.get(
    "FRAMEOS_CROSS_TOOLCHAIN_IMAGE_REPO",
    "frameos/frameos-cross-toolchain",
)
TOOLCHAIN_IMAGE_TAG = os.environ.get("FRAMEOS_CROSS_TOOLCHAIN_IMAGE_TAG", "latest")
TOOLCHAIN_FORCE_LOCAL_BUILD = os.environ.get(
    "FRAMEOS_CROSS_TOOLCHAIN_FORCE_LOCAL_BUILD",
    "0",
).lower() in {"1", "true", "yes", "on"}
TOOLCHAIN_SKIP_PULL = os.environ.get(
    "FRAMEOS_CROSS_TOOLCHAIN_SKIP_PULL",
    "0",
).lower() in {"1", "true", "yes", "on"}
BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent
CROSS_TOOLCHAIN_DIGESTS_PATH = os.environ.get(
    "FRAMEOS_CROSS_TOOLCHAIN_DIGESTS_PATH",
    str(REPO_ROOT / "cross-toolchain-images.json"),
)
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
def can_cross_compile_target(arch: str | None) -> bool:
    """Return ``True`` when *arch* has a known Docker platform mapping."""

    return (arch or "").lower() in PLATFORM_MAP


def cross_cache_root() -> Path:
    cache_root = os.environ.get(CACHE_ENV)
    if cache_root:
        return Path(cache_root)

    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        return Path(tmpdir) / "frameos-cross-cache"

    return DEFAULT_CACHE


def cross_cache_key(target: TargetMetadata) -> str:
    return "-".join(SAFE_SEGMENT.sub("_", part or "unknown") for part in (target.distro, target.version, target.arch))


@lru_cache(maxsize=1)
def _toolchain_digest_map() -> dict[str, str]:
    path = Path(CROSS_TOOLCHAIN_DIGESTS_PATH)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    raw_images = payload.get("images") if isinstance(payload, dict) else None
    if not isinstance(raw_images, dict):
        return {}

    digests: dict[str, str] = {}
    for image_name, image_data in raw_images.items():
        if not isinstance(image_name, str) or not isinstance(image_data, dict):
            continue
        digest = image_data.get("digest")
        if isinstance(digest, str) and digest:
            digests[image_name] = digest
    return digests


DISTRO_DEFAULTS = {
    "raspios": ("debian", "bookworm"),
    "debian": ("debian", "bookworm"),
    "ubuntu": ("ubuntu", "26.04"),
    "buildroot": ("ubuntu", "22.04"),
}
DEBIAN_DOCKER_RELEASES = {"buster", "bullseye", "bookworm", "trixie"}
UBUNTU_DOCKER_RELEASES = {
    "22.04": "22.04",
    "jammy": "22.04",
    "24.04": "24.04",
    "noble": "24.04",
    "26.04": "26.04",
    "resolute": "26.04",
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
        build_host: BuildHostConfig | ModalSandboxConfig | None = None,
        output_name: str = "frameos",
        compile_script_name: str = "compile_frameos.sh",
        needs_quickjs: bool = True,
        compilation_mode: str | None = None,
    ) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame
        self.deployer = deployer
        self.target = target
        self.temp_dir = Path(temp_dir)
        cache_root = cross_cache_root()
        cache_root.mkdir(parents=True, exist_ok=True)
        key = cross_cache_key(target)
        self.toolchain_dir = cache_root / key
        self.toolchain_dir.mkdir(parents=True, exist_ok=True)
        self.sysroot_dir = self.toolchain_dir / "sysroot"
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
        self.executor: BuildExecutor | None = None
        self.output_name = output_name
        self.compile_script_name = compile_script_name
        self.needs_quickjs = needs_quickjs
        self.compilation_mode = compilation_mode
        self._sysroot_include_dirs: set[str] = set()
        self._sysroot_lib_dirs: set[str] = set()
        for rel in ("usr/include", "usr/local/include", "usr/lib", "usr/local/lib"):
            (self.sysroot_dir / rel).mkdir(parents=True, exist_ok=True)

    async def build(self, source_dir: str) -> str:
        executor = create_build_executor(
            self.build_host,
            db=self.db,
            redis=self.redis,
            frame=self.frame,
            logger=self._log,
            workspace_prefix="frameos-cross-",
        )
        if self.build_host:
            connection_action = (
                f"Connecting to {build_executor_display_name(self.build_host)}"
                if executor.connects_on_enter
                else f"Using {build_executor_display_name(self.build_host)}; sandbox will be created when the build command starts"
            )
            await self._log(
                "stdout",
                f"{icon} {connection_action}",
            )
        async with executor:
            self.executor = executor
            if self.build_host and executor.connects_on_enter:
                await self._log(
                    "stdout",
                    f"Connected to {build_executor_display_name(self.build_host)} for cross compilation",
                )
            try:
                return await self._build_with_context(source_dir)
            finally:
                self.executor = None

    async def _build_with_context(self, source_dir: str) -> str:
        await self._log(
            "stdout",
            f"{icon} Cross compiling for {self.target.arch} on {self._docker_image()} via {self._platform()}",
        )
        await self._prepare_prebuilt_components()
        if self.needs_quickjs:
            await self._ensure_quickjs_sources(source_dir)
        build_dir = self.build_dir_override
        if build_dir:
            build_dir = Path(build_dir)
            if self.compile_script_name and not (build_dir / self.compile_script_name).exists():
                if self.output_name != "frameos":
                    raise RuntimeError(
                        f"Provided build directory {build_dir} is missing {self.compile_script_name}"
                    )
                await self._log(
                    "stderr",
                    f"{icon} Provided build directory {build_dir} is missing generated sources; regenerating",
                )
                build_dir = await self._generate_c_sources(source_dir)
        else:
            if self.output_name != "frameos":
                raise RuntimeError("A generated build directory is required for non-FrameOS cross compilation")
            build_dir = await self._generate_c_sources(source_dir)
        await self._prepare_sysroot()
        if self.needs_quickjs:
            await self._ensure_quickjs_in_build_dir(source_dir, build_dir)
        binary_path = await self._run_docker_build(str(build_dir))
        if not os.path.exists(binary_path):
            raise RuntimeError(f"Cross compilation completed but {self.output_name} binary is missing")
        return binary_path

    async def _prepare_sysroot(self) -> None:
        return

    async def _run_docker_build(self, build_dir: str) -> str:
        build_dir = os.path.abspath(build_dir)
        script_path = self.temp_dir / "frameos-cross-build.sh"
        target_platform = self._platform()
        container_platform = self._container_platform()
        target_cross_toolchain = self._target_cross_toolchain(container_platform)
        if container_platform != target_platform and target_cross_toolchain is None:
            raise RuntimeError(
                f"No target cross compiler bootstrap is configured for {target_platform} on {container_platform}"
            )
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
        if target_cross_toolchain:
            await self._log(
                "stdout",
                f"{icon} Using {container_platform} toolchain image with "
                f"{target_cross_toolchain.triplet} compiler for {target_platform}",
            )
            include_dirs = self._dedupe_preserve_order(
                [f"/usr/include/{target_cross_toolchain.triplet}", *include_dirs]
            )
            lib_dirs = self._dedupe_preserve_order(
                [f"/usr/lib/{target_cross_toolchain.triplet}", *lib_dirs]
            )
        include_flags = [f"-I{path}" for path in include_dirs]
        extra_cflags_parts = [*feature_flags, *include_flags]
        extra_cflags = (
            shlex.quote(" ".join(extra_cflags_parts)) if extra_cflags_parts else "''"
        )
        extra_libs = shlex.quote(" ".join(f"-L{path}" for path in lib_dirs)) if lib_dirs else "''"
        target_toolchain_script = indent(
            self._target_cross_toolchain_setup_script(target_cross_toolchain),
            " " * 16,
        )
        prepare_quickjs_script = indent(self._prepare_quickjs_archive_script(), " " * 16)
        make_jobs = (os.environ.get("FRAMEOS_CROSS_MAKE_JOBS") or "").strip()
        make_jobs_assignment = (
            f"make_jobs={shlex.quote(make_jobs)}"
            if make_jobs
            else 'make_jobs="$(nproc)"'
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

                {target_toolchain_script}

                extra_cflags={extra_cflags}
                extra_libs={extra_libs}
                {make_jobs_assignment}
                if [ -n "$extra_cflags" ]; then
                    log_debug "Using extra CFLAGS: $extra_cflags"
                    export EXTRA_CFLAGS="$extra_cflags"
                fi
                if [ -n "$extra_libs" ]; then
                    log_debug "Using extra LIBS: $extra_libs"
                    export EXTRA_LIBS="$extra_libs"
                fi

                cd /src
                {prepare_quickjs_script}
                log_debug "Compiling generated C sources"
                log_debug "Using make jobs: $make_jobs"
                make -j"$make_jobs"
                log_debug "build completed"
                """
            ).strip()
            + "\n"
        )

        image = await self._ensure_toolchain_image()

        script_path.write_text(script_content)
        os.chmod(script_path, 0o755)
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during cross compilation")

        status, _, err = await self.executor.docker_run(
            image=image,
            platform=container_platform,
            mounts=[
                DockerMount(Path(build_dir), "/src"),
                DockerMount(self.sysroot_dir, "/sysroot", read_only=True),
                DockerMount(script_path, "/tmp/frameos-cross/build.sh", read_only=True),
            ],
            workdir="/src",
            args=["bash", "/tmp/frameos-cross/build.sh"],
            workspace="cross-compile",
            log_command="docker run (cross compile)",
        )
        if status != 0:
            raise RuntimeError(f"Cross compilation failed: {err or 'see logs'}")
        return os.path.join(build_dir, self.output_name)

    async def _run_command(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
    ) -> tuple[int, str | None, str | None]:
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during cross compilation")
        return await self.executor.run(
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
        await self._ensure_quickjs_tree(
            quickjs_root,
            context="source directory",
            fallback_src=None,
            error_message=(
                "QuickJS sources are missing; run `nimble build_quickjs` "
                "or publish a prebuilt component."
            ),
        )

    async def _generate_c_sources(self, source_dir: str) -> Path:
        build_dir = self.temp_dir / f"build_{self.deployer.build_id}"
        build_dir.mkdir(parents=True, exist_ok=True)
        # compilation_mode must match the mode the source tree was modified
        # for; falling back to the default here silently skips e.g. the
        # waveshare C support files of a static build.
        await self.deployer.create_local_build_archive(
            str(build_dir),
            source_dir,
            self.target.arch,
            compilation_mode=self.compilation_mode,
        )
        return build_dir

    async def _ensure_quickjs_in_build_dir(self, source_dir: str, build_dir: Path) -> None:
        dest = Path(build_dir) / "quickjs"
        source_quickjs = Path(source_dir) / "quickjs"
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
        libquickjs = dest / "libquickjs.a"
        prebuilt_quickjs = self.prebuilt_components.get("quickjs")
        try:
            if prebuilt_quickjs:
                self._stage_prebuilt_quickjs(dest)

            if not libquickjs.exists() and fallback_src:
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(fallback_src, dest, dirs_exist_ok=True)
        except Exception as exc:
            await self._log(
                "stderr",
                f"{icon} Failed to prepare QuickJS artifacts for {context}: {exc}",
            )
            await self._log_quickjs_probe(
                dest.parent,
                context,
                expected=libquickjs,
                prebuilt=prebuilt_quickjs,
                fallback=fallback_src,
            )
            raise

        if libquickjs.exists():
            return

        await self._log(
            "stderr",
            f"{icon} QuickJS artifacts missing for {context}: expected {libquickjs}",
        )
        await self._log_quickjs_probe(
            dest.parent,
            context,
            expected=libquickjs,
            prebuilt=prebuilt_quickjs,
            fallback=fallback_src,
        )
        raise RuntimeError(error_message)

    async def _prepare_prebuilt_components(self) -> None:
        if not self.prebuilt_entry:
            return

        if self.prebuilt_target:
            await self._log(
                "stdout",
                f"{icon} Attempting to use prebuilt components for {self.prebuilt_target}",
            )

        components: list[str] = []
        if self.needs_quickjs:
            components.append("quickjs")

        for component in components:
            path = await self._ensure_prebuilt_component(component)
            if path:
                self.prebuilt_components[component] = path

    def _prepare_quickjs_archive_script(self) -> str:
        return dedent(
            """
            if [ -d quickjs ]; then
                if [ -f quickjs/Makefile ]; then
                    make -C quickjs clean >/dev/null
                    make -C quickjs libquickjs.a
                fi
                if [ -f quickjs/libquickjs.a ]; then
                    ranlib quickjs/libquickjs.a
                fi
            fi
            """
        ).strip()

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
            if self._prebuilt_component_is_valid(component, dest_dir):
                return dest_dir
            await self._log(
                "stderr",
                f"{icon} Cached prebuilt {component} at {dest_dir} is incomplete; refreshing",
            )
            shutil.rmtree(dest_dir, ignore_errors=True)

        await self._log("stdout", f"{icon} Downloading prebuilt {component} ({version})")
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        try:
            await self._download_and_extract(url, dest_dir, self.prebuilt_entry.md5_for(component))
            self._normalize_component_dir(dest_dir)
            if not self._prebuilt_component_is_valid(component, dest_dir):
                raise RuntimeError(
                    f"downloaded prebuilt {component} is missing required files after extraction"
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

    def _prebuilt_component_is_valid(self, component: str, root: Path) -> bool:
        validators = {
            "quickjs": self._quickjs_component_is_valid,
        }
        validator = validators.get(component)
        if not validator:
            return True
        return validator(root)

    def _quickjs_component_is_valid(self, root: Path) -> bool:
        return all(
            (
                self._first_file_match(root, "quickjs.h"),
                self._first_file_match(root, "quickjs-libc.h"),
                self._first_file_match(root, "libquickjs.a"),
            )
        )

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

    async def _log_quickjs_probe(
        self,
        root: Path,
        context: str,
        *,
        expected: Path | None = None,
        prebuilt: Path | None = None,
        fallback: Path | None = None,
    ) -> None:
        await self._log(
            "stderr",
            f"{icon} Probing {context} {root} for QuickJS artifacts",
        )
        if expected:
            await self._log("stderr", f"    - Expected archive: {expected}")
        if prebuilt:
            await self._log("stderr", f"    - Prebuilt source: {prebuilt}")
        if fallback:
            await self._log("stderr", f"    - Fallback source: {fallback}")
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

    def _container_platform(self) -> str:
        platform = self._platform()
        if self.executor is None:
            return platform
        platform_for_target = getattr(self.executor, "container_platform_for_target", None)
        if platform_for_target is None:
            return platform
        return platform_for_target(platform) or platform

    def _target_cross_toolchain(self, container_platform: str | None = None) -> TargetCrossToolchain | None:
        target_platform = self._platform()
        if (container_platform or target_platform) == target_platform:
            return None
        return TARGET_CROSS_TOOLCHAINS.get(target_platform)

    def _target_cross_toolchain_setup_script(self, toolchain: TargetCrossToolchain | None) -> str:
        if toolchain is None:
            return ""
        package_list = " ".join(shlex.quote(package) for package in toolchain.packages)
        pkg_config_libdir = (
            f"/usr/lib/{toolchain.triplet}/pkgconfig:"
            f"/usr/share/pkgconfig"
        )
        return dedent(
            f"""
            if ! command -v {shlex.quote(toolchain.cc)} >/dev/null 2>&1 || ! test -e /usr/lib/{shlex.quote(toolchain.triplet)}/libssl.so; then
                log_debug "Installing {toolchain.triplet} cross compiler and target libraries"
                if ! command -v apt-get >/dev/null 2>&1; then
                    log_debug "apt-get is required to install target cross compiler packages"
                    exit 1
                fi
                export DEBIAN_FRONTEND=noninteractive
                if command -v dpkg >/dev/null 2>&1 && ! dpkg --print-foreign-architectures | grep -qx {shlex.quote(toolchain.dpkg_arch)}; then
                    dpkg --add-architecture {shlex.quote(toolchain.dpkg_arch)}
                fi
                apt-get update
                apt-get install -y --no-install-recommends {package_list}
                rm -rf /var/lib/apt/lists/*
            fi
            export CC={shlex.quote(toolchain.cc)}
            export PKG_CONFIG_LIBDIR={shlex.quote(pkg_config_libdir)}
            log_debug "Using target compiler: $CC"
            """
        ).strip()

    def _target_cross_toolchain_build_args(self, container_platform: str) -> tuple[str, str]:
        if container_platform != "linux/amd64":
            return "", ""
        return " ".join(TARGET_CROSS_TOOLCHAIN_DPKG_ARCHS), " ".join(TARGET_CROSS_TOOLCHAIN_PACKAGES)

    def _docker_image(self) -> str:
        if getattr(self.target, "image", None):
            return str(self.target.image)
        distro = self.target.distro or "unknown"
        base, default_version = DISTRO_DEFAULTS.get(distro, ("debian", "bookworm"))

        version = (self.target.version or "").lower().strip()
        if not re.match(r"^[A-Za-z0-9_.-]+$", version):
            safe_version = default_version
        elif distro == "buildroot":
            safe_version = default_version
        elif base == "debian":
            safe_version = version if version in DEBIAN_DOCKER_RELEASES else default_version
        elif base == "ubuntu":
            safe_version = UBUNTU_DOCKER_RELEASES.get(version, default_version)
        else:
            safe_version = version or default_version
        return f"{base}:{safe_version}"

    def _toolchain_image(self, platform_override: str | None = None) -> str:
        base = self._sanitize(self._docker_image().replace("/", "_"))
        platform = self._sanitize((platform_override or self._platform()).replace("/", "_"))
        slug = f"{base}-{platform}"
        if CROSS_TOOLCHAIN_IMAGE:
            try:
                return CROSS_TOOLCHAIN_IMAGE.format(
                    slug=slug,
                    base=base,
                    platform=platform,
                    tag=TOOLCHAIN_IMAGE_TAG,
                )
            except (KeyError, ValueError):
                return CROSS_TOOLCHAIN_IMAGE
        tag = f"{slug}-{TOOLCHAIN_IMAGE_TAG}" if TOOLCHAIN_IMAGE_TAG else slug
        return f"{TOOLCHAIN_IMAGE_REPO}:{tag}"

    def _resolved_toolchain_image(self, platform_override: str | None = None) -> str:
        image = self._toolchain_image(platform_override)
        if CROSS_TOOLCHAIN_IMAGE:
            return image
        digest = _toolchain_digest_map().get(image)
        if digest:
            return f"{image}@{digest}"
        return image

    def _legacy_toolchain_image(self, platform_override: str | None = None) -> str:
        base = self._sanitize(self._docker_image().replace("/", "_"))
        platform = self._sanitize((platform_override or self._platform()).replace("/", "_"))
        return f"frameos-cross-{base}-{platform}-v1"

    async def _ensure_toolchain_image(self) -> str:
        container_platform = self._container_platform()
        image = self._toolchain_image(container_platform)
        resolved_image = self._resolved_toolchain_image(container_platform)
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during cross compilation")
        if self.executor.uses_container_images_directly:
            return self.executor.container_image_reference(image, resolved_image)
        if not TOOLCHAIN_FORCE_LOCAL_BUILD:
            status, _out, _err = await self._run_command(
                f"docker image inspect {shlex.quote(resolved_image)} >/dev/null 2>&1",
                log_command=False,
                log_output=False,
            )
            if status == 0:
                return resolved_image

            if resolved_image != image:
                status, _out, _err = await self._run_command(
                    f"docker image inspect {shlex.quote(image)} >/dev/null 2>&1",
                    log_command=False,
                    log_output=False,
                )
                if status == 0:
                    return image

            legacy_image = self._legacy_toolchain_image(container_platform)
            status, _out, _err = await self._run_command(
                f"docker image inspect {shlex.quote(legacy_image)} >/dev/null 2>&1",
                log_command=False,
                log_output=False,
            )
            if status == 0:
                return legacy_image

            if not TOOLCHAIN_SKIP_PULL:
                pull_cmd = f"docker pull {shlex.quote(resolved_image)}"
                status, _pull_out, pull_err = await self._run_command(
                    pull_cmd,
                    log_command=f"docker pull {shlex.quote(resolved_image)}",
                    log_output=False,
                )
                if status == 0:
                    return resolved_image

                if resolved_image != image and not TOOLCHAIN_SKIP_PULL:
                    status, _pull_out, pull_err = await self._run_command(
                        f"docker pull {shlex.quote(image)}",
                        log_command=f"docker pull {shlex.quote(image)}",
                        log_output=False,
                    )
                    if status == 0:
                        return image

                await self._log(
                    "stderr",
                    f"{icon} Falling back to local toolchain build after pull failed for {resolved_image}: {pull_err or 'unknown error'}",
                )

        dockerfile = str(CROSS_TOOLCHAIN_DOCKERFILE)
        if not os.path.exists(dockerfile):
            raise RuntimeError(
                "Cross toolchain Dockerfile is missing; expected at backend/tools/cross-toolchain.Dockerfile",
            )

        context_dir, dockerfile_arg = await self.executor.prepare_docker_build_context(
            Path(dockerfile),
            "cross-toolchain",
        )
        target_cross_dpkg_archs, target_cross_packages = self._target_cross_toolchain_build_args(container_platform)

        build_cmd = " ".join(
            [
                "docker buildx build --load",
                f"--platform {container_platform}",
                f"--build-arg BASE_IMAGE={shlex.quote(self._docker_image())}",
                f"--build-arg TOOLCHAIN_PACKAGES={shlex.quote(TOOLCHAIN_PACKAGES)}",
                f"--build-arg TARGET_CROSS_DPKG_ARCHS={shlex.quote(target_cross_dpkg_archs)}",
                f"--build-arg TARGET_CROSS_PACKAGES={shlex.quote(target_cross_packages)}",
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
    build_host: BuildHostConfig | ModalSandboxConfig | None = None,
    compilation_mode: str | None = None,
) -> str:
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
        compilation_mode=compilation_mode,
    )
    return await compiler.build(source_dir)


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
