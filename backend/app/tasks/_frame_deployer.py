from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import shlex
import shutil
import string
import tempfile
from typing import Iterable, Optional
from gzip import compress
from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.apps import get_scene_apps_from_scenes
from app.models.frame import Frame, get_frame_json, get_interpreted_scenes_json
from app.models.log import new_log as log
from app.utils.local_exec import exec_local_command
from app.utils.remote_exec import RemoteTransport, rename_path, upload_file, run_command
from app.drivers.drivers import Driver
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.drivers.devices import drivers_for_frame
from app.models import get_apps_from_scenes
from app.codegen.drivers_nim import (
    DEFAULT_COMPILATION_MODE,
    COMPILATION_MODE_STATIC,
    COMPILATION_MODE_SHARED,
    COMPILATION_MODE_SHARED_SCENES,
    compiled_drivers,
    compilation_mode_uses_shared_libraries,
    driver_library_filename,
    normalize_compilation_mode,
    write_driver_library_nim,
    write_drivers_nim,
)
from app.codegen.scene_nim import (
    compiled_frame_scenes,
    scene_bundle_library_filename,
    scene_library_filename,
    scene_module_filename,
    scene_module_suffix,
    write_scene_library_nim,
    write_scene_nim,
    write_scenes_nim,
)
from app.tasks.utils import find_nimbase_file
from app.tasks.utils import find_nim_v2
from app.codegen.apps_nim import write_apps_nim
from app.codegen.app_loader_nim import write_app_loader_nim

FRAMEOS_NIM_FLAGS = ("-d:malloc",)

DRIVER_LIBRARY_NIM_FLAGS = (
    *FRAMEOS_NIM_FLAGS,
    "--define:frameosDriverLibrary",
    "--opt:size",
    "--stackTrace:off",
    "--lineTrace:off",
    "--passC:-ffunction-sections",
    "--passC:-fdata-sections",
    "--passC:-fno-asynchronous-unwind-tables",
    "--passC:-fno-unwind-tables",
    "--passL:-Wl,--gc-sections",
)

SHARED_LIBRARY_NIM_FLAGS = tuple(
    flag for flag in DRIVER_LIBRARY_NIM_FLAGS if flag != "--define:frameosDriverLibrary"
)

DRIVER_LIBRARY_CFLAGS = (
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-asynchronous-unwind-tables",
    "-fno-unwind-tables",
)

DRIVER_LIBRARY_LDFLAGS = ("-Wl,--gc-sections",)

LOCAL_SOURCE_IGNORE_PATTERNS = (
    ".DS_Store",
    "__pycache__",
    "*.pyc",
    "node_modules",
    "nimcache",
    ".nimcache",
    ".nimcache*",
    "build",
    "tmp",
    ".tmp-cache",
    ".tmp-home",
    "testresults",
    "tests",
    "frameos.deps",
    "nimble.develop",
    "nimble.paths",
    "*.admin_session_salt",
)

FRAMEOS_VERSION_KEYS = ("frameosVersion", "frameos_version", "frameos")


def _iter_config_app_dirs(apps_root: str) -> Iterable[str]:
    if not os.path.isdir(apps_root):
        return
    for category in sorted(os.listdir(apps_root)):
        category_dir = os.path.join(apps_root, category)
        if not os.path.isdir(category_dir):
            continue
        for keyword in sorted(os.listdir(category_dir)):
            app_dir = os.path.join(category_dir, keyword)
            if os.path.isdir(app_dir) and os.path.exists(os.path.join(app_dir, "config.json")):
                yield app_dir


