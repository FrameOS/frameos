from datetime import datetime
from glob import glob
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

from app.models.apps import get_app_configs, get_one_app_sources
from app.models.frame import Frame, get_frame_json, get_interpreted_scenes_json
from app.models.log import new_log as log
from app.utils.local_exec import exec_local_command
from app.utils.remote_exec import upload_file, run_command
from app.drivers.drivers import Driver
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.drivers.devices import drivers_for_frame
from app.models import get_apps_from_scenes
from app.codegen.drivers_nim import write_drivers_nim
from app.codegen.scene_nim import write_scene_nim, write_scenes_nim
from app.tasks.utils import find_nimbase_file
from app.codegen.apps_nim import write_apps_nim
from app.codegen.app_loader_nim import write_app_loader_nim, write_js_app_nim
from app.utils.js_apps import compile_js_app_dir, is_js_app_dir

class FrameDeployer:
    def __init__(self, db: Session, redis: Redis, frame: Frame, nim_path: str, temp_dir: str):
        self.db = db
        self.redis = redis
        self.frame = frame
        self.nim_path = nim_path
        self.temp_dir = temp_dir
        self.build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
        self.deploy_start: datetime = datetime.now()

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
            self.db, self.redis, self.frame, command, log_output=log_output, log_command=log_command, timeout=timeout
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

    async def _upload_frame_json(self, path: str) -> None:
        """Upload the release-specific `frame.json`."""
        json_data = json.dumps(get_frame_json(self.db, self.frame), indent=4).encode() + b"\n"
        await upload_file(self.db, self.redis, self.frame, path, json_data)

    async def _upload_scenes_json(self, path: str, gzip: bool = False) -> None:
        """Upload the release-specific `scenes.json`."""
        json_data = json.dumps(get_interpreted_scenes_json(self.frame), indent=4).encode() + b"\n"
        if gzip:
            json_data = compress(json_data)
        await upload_file(self.db, self.redis, self.frame, path, json_data)

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

    async def make_local_modifications(self, source_dir: str):
        frame = self.frame
        shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
        os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

        # find all apps
        os.makedirs(os.path.join(source_dir, "src", "apps"), exist_ok=True)
        for app_dir in glob(os.path.join(source_dir, "src", "apps", "*", "*")):
            config_path = os.path.join(app_dir, "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r") as f:
                    config = json.load(f)
                    if is_js_app_dir(app_dir):
                        compile_js_app_dir(app_dir)
                        with open(os.path.join(app_dir, "app.nim"), "w") as af:
                            af.write(write_js_app_nim(app_dir, config))
                    app_loader_nim = write_app_loader_nim(app_dir, config)
                    with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                        lf.write(app_loader_nim)

        scenes = list(frame.scenes)
        for node_id, sources in get_apps_from_scenes(scenes).items():
            app_id = "nodeapp_" + node_id.replace('-', '_')
            app_dir = os.path.join(source_dir, "src", "apps", app_id)
            os.makedirs(app_dir, exist_ok=True)
            for filename, code in sources.items():
                with open(os.path.join(app_dir, filename), "w") as f:
                    f.write(code)
            config_json = sources["config.json"] if "config.json" in sources else '{}'
            config = json.loads(config_json)
            if is_js_app_dir(app_dir):
                compile_js_app_dir(app_dir)
                with open(os.path.join(app_dir, "app.nim"), "w") as af:
                    af.write(write_js_app_nim(app_dir, config))
            app_loader_nim = write_app_loader_nim(app_dir, config)
            with open(os.path.join(app_dir, "app_loader.nim"), "w") as lf:
                lf.write(app_loader_nim)

        # write apps.nim
        with open(os.path.join(source_dir, "src", "apps", "apps.nim"), "w") as f:
            f.write(write_apps_nim("../frameos"))

        for scene in frame.scenes:
            execution = scene.get("settings", {}).get("execution", "compiled")
            safe_id = re.sub(r'\W+', '', scene.get('id', 'default'))
            if execution == "interpreted":
                # We're writing them to scenes.json post build
                continue
            try:
                scene_source = write_scene_nim(frame, scene)
                with open(os.path.join(source_dir, "src", "scenes", f"scene_{safe_id}.nim"), "w") as f:
                    f.write(scene_source)
            except Exception as e:
                await self.log("stderr",
                        f"Error writing scene \"{scene.get('name','')}\" "
                        f"({scene.get('id','default')}): {e}")
                raise

        with open(os.path.join(source_dir, "src", "scenes", "scenes.nim"), "w") as f:
            source = write_scenes_nim(frame)
            f.write(source)

        drivers = drivers_for_frame(frame)
        with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as f:
            source = write_drivers_nim(drivers)
            f.write(source)

        if drivers.get("waveshare"):
            with open(os.path.join(source_dir, "src", "drivers", "waveshare", "driver.nim"), "w") as wf:
                source = write_waveshare_driver_nim(drivers)
                wf.write(source)

    def create_local_source_folder(self, temp_dir: str, source_root: str | None = None) -> str:
        source_dir = os.path.join(temp_dir, "frameos")
        os.makedirs(source_dir, exist_ok=True)
        base = Path(source_root or "../frameos").resolve()
        shutil.copytree(
            base,
            source_dir,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("node_modules"),
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
        repo_versions = repo_root / "versions.json"
        if repo_versions.is_file():
            shutil.copy2(repo_versions, Path(temp_dir) / "versions.json")
        return source_dir

    async def create_local_build_archive(
        self,
        build_dir: str,
        source_dir: str,
        arch: str
    ) -> str:
        db = self.db
        redis = self.redis
        frame = self.frame
        build_id = self.build_id
        nim_path = self.nim_path
        temp_dir = self.temp_dir

        drivers = drivers_for_frame(frame)
        if inkyPython := drivers.get('inkyPython'):
            vendor_folder = inkyPython.vendor_folder or ""
            os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
            shutil.copytree(
                f"../frameos/vendor/{vendor_folder}/",
                os.path.join(build_dir, "vendor", vendor_folder),
                dirs_exist_ok=True
            )
            shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
            shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)

        if inkyHyperPixel2r := drivers.get('inkyHyperPixel2r'):
            vendor_folder = inkyHyperPixel2r.vendor_folder or ""
            os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
            shutil.copytree(
                f"../frameos/vendor/{vendor_folder}/",
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
        cmd = (
            f"cd {source_dir} && nimble assets -y && nimble setup && "
            f"{nim_path} compile --os:linux --cpu:{cpu} "
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

        if waveshare := drivers.get('waveshare'):
            if waveshare.variant:
                variant_folder = get_variant_folder(waveshare.variant)

                util_files = ["DEV_Config.c", "DEV_Config.h"]
                if variant_folder != "it8951":
                    util_files.insert(0, "Debug.h")

                # color e-paper variants
                if waveshare.variant in [
                    "EPD_2in9b", "EPD_2in9c", "EPD_2in13b", "EPD_2in13c",
                    "EPD_4in2b", "EPD_4in2c", "EPD_5in83b", "EPD_5in83c",
                    "EPD_7in5b", "EPD_7in5c"
                ]:
                    c_file = re.sub(r'[bc]', 'bc', waveshare.variant)
                    variant_files = [f"{waveshare.variant}.nim", f"{c_file}.c", f"{c_file}.h"]
                elif waveshare.variant == "EPD_10in3":
                    variant_files = [f"{waveshare.variant}.nim", "IT8951.c", "IT8951.h", "IT8951.nim"]
                elif waveshare.variant == "EPD_7in3e":
                    variant_files = [f"{waveshare.variant}.nim"]
                else:
                    variant_files = [f"{waveshare.variant}.nim", f"{waveshare.variant}.c", f"{waveshare.variant}.h"]

                waveshare_files = list(dict.fromkeys(util_files + variant_files))

                for wf in waveshare_files:
                    shutil.copy(
                        os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, wf),
                        os.path.join(build_dir, wf)
                    )

        with open(os.path.join(build_dir, "Makefile"), "w") as mk:
            script_path = os.path.join(build_dir, "compile_frameos.sh")
            linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"] # Defaults just in case, Will be overridden before
            compiler_flags: list[str] = []
            with open(script_path, "r") as sc:
                lines_sc = sc.readlines()
            for line in lines_sc:
                if " -o frameos " in line and " -l" in line:
                    linker_flags = [
                        fl.strip() for fl in line.split(' ')
                        if fl.startswith('-') and fl != '-o'
                    ]
                elif " -c " in line and not compiler_flags:
                    compiler_flags = [
                        fl for fl in line.split(' ')
                        if fl.startswith('-') and not fl.startswith('-I')
                        and fl not in ['-o', '-c', '-D']
                    ]

            linker_flags = self._dedupe_preserve_order(
                linker_flags
                + ["quickjs/libquickjs.a"]
                + self._driver_linker_flags(drivers)
            )

            with open(os.path.join(source_dir, "tools", "nimc.Makefile"), "r") as mf_in:
                lines_make = mf_in.readlines()
            for ln in lines_make:
                if ln.startswith("LIBS = "):
                    ln = (
                        "LIBS = -L. "
                        + " ".join(linker_flags)
                        + " $(EXTRA_LIBS)\n"
                    )
                if ln.startswith("CFLAGS = "):
                    ln = (
                        "CFLAGS = "
                        + " ".join([f for f in compiler_flags if f != '-c'])
                        + " $(EXTRA_CFLAGS)\n"
                    )
                mk.write(ln)

        archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
        zip_base = os.path.join(temp_dir, f"build_{build_id}")
        shutil.make_archive(zip_base, 'gztar', temp_dir, f"build_{build_id}")
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

    def _get_pkgs_from_apps(self: "FrameDeployer", field: str) -> list[str]:
        extra_pkgs: set[str] = set()

        for scene in self.frame.scenes or []:
            for node in scene.get("nodes", []):
                cfg: dict | None = None

                if node.get("type") == "app":
                    kw = node.get("data", {}).get("keyword")
                    if kw:
                        try:
                            json_cfg = get_one_app_sources(kw).get("config.json")
                            if json_cfg:
                                cfg = json.loads(json_cfg)
                        except Exception:
                            pass

                elif node.get("type") == "source":
                    json_cfg = node.get("sources", {}).get("config.json")
                    if json_cfg:
                        try:
                            cfg = json.loads(json_cfg)
                        except Exception:
                            pass

                if cfg and field in cfg:
                    for pkg in cfg[field]:
                        if isinstance(pkg, str) and pkg:
                            extra_pkgs.add(pkg)

        return sorted(extra_pkgs)

    def _get_pkgs_from_all_apps(self: "FrameDeployer", field: str) -> list[str]:
        extra_pkgs: set[str] = set()
        for config in get_app_configs().values():
            if field in config:
                for pkg in config[field]:
                    if isinstance(pkg, str) and pkg:
                        extra_pkgs.add(pkg)
        return sorted(extra_pkgs)

    def get_apt_packages(self: "FrameDeployer") -> list[str]:
        apt_pkgs = self._get_pkgs_from_all_apps("apt")
        if not apt_pkgs:
            return []
        return sorted(set(apt_pkgs))