def _frameos_version_from_json(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""

    if not isinstance(data, dict):
        return ""

    for key in FRAMEOS_VERSION_KEYS:
        version = data.get(key)
        if isinstance(version, str) and version:
            return version
    return ""


def _frameos_version_for_source(source_dir: str) -> str:
    source_path = Path(source_dir)
    for path in (source_path.parent / "versions.json", source_path / "frame.json"):
        version = _frameos_version_from_json(path)
        if version:
            return version
    return "unknown"


class FrameDeployer:
    def __init__(self, db: Session, redis: Redis, frame: Frame, nim_path: str, temp_dir: str):
        self.db = db
        self.redis = redis
        self.frame = frame
        self.nim_path = nim_path
        self.temp_dir = temp_dir
        self.build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
        self.deploy_start: datetime = datetime.now()
        self.remote_transport: RemoteTransport = "auto"

    async def exec_command(
        self,
        command: str,
        output: Optional[list[str]] = None,
        log_output: bool = True,
        log_command: str | bool = True,
        raise_on_error: bool = True,
        timeout: int = 1800 # 30 minutes default timeout. Some commands can be really slow...
    ) -> int:
        status, stdout, stderr = await run_command(
            self.db,
            self.redis,
            self.frame,
            command,
            log_output=log_output,
            log_command=log_command,
            timeout=timeout,
            transport=self.remote_transport,
        )
        if output is not None:
            lines = (stdout + "\n" + stderr).splitlines()
            output.extend(lines)
        if status != 0 and raise_on_error:
            raise Exception(
                f"Command '{command}' failed with code {status}\nstderr: {stderr}\nstdout: {stdout}"
            )
        return status

    async def log(self, type: str, line: str, timestamp: Optional[datetime] = None):
        await log(self.db, self.redis, int(self.frame.id), type=type, line=line, timestamp=timestamp)

    @staticmethod
    def _dedupe_preserve_order(flags: Iterable[str]) -> list[str]:
        seen: set[str] = set()
        unique_flags: list[str] = []
        for flag in flags:
            if flag not in seen:
                seen.add(flag)
                unique_flags.append(flag)
        return unique_flags

    @staticmethod
    def _driver_linker_flags(drivers: dict[str, Driver]) -> list[str]:
        flags: list[str] = []
        for driver in drivers.values():
            for flag in driver.link_flags:
                if flag not in flags:
                    flags.append(flag)
        return flags

    @staticmethod
    def driver_library_paths(
        build_dir: str,
        drivers: dict[str, Driver],
        compilation_mode: str,
    ) -> list[str]:
        if not compilation_mode_uses_shared_libraries(compilation_mode):
            return []
        return [
            os.path.join(build_dir, "drivers", driver.name, driver_library_filename(driver))
            for driver in compiled_drivers(drivers)
        ]

    @staticmethod
    def driver_library_names(
        drivers: dict[str, Driver],
        compilation_mode: str,
    ) -> list[str]:
        if not compilation_mode_uses_shared_libraries(compilation_mode):
            return []
        return [driver_library_filename(driver) for driver in compiled_drivers(drivers)]

    @staticmethod
    def scene_library_paths(
        build_dir: str,
        frame: Frame,
        compilation_mode: str,
    ) -> list[str]:
        if not compilation_mode_uses_shared_libraries(compilation_mode):
            return []
        compiled_scenes = compiled_frame_scenes(frame)
        if not compiled_scenes:
            return []
        if compilation_mode == COMPILATION_MODE_SHARED_SCENES:
            return [os.path.join(build_dir, "scenes", scene_bundle_library_filename())]
        return [
            os.path.join(build_dir, "scenes", scene_module_suffix(scene), scene_library_filename(scene))
            for scene in compiled_scenes
        ]

    @staticmethod
    def scene_library_names(
        frame: Frame,
        compilation_mode: str,
    ) -> list[str]:
        if not compilation_mode_uses_shared_libraries(compilation_mode):
            return []
        if not compiled_frame_scenes(frame):
            return []
        if compilation_mode == COMPILATION_MODE_SHARED_SCENES:
            return [scene_bundle_library_filename()]
        return [scene_library_filename(scene) for scene in compiled_frame_scenes(frame)]

    async def _upload_frame_json(self, path: str) -> None:
        """Upload the release-specific `frame.json`."""
        json_data = json.dumps(get_frame_json(self.db, self.frame), indent=4).encode() + b"\n"
        await upload_file(self.db, self.redis, self.frame, path, json_data, transport=self.remote_transport)

    async def _upload_scenes_json(self, path: str, gzip: bool = False) -> None:
        """Upload the release-specific `scenes.json`."""
        json_data = json.dumps(get_interpreted_scenes_json(self.frame), indent=4).encode() + b"\n"
        if gzip:
            json_data = compress(json_data)
        await upload_file(self.db, self.redis, self.frame, path, json_data, transport=self.remote_transport)

    async def _upload_all_scenes_json(self, path: str, gzip: bool = False) -> None:
        """Upload the full scene payload for deploy-time metadata checks."""
        json_data = json.dumps(list(self.frame.scenes or []), indent=4).encode() + b"\n"
        if gzip:
            json_data = compress(json_data)
        await upload_file(self.db, self.redis, self.frame, path, json_data, transport=self.remote_transport)

    async def _upload_frame_json_atomically(self, path: str) -> None:
        temp_path = f"{path}.tmp-{self.build_id}"
        await self._upload_frame_json(temp_path)
        await rename_path(self.db, self.redis, self.frame, temp_path, path, transport=self.remote_transport)

    async def _upload_scenes_json_atomically(self, path: str, gzip: bool = False) -> None:
        temp_path = f"{path}.tmp-{self.build_id}"
        await self._upload_scenes_json(temp_path, gzip=gzip)
        await rename_path(self.db, self.redis, self.frame, temp_path, path, transport=self.remote_transport)

    async def _upload_all_scenes_json_atomically(self, path: str, gzip: bool = False) -> None:
        temp_path = f"{path}.tmp-{self.build_id}"
        await self._upload_all_scenes_json(temp_path, gzip=gzip)
        await rename_path(self.db, self.redis, self.frame, temp_path, path, transport=self.remote_transport)

    async def get_hostname(self) -> str:
        hostname_out: list[str] = []
        await self.exec_command("hostname", hostname_out)
        target_host = hostname_out[0].strip() or "frame-unknown"
        return target_host

    async def get_distro(self) -> str:
        if self.frame.mode == "buildroot":
            return "buildroot" # explicitly for now

        distro_out: list[str] = []
        await self.exec_command(
            "bash -c '"
            "if [ -f /etc/rpi-issue ] || grep -q \"^ID=raspbian\" /etc/os-release ; then echo raspios ; "
            "else . /etc/os-release ; echo ${ID:-unknown} ; "
            "fi'",
            distro_out,
            log_command=False,
            log_output=False,
        )
        distro = distro_out[0].strip().lower()
        return distro if distro else "unknown"

    async def get_distro_version(self) -> str:
        if self.frame.mode == "buildroot":
            return "22.04" # explicitly for now

        version_out: list[str] = []
        await self.exec_command(
            "bash -c '"
            "if [ -f /etc/os-release ]; then "
            ". /etc/os-release ; "
            "if [ -n \"${VERSION_CODENAME}\" ]; then echo ${VERSION_CODENAME}; "
            "elif [ -n \"${VERSION_ID}\" ]; then echo ${VERSION_ID}; "
            "else echo unknown; fi; "
            "else echo unknown; fi'",
            version_out,
            log_command=False,
            log_output=False,
        )
        version = version_out[0].strip().lower() if version_out else ""
        return version or "unknown"

    async def get_total_memory_mb(self) -> int:
        mem_output: list[str] = []
        await self.exec_command(
            "grep MemTotal /proc/meminfo | awk '{print $2}'",
            mem_output,
            log_command=False,
            log_output=False,
        )
        kib = int(mem_output[0].strip()) if mem_output else 0 # kB from the kernel
        total_memory = kib // 1024 # MiB
        return total_memory

    async def get_cpu_architecture(self) -> str:
        if self.frame.mode == "buildroot":
            return "armv7l" # 32bit arm, explicitly for now

        uname_output: list[str] = []
        await self.exec_command("uname -m", uname_output, log_command=False, log_output=False)
        arch = "".join(uname_output).strip()
        return arch

    async def arch_to_nim_cpu(self, arch: str) -> str:
        if arch in ("aarch64", "arm64"):
            return "arm64"
        elif arch in ("armv6l", "armv7l", "armhf"):
            return "arm"
        elif arch == "i386":
            return "i386"
        else:
            return "amd64"

    async def restart_service(self, service_name: str) -> None:
        await self.exec_command(f"sudo systemctl enable {service_name}.service")
        await self.exec_command(f"sudo systemctl restart {service_name}.service")
        await self.exec_command(f"sudo systemctl status {service_name}.service")

    async def stop_service(self, service_name: str) -> None:
        await self.exec_command(f"sudo systemctl stop {service_name}.service || true")

    async def disable_service(self, service_name: str) -> None:
        await self.exec_command(f"sudo systemctl disable {service_name}.service", raise_on_error=False)

    async def make_local_modifications(
        self,
        source_dir: str,
        compilation_mode: str = DEFAULT_COMPILATION_MODE,
        drivers_override: dict[str, Driver] | None = None,
        drivers_nim_source: str | None = None,
    ):
        frame = self.frame
        compilation_mode = normalize_compilation_mode(compilation_mode)
        shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
        os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

        # find all apps
        os.makedirs(os.path.join(source_dir, "src", "apps"), exist_ok=True)
        for app_dir in _iter_config_app_dirs(os.path.join(source_dir, "src", "apps")):
            config_path = os.path.join(app_dir, "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r") as f:
                    config = json.load(f)
                    app_loader_nim = write_app_loader_nim(app_dir, config)
                    with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                        lf.write(app_loader_nim)

        scenes = list(frame.scenes)
        for app_id, sources in get_scene_apps_from_scenes(scenes).items():
            app_dir = os.path.join(source_dir, "src", "apps", app_id)
            os.makedirs(app_dir, exist_ok=True)
            for filename, code in sources.items():
                with open(os.path.join(app_dir, filename), "w") as f:
                    f.write(code)
            config_json = sources["config.json"] if "config.json" in sources else '{}'
            config = json.loads(config_json)
            app_loader_nim = write_app_loader_nim(app_dir, config)
            with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                lf.write(app_loader_nim)

        for node_id, sources in get_apps_from_scenes(scenes).items():
            app_id = "nodeapp_" + node_id.replace('-', '_')
            app_dir = os.path.join(source_dir, "src", "apps", app_id)
            os.makedirs(app_dir, exist_ok=True)
            for filename, code in sources.items():
                with open(os.path.join(app_dir, filename), "w") as f:
                    f.write(code)
            config_json = sources["config.json"] if "config.json" in sources else '{}'
            config = json.loads(config_json)
            app_loader_nim = write_app_loader_nim(app_dir, config)
            with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                lf.write(app_loader_nim)

        # write apps.nim
        with open(os.path.join(source_dir, "src", "apps", "apps.nim"), "w") as f:
            f.write(write_apps_nim(source_dir))

        for scene in frame.scenes:
            execution = scene.get("settings", {}).get("execution", "compiled")
            if execution == "interpreted":
                # We're writing them to scenes.json post build
                continue
            try:
                scene_source = write_scene_nim(frame, scene)
                with open(os.path.join(source_dir, "src", "scenes", scene_module_filename(scene)), "w") as f:
                    f.write(scene_source)
            except Exception as e:
                await self.log("stderr",
                        f"Error writing scene \"{scene.get('name','')}\" "
                        f"({scene.get('id','default')}): {e}")
                raise

        shared_scene_dir = os.path.join(source_dir, "src", "scenes", "shared")
        shutil.rmtree(shared_scene_dir, ignore_errors=True)
        if compilation_mode_uses_shared_libraries(compilation_mode):
            os.makedirs(shared_scene_dir, exist_ok=True)
            for scene in compiled_frame_scenes(frame):
                with open(os.path.join(shared_scene_dir, scene_module_filename(scene)), "w") as sf:
                    sf.write(write_scene_library_nim(scene))
            if compilation_mode == COMPILATION_MODE_SHARED_SCENES:
                with open(os.path.join(source_dir, "src", "scenes", "scenes_bundle.nim"), "w") as bf:
                    bf.write(write_scenes_nim(frame, compilation_mode=COMPILATION_MODE_SHARED_SCENES))

        with open(os.path.join(source_dir, "src", "scenes", "scenes.nim"), "w") as f:
            source = write_scenes_nim(frame, compilation_mode=compilation_mode)
            f.write(source)

        drivers = drivers_override or drivers_for_frame(frame)
        with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as f:
            source = drivers_nim_source or write_drivers_nim(drivers, compilation_mode=compilation_mode)
            f.write(source)

        if drivers.get("waveshare"):
            with open(os.path.join(source_dir, "src", "drivers", "waveshare", "driver.nim"), "w") as wf:
                source = write_waveshare_driver_nim(drivers)
                wf.write(source)

        shared_driver_dir = os.path.join(source_dir, "src", "drivers", "shared")
        shutil.rmtree(shared_driver_dir, ignore_errors=True)
        if compilation_mode_uses_shared_libraries(compilation_mode):
            os.makedirs(shared_driver_dir, exist_ok=True)
            for driver in compiled_drivers(drivers):
                with open(os.path.join(shared_driver_dir, f"{driver.name}.nim"), "w") as sf:
                    sf.write(write_driver_library_nim(driver))

    def create_local_source_folder(self, temp_dir: str, source_root: str | None = None) -> str:
        source_dir = os.path.join(temp_dir, "frameos")
        os.makedirs(source_dir, exist_ok=True)
        base = Path(source_root or "../frameos").resolve()
        shutil.copytree(
            base,
            source_dir,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(*LOCAL_SOURCE_IGNORE_PATTERNS),
        )
        repo_root = base.parent
        repo_root_package = repo_root / "package.json"
        if repo_root_package.is_file():
            shutil.copy2(repo_root_package, Path(temp_dir) / "package.json")
        repo_pnpm_workspace = repo_root / "pnpm-workspace.yaml"
        if repo_pnpm_workspace.is_file():
            shutil.copy2(repo_pnpm_workspace, Path(temp_dir) / "pnpm-workspace.yaml")
        repo_pnpm_lock = repo_root / "pnpm-lock.yaml"
        if repo_pnpm_lock.is_file():
            shutil.copy2(repo_pnpm_lock, Path(temp_dir) / "pnpm-lock.yaml")
        repo_frontend_src = repo_root / "frontend" / "src"
        if repo_frontend_src.is_dir():
            frontend_src_dir = Path(temp_dir) / "frontend" / "src"
            frontend_src_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(repo_frontend_src, frontend_src_dir, dirs_exist_ok=True)
        repo_frontend_package = repo_root / "frontend" / "package.json"
        if repo_frontend_package.is_file():
            frontend_dir = Path(temp_dir) / "frontend"
            frontend_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo_frontend_package, frontend_dir / "package.json")
        repo_frontend_schema = repo_root / "frontend" / "schema"
        if repo_frontend_schema.is_dir():
            frontend_schema_dir = Path(temp_dir) / "frontend" / "schema"
            frontend_schema_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(repo_frontend_schema, frontend_schema_dir, dirs_exist_ok=True)
        repo_frontend_scripts = repo_root / "frontend" / "scripts"
        if repo_frontend_scripts.is_dir():
            frontend_scripts_dir = Path(temp_dir) / "frontend" / "scripts"
            frontend_scripts_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(repo_frontend_scripts, frontend_scripts_dir, dirs_exist_ok=True)
        repo_apps_code = repo_root / "repo" / "apps" / "code"
        if repo_apps_code.is_dir():
            repo_apps_code_dir = Path(temp_dir) / "repo" / "apps" / "code"
            repo_apps_code_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(repo_apps_code, repo_apps_code_dir, dirs_exist_ok=True)
        repo_versions = repo_root / "versions.json"
        if repo_versions.is_file():
            shutil.copy2(repo_versions, Path(temp_dir) / "versions.json")
        return source_dir

    @staticmethod
    def _find_compile_script(build_dir: str, preferred_name: str | None = None) -> str:
        if preferred_name:
            preferred = os.path.join(build_dir, preferred_name)
            if os.path.exists(preferred):
                return preferred
        scripts = sorted(Path(build_dir).glob("compile_*.sh"))
        if not scripts:
            raise Exception(f"No generated Nim compile script found in {build_dir}")
        return str(scripts[0])

    @staticmethod
    def _extract_compile_flags(script_path: str, output_name: str) -> tuple[list[str], list[str]]:
        linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"]
        compiler_flags: list[str] = []
        with open(script_path, "r") as sc:
            lines_sc = sc.readlines()
        for line in lines_sc:
            try:
                parts = shlex.split(line)
            except ValueError:
                parts = line.split()
            if "-o" in parts and output_name in parts and "-c" not in parts:
                linker_flags = [
                    fl.strip() for fl in parts
                    if fl.startswith("-") and fl != "-o"
                ]
            elif "-c" in parts and not compiler_flags:
                compiler_flags = [
                    fl for fl in parts
                    if fl.startswith("-") and not fl.startswith("-I")
                    and fl not in ["-o", "-c", "-D"]
                ]
        return linker_flags, compiler_flags

    @staticmethod
    def _write_c_makefile(
        *,
        makefile_path: str,
        template_path: str,
        output_name: str,
        linker_flags: Iterable[str],
        compiler_flags: Iterable[str],
        driver_dirs: list[str] | None = None,
        scene_dirs: list[str] | None = None,
    ) -> None:
        driver_dirs = driver_dirs or []
        scene_dirs = scene_dirs or []
        library_dirs = driver_dirs + scene_dirs
        with open(template_path, "r") as mf_in, open(makefile_path, "w") as mk:
            for ln in mf_in.readlines():
                if ln.startswith("EXECUTABLE = "):
                    ln = f"EXECUTABLE = {output_name}\n"
                if ln.startswith("LIBS = "):
                    ln = (
                        "LIBS = -L. "
                        + " ".join(linker_flags)
                        + " $(EXTRA_LIBS)\n"
                    )
                if ln.startswith("CFLAGS = "):
                    ln = (
                        "CFLAGS = "
                        + " ".join([f for f in compiler_flags if f != "-c"])
                        + " $(EXTRA_CFLAGS)\n"
                    )
                if library_dirs and ln.startswith("all:"):
                    ln = "all: $(EXECUTABLE) shared-libraries\n"
                mk.write(ln)

            if library_dirs:
                mk.write("\nLIBRARY_DIRS = " + " ".join(library_dirs) + "\n")
                mk.write("DRIVER_DIRS = " + " ".join(driver_dirs) + "\n")
                mk.write("SCENE_DIRS = " + " ".join(scene_dirs) + "\n\n")
                mk.write(".PHONY: shared-libraries driver-libraries scene-libraries $(LIBRARY_DIRS)\n")
                mk.write("shared-libraries: $(LIBRARY_DIRS)\n\n")
                mk.write("driver-libraries: $(DRIVER_DIRS)\n\n")
                mk.write("scene-libraries: $(SCENE_DIRS)\n\n")
                mk.write("$(LIBRARY_DIRS):\n")
                mk.write("\t+$(MAKE) -C $@\n")

    @staticmethod
    def _write_driver_makefile(
        *,
        makefile_path: str,
        output_name: str,
        linker_flags: Iterable[str],
        compiler_flags: Iterable[str],
        library_kind: str = "driver",
    ) -> None:
        linker_flags_text = " ".join(
            FrameDeployer._dedupe_preserve_order(list(linker_flags) + list(DRIVER_LIBRARY_LDFLAGS))
        )
        compiler_flags_text = " ".join(
            FrameDeployer._dedupe_preserve_order(
                [f for f in compiler_flags if f != "-c"] + ["-fPIC"] + list(DRIVER_LIBRARY_CFLAGS)
            )
        )
        with open(makefile_path, "w") as mk:
            mk.write(
                f"""# This Makefile is used for compiling {library_kind} C sources generated by Nim
CC ?= gcc
STRIP ?= strip
EXTRA_CFLAGS ?=
EXTRA_LIBS ?=

SOURCES := $(shell ls -S *.c 2>/dev/null)
OBJECTS = $(SOURCES:.c=.o)
TOTAL = $(words $(SOURCES))
LIBRARY = {output_name}
LIBS = -L. {linker_flags_text} $(EXTRA_LIBS)
CFLAGS = {compiler_flags_text} $(EXTRA_CFLAGS)

all: $(LIBRARY)

$(LIBRARY): $(OBJECTS)
\t@echo "🟣 Linking $(LIBRARY)"
\t@echo "LIBS: $(LIBS)"
\t@$(CC) -shared -o $(LIBRARY) $(OBJECTS) $(LIBS)
\t@$(STRIP) --strip-unneeded $(LIBRARY) 2>/dev/null || true

clean:
\trm -f *.o $(LIBRARY)

pre-build:
\t@mkdir -p ../../../cache
\t@echo "🟣 Compiling {library_kind} $(LIBRARY)"

$(OBJECTS): pre-build

%.o: %.c
\t@if [ ! -e $@ ]; then \\
\t\tmd5sum=$$(md5sum $< | awk '{{print $$1}}'); \\
\t\traw='$<'; \\
\t\tif printf '%s' "$$raw" | grep -q '\\.nim\\.c$$'; then \\
\t\t\tencoded=$${{raw%.nim.c}}; \\
\t\t\tfile=$$(printf '%s' "$$encoded" | sed 's/@f/\\//g; s/@z//g; s/@m/-/g' | tr 'A-Za-z' 'N-ZA-Mn-za-m'); \\
\t\t\tfile="$${{file}}.nim"; \\
\t\telse \\
\t\t\tfile="$$raw"; \\
\t\tfi; \\
\t\tfile=$$(printf '%s' "$$file" | sed 's#^\\(\\.\\./\\)*##' | sed 's#.*nimble/pkgs2/##' | sed 's#.*nim/lib/#nim/lib/#'); \\
\t\tcache_obj=../../../cache/$$md5sum.o; \\
\t\tif [ -f "$$cache_obj" ]; then \\
\t\t\tln -s "$$cache_obj" $@; \\
\t\telse \\
\t\t\t$(CC) -c $(CFLAGS) $< -o $@; \\
\t\t\ttmp_cache_obj="$$cache_obj.$$PPID.tmp"; \\
\t\t\tcp $@ "$$tmp_cache_obj"; \\
\t\t\tmv -n "$$tmp_cache_obj" "$$cache_obj" 2>/dev/null || rm -f "$$tmp_cache_obj"; \\
\t\t\techo "[$$(ls *.o | wc -l)/$(TOTAL)] $$file"; \\
\t\tfi; \\
\tfi

.PHONY: all clean pre-build
"""
            )

    @staticmethod
    def _waveshare_files(waveshare: Driver) -> tuple[str, list[str]]:
        if not waveshare.variant:
            return "", []
        variant_folder = get_variant_folder(waveshare.variant)

        if waveshare.variant in ("EPD_10in3", "EPD_13in3e"):
            util_files: list[str] = []
        else:
            util_files = ["DEV_Config.c", "DEV_Config.h"]
        if variant_folder != "it8951" and waveshare.variant != "EPD_13in3e":
            util_files.insert(0, "Debug.h")

        if waveshare.variant in [
            "EPD_2in9b", "EPD_2in9c", "EPD_2in13b", "EPD_2in13c",
            "EPD_4in2b", "EPD_4in2c", "EPD_5in83b", "EPD_5in83c",
            "EPD_7in5b", "EPD_7in5c"
        ]:
            c_file = re.sub(r'[bc]', 'bc', waveshare.variant)
            variant_files = [f"{waveshare.variant}.nim", f"{c_file}.c", f"{c_file}.h"]
        elif waveshare.variant == "EPD_10in3":
            variant_files = [f"{waveshare.variant}.nim", "IT8951.nim"]
        elif waveshare.variant in ["EPD_4in0e", "EPD_4in01f", "EPD_7in3e", "EPD_13in3e"]:
            variant_files = [f"{waveshare.variant}.nim"]
        else:
            variant_files = [f"{waveshare.variant}.nim", f"{waveshare.variant}.c", f"{waveshare.variant}.h"]

        return variant_folder, list(dict.fromkeys(util_files + variant_files))

    def _copy_waveshare_build_files(
        self,
        source_dir: str,
        destination_dir: str,
        drivers: dict[str, Driver],
    ) -> None:
        waveshare = drivers.get("waveshare")
        self._copy_waveshare_driver_build_files(source_dir, destination_dir, waveshare)

    def _copy_waveshare_driver_build_files(
        self,
        source_dir: str,
        destination_dir: str,
        waveshare: Driver | None,
    ) -> None:
        if not waveshare or not waveshare.variant:
            return
        variant_folder, waveshare_files = self._waveshare_files(waveshare)
        for wf in waveshare_files:
            shutil.copy(
                os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, wf),
                os.path.join(destination_dir, wf),
            )
        if "DEV_Config.h" in waveshare_files:
            shutil.copy(
                os.path.join(source_dir, "src", "lib", "lgpio.h"),
                os.path.join(destination_dir, "lgpio.h"),
            )

    async def create_local_build_archive(
        self,
        build_dir: str,
        source_dir: str,
        arch: str,
        compilation_mode: str = DEFAULT_COMPILATION_MODE,
        drivers_override: dict[str, Driver] | None = None,
    ) -> str:
        db = self.db
        redis = self.redis
        frame = self.frame
        build_id = self.build_id
        nim_path = self.nim_path or find_nim_v2()
        self.nim_path = nim_path
        temp_dir = self.temp_dir

        drivers = drivers_override or drivers_for_frame(frame)
        if inkyPython := drivers.get('inkyPython'):
            vendor_folder = inkyPython.vendor_folder or ""
            os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
            shutil.copytree(
                os.path.join(source_dir, "vendor", vendor_folder),
                os.path.join(build_dir, "vendor", vendor_folder),
                dirs_exist_ok=True
            )
            shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
            shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)

        if inkyHyperPixel2r := drivers.get('inkyHyperPixel2rLegacyFb'):
            vendor_folder = inkyHyperPixel2r.vendor_folder or ""
            os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
            shutil.copytree(
                os.path.join(source_dir, "vendor", vendor_folder),
                os.path.join(build_dir, "vendor", vendor_folder),
                dirs_exist_ok=True
            )
            shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
            shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)

        await self.log(
            "stdout",
            "🔥 Generating C sources from Nim sources.",
        )

        cpu = await self.arch_to_nim_cpu(arch)
        debug_options = "--lineTrace:on" if frame.debug else ""
        version_option = shlex.quote(f"--define:frameosVersion:{_frameos_version_for_source(source_dir)}")
        cmd = (
            f"cd {source_dir} && nimble assets -y && nimble setup && "
            f"{nim_path} compile --os:linux --cpu:{cpu} "
            f"{' '.join(FRAMEOS_NIM_FLAGS)} "
            f"{version_option} "
            f"--compileOnly --genScript --nimcache:{build_dir} "
            f"{debug_options} src/frameos.nim 2>&1"
        )

        status, out, err = await exec_local_command(db, redis, frame, cmd)
        if status != 0:
            lines = ((out or "") + ("\n" + err if err else "")).splitlines()
            filtered = [ln for ln in lines if ln.strip()]
            for line in reversed(filtered):
                match = re.match(r'^(.*\.nim)\((\d+), (\d+)\),?.*', line)
                if match:
                    fn = match.group(1)
                    line_nr = int(match.group(2))
                    column = int(match.group(3))
                    source_abs = os.path.realpath(source_dir)
                    final_path = os.path.realpath(os.path.join(source_dir, fn))
                    if os.path.commonprefix([final_path, source_abs]) == source_abs and os.path.exists(final_path):
                        rel_fn = final_path[len(source_abs) + 1:]
                        with open(final_path, "r") as of:
                            all_lines = of.readlines()
                        await self.log("stdout", f"Error in {rel_fn}:{line_nr}:{column}")
                        await self.log("stdout", f"Line {line_nr}: {all_lines[line_nr - 1]}")
                        await self.log("stdout", f".......{'.'*(column - 1 + len(str(line_nr)))}^")
                    else:
                        await self.log("stdout", f"Error in {fn}:{line_nr}:{column}")
                    break

            raise Exception("Failed to generate frameos sources")

        nimbase_path = find_nimbase_file(nim_path)
        if not nimbase_path:
            raise Exception("nimbase.h not found")

        shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

        compilation_mode = normalize_compilation_mode(compilation_mode)
        driver_make_dirs: list[str] = []
        scene_make_dirs: list[str] = []
        if compilation_mode == COMPILATION_MODE_STATIC:
            self._copy_waveshare_build_files(source_dir, build_dir, drivers)

        script_path = self._find_compile_script(build_dir, "compile_frameos.sh")
        linker_flags, compiler_flags = self._extract_compile_flags(script_path, "frameos")
        main_driver_linker_flags = (
            self._driver_linker_flags(drivers)
            if compilation_mode == COMPILATION_MODE_STATIC
            else []
        )
        linker_flags = self._dedupe_preserve_order(
            linker_flags
            + ["quickjs/libquickjs.a"]
            + main_driver_linker_flags
        )

        if compilation_mode_uses_shared_libraries(compilation_mode):
            compiled_scenes = compiled_frame_scenes(frame)
            for driver in compiled_drivers(drivers):
                driver_dir = os.path.join(build_dir, "drivers", driver.name)
                os.makedirs(driver_dir, exist_ok=True)
                output_name = driver_library_filename(driver)
                await self.log("stdout", f"🔥 Generating C sources for driver {driver.name}.")
                driver_cmd = (
                    f"cd {source_dir} && {nim_path} compile --app:lib --os:linux --cpu:{cpu} "
                    f"{' '.join(DRIVER_LIBRARY_NIM_FLAGS)} "
                    f"--compileOnly --genScript --nimcache:{driver_dir} --out:{output_name} "
                    f"{debug_options} src/drivers/shared/{driver.name}.nim 2>&1"
                )
                driver_status, driver_out, driver_err = await exec_local_command(db, redis, frame, driver_cmd)
                if driver_status != 0:
                    raise Exception(
                        f"Failed to generate driver sources for {driver.name}: "
                        f"{driver_err or driver_out or 'see logs'}"
                    )
                shutil.copy(nimbase_path, os.path.join(driver_dir, "nimbase.h"))
                if driver.name == "waveshare" or driver.name.startswith("waveshare_"):
                    self._copy_waveshare_driver_build_files(source_dir, driver_dir, driver)

                driver_script_path = self._find_compile_script(driver_dir)
                driver_linker_flags, driver_compiler_flags = self._extract_compile_flags(
                    driver_script_path, output_name
                )
                driver_linker_flags = self._dedupe_preserve_order(
                    driver_linker_flags
                    + ["../../quickjs/libquickjs.a"]
                    + list(driver.link_flags)
                )
                self._write_driver_makefile(
                    makefile_path=os.path.join(driver_dir, "Makefile"),
                    output_name=output_name,
                    linker_flags=driver_linker_flags,
                    compiler_flags=driver_compiler_flags,
                )
                driver_make_dirs.append(os.path.join("drivers", driver.name))

            if compilation_mode == COMPILATION_MODE_SHARED:
                for scene in compiled_scenes:
                    scene_dir_name = scene_module_suffix(scene)
                    scene_dir = os.path.join(build_dir, "scenes", scene_dir_name)
                    os.makedirs(scene_dir, exist_ok=True)
                    output_name = scene_library_filename(scene)
                    await self.log("stdout", f"🔥 Generating C sources for scene {scene.get('id', 'default')}.")
                    scene_cmd = (
                        f"cd {source_dir} && {nim_path} compile --app:lib --os:linux --cpu:{cpu} "
                        f"--define:frameosSharedLibrary {' '.join(SHARED_LIBRARY_NIM_FLAGS)} "
                        f"--compileOnly --genScript --nimcache:{scene_dir} --out:{output_name} "
                        f"{debug_options} src/scenes/shared/{scene_module_filename(scene)} 2>&1"
                    )
                    scene_status, scene_out, scene_err = await exec_local_command(db, redis, frame, scene_cmd)
                    if scene_status != 0:
                        raise Exception(
                            f"Failed to generate scene library sources for {scene.get('id', 'default')}: "
                            f"{scene_err or scene_out or 'see logs'}"
                        )
                    shutil.copy(nimbase_path, os.path.join(scene_dir, "nimbase.h"))

                    scene_script_path = self._find_compile_script(scene_dir)
                    scene_linker_flags, scene_compiler_flags = self._extract_compile_flags(
                        scene_script_path, output_name
                    )
                    scene_linker_flags = self._dedupe_preserve_order(
                        scene_linker_flags + ["../../quickjs/libquickjs.a"]
                    )
                    self._write_driver_makefile(
                        makefile_path=os.path.join(scene_dir, "Makefile"),
                        output_name=output_name,
                        linker_flags=scene_linker_flags,
                        compiler_flags=scene_compiler_flags,
                        library_kind="scene",
                    )
                    scene_make_dirs.append(os.path.join("scenes", scene_dir_name))
            elif compilation_mode == COMPILATION_MODE_SHARED_SCENES and compiled_scenes:
                scene_dir = os.path.join(build_dir, "scenes")
                os.makedirs(scene_dir, exist_ok=True)
                output_name = scene_bundle_library_filename()
                await self.log("stdout", "🔥 Generating C sources for bundled shared scenes.")
                scene_cmd = (
                    f"cd {source_dir} && {nim_path} compile --app:lib --os:linux --cpu:{cpu} "
                    f"--define:frameosSharedLibrary {' '.join(SHARED_LIBRARY_NIM_FLAGS)} "
                    f"--compileOnly --genScript --nimcache:{scene_dir} --out:{output_name} "
                    f"{debug_options} src/scenes/scenes_bundle.nim 2>&1"
                )
                scene_status, scene_out, scene_err = await exec_local_command(db, redis, frame, scene_cmd)
                if scene_status != 0:
                    raise Exception(
                        f"Failed to generate bundled scene library sources: {scene_err or scene_out or 'see logs'}"
                    )
                shutil.copy(nimbase_path, os.path.join(scene_dir, "nimbase.h"))

                scene_script_path = self._find_compile_script(scene_dir)
                scene_linker_flags, scene_compiler_flags = self._extract_compile_flags(
                    scene_script_path, output_name
                )
                scene_linker_flags = self._dedupe_preserve_order(
                    scene_linker_flags + ["../quickjs/libquickjs.a"]
                )
                self._write_driver_makefile(
                    makefile_path=os.path.join(scene_dir, "Makefile"),
                    output_name=output_name,
                    linker_flags=scene_linker_flags,
                    compiler_flags=scene_compiler_flags,
                    library_kind="scene",
                )
                scene_make_dirs.append("scenes")

        self._write_c_makefile(
            makefile_path=os.path.join(build_dir, "Makefile"),
            template_path=os.path.join(source_dir, "tools", "nimc.Makefile"),
            output_name="frameos",
            linker_flags=linker_flags,
            compiler_flags=compiler_flags,
            driver_dirs=driver_make_dirs,
            scene_dirs=scene_make_dirs,
        )

        archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
        zip_base = os.path.join(temp_dir, f"build_{build_id}")
        build_path = Path(build_dir)
        shutil.make_archive(zip_base, 'gztar', str(build_path.parent), build_path.name)
        return archive_path

    async def file_in_sync(
        self: "FrameDeployer",
        remote_path: str,
        local_path: str,
    ) -> bool:
        """
        Check if the remote path is the same as the local path.
        """
        def sha256(path: str) -> str:
            h = hashlib.sha256()
            with open(path, "rb") as fp:
                for chunk in iter(lambda: fp.read(65536), b""):
                    h.update(chunk)
            return h.hexdigest()

        remote_sha_out: list[str] = []
        await self.exec_command(f"sha256sum {remote_path} 2>/dev/null | cut -d' ' -f1 || true", remote_sha_out)
        remote_sha = (remote_sha_out[0].strip() if remote_sha_out else "")

        local_sha = sha256(local_path)
        return remote_sha == local_sha
