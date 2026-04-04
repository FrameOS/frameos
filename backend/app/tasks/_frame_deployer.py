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
from app.models.frame import (
    Frame,
    get_frame_json,
    get_interpreted_scenes_json,
    uses_compiled_module_plugins,
)
from app.models.log import new_log as log
from app.utils.local_exec import exec_local_command
from app.utils.remote_exec import upload_file, run_command
from app.drivers.drivers import Driver
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.drivers.devices import drivers_for_frame
from app.models import get_apps_from_scenes
from app.codegen.drivers_nim import (
    driver_module_name_from_id,
    loadable_drivers,
    write_driver_plugin_nim,
    write_drivers_nim,
)
from app.codegen.scene_nim import (
    scene_module_name,
    write_scene_nim,
    write_scene_plugin_nim,
    write_scenes_nim,
)
from app.tasks.utils import find_nimbase_file
from app.codegen.apps_nim import write_apps_nim
from app.codegen.app_loader_nim import write_app_loader_nim

LOCAL_FRAMEOS_VENDOR_ROOT = Path(__file__).resolve().parents[3] / "frameos" / "vendor"


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

    @staticmethod
    def _plugin_linker_flags(flags: Iterable[str]) -> list[str]:
        # Dynamic plugins do not embed the QuickJS runtime.
        return FrameDeployer._dedupe_preserve_order(
            flag.strip()
            for flag in flags
            if flag.strip() and "quickjs" not in flag
        )

    @staticmethod
    def _copy_vendor_tree(source_dir: str, build_dir: str, vendor_folder: str) -> None:
        source_candidates = [
            Path(source_dir) / "vendor" / vendor_folder,
            LOCAL_FRAMEOS_VENDOR_ROOT / vendor_folder,
        ]
        source_vendor_dir = next((candidate for candidate in source_candidates if candidate.is_dir()), None)
        if source_vendor_dir is None:
            searched = ", ".join(str(candidate) for candidate in source_candidates)
            raise FileNotFoundError(f"Vendor folder '{vendor_folder}' not found. Looked in: {searched}")

        target_vendor_dir = Path(build_dir) / "vendor" / vendor_folder
        target_vendor_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            source_vendor_dir,
            target_vendor_dir,
            dirs_exist_ok=True,
        )
        shutil.rmtree(target_vendor_dir / "env", ignore_errors=True)
        shutil.rmtree(target_vendor_dir / "__pycache__", ignore_errors=True)

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

    async def _log_nim_compile_failure(
        self,
        source_dir: str,
        stdout: str,
        stderr: str,
    ) -> None:
        lines = ((stdout or "") + ("\n" + stderr if stderr else "")).splitlines()
        filtered = [ln for ln in lines if ln.strip()]
        for line in reversed(filtered):
            match = re.match(r'^(.*\.nim)\((\d+), (\d+)\),?.*', line)
            if not match:
                continue
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
            return

    @staticmethod
    def _parse_compile_script(
        script_path: str,
        *,
        output_name: str,
    ) -> tuple[list[str], list[str]]:
        linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"]
        compiler_flags: list[str] = []
        with open(script_path, "r") as sc:
            lines_sc = sc.readlines()

        for line in lines_sc:
            tokens = shlex.split(line.strip())
            if not tokens:
                continue

            if "-o" in tokens:
                out_index = tokens.index("-o")
                if out_index + 1 < len(tokens) and os.path.basename(tokens[out_index + 1]) == output_name:
                    parsed_linker_flags: list[str] = []
                    skip_next = False
                    for token in tokens[1:]:
                        if skip_next:
                            skip_next = False
                            continue
                        if token == "-o":
                            skip_next = True
                            continue
                        if token.startswith("@") or token.endswith((".o", ".obj", ".c", ".cc", ".cpp", ".cxx")):
                            continue
                        if (
                            token.startswith("-")
                            or token.endswith(".a")
                            or token.endswith(".so")
                            or ".so." in token
                        ):
                            parsed_linker_flags.append(token)
                    if parsed_linker_flags:
                        linker_flags = parsed_linker_flags
                    continue

            if "-c" in tokens and not compiler_flags:
                compiler_flags = [
                    token for token in tokens
                    if token.startswith("-")
                    and not token.startswith("-I")
                    and token not in ["-o", "-c", "-D"]
                ]
        return compiler_flags, linker_flags

    def _write_c_build_makefile(
        self,
        *,
        source_dir: str,
        target_path: str,
        executable: str,
        compiler_flags: list[str],
        linker_flags: list[str],
        compiled_scene_dirs: list[str] | None = None,
    ) -> None:
        with open(os.path.join(source_dir, "tools", "nimc.Makefile"), "r") as mf_in:
            lines_make = mf_in.readlines()

        with open(target_path, "w") as mk:
            for ln in lines_make:
                if ln.startswith("EXECUTABLE ="):
                    ln = f"EXECUTABLE = {executable}\n"
                elif ln.startswith("LIBS ="):
                    ln = "LIBS = -L. " + " ".join(linker_flags) + " $(EXTRA_LIBS)\n"
                elif ln.startswith("CFLAGS ="):
                    ln = (
                        "CFLAGS = "
                        + " ".join([f for f in compiler_flags if f != "-c"])
                        + " $(EXTRA_CFLAGS)\n"
                    )
                elif compiled_scene_dirs is not None and ln.startswith("all: "):
                    ln = "all: $(EXECUTABLE)\n\t@$(MAKE) --no-print-directory compiled-scenes\n"
                elif compiled_scene_dirs is not None and ln.startswith("clean:"):
                    ln = "clean: clean-scenes\n"
                mk.write(ln)

            if compiled_scene_dirs is None:
                return

            scene_dirs = " ".join(compiled_scene_dirs)
            mk.write("\n")
            mk.write(f"SCENE_BUILD_DIRS = {scene_dirs}\n")
            mk.write("\ncompiled-scenes:\n")
            mk.write("\t@mkdir -p scenes\n")
            mk.write('\t@if [ -n "$(strip $(SCENE_BUILD_DIRS))" ]; then \\\n')
            mk.write("\t\tfor dir in $(SCENE_BUILD_DIRS); do $(MAKE) --no-print-directory -C $$dir || exit $$?; done; \\\n")
            mk.write("\telse \\\n")
            mk.write('\t\techo "No compiled scenes to build"; \\\n')
            mk.write("\tfi\n")
            mk.write("\nclean-scenes:\n")
            mk.write('\t@if [ -n "$(strip $(SCENE_BUILD_DIRS))" ]; then \\\n')
            mk.write("\t\tfor dir in $(SCENE_BUILD_DIRS); do $(MAKE) --no-print-directory -C $$dir clean || exit $$?; done; \\\n")
            mk.write("\tfi\n")
            mk.write("\t@rm -rf scenes\n")

    async def _generate_compiled_scene_build_dirs(
        self,
        *,
        source_dir: str,
        build_dir: str,
        cpu: str,
        debug_options: str,
        nimbase_path: str,
        scene_ids: Iterable[str] | None = None,
    ) -> list[str]:
        plugin_sources = sorted(glob(os.path.join(source_dir, "src", "scenes", "plugin_*.nim")))
        if scene_ids is not None:
            selected_modules = {scene_module_name(scene_id) for scene_id in scene_ids}
            plugin_sources = [
                plugin_path
                for plugin_path in plugin_sources
                if os.path.splitext(os.path.basename(plugin_path))[0].removeprefix("plugin_") in selected_modules
            ]
        if not plugin_sources:
            return []

        os.makedirs(os.path.join(build_dir, "scenes"), exist_ok=True)
        scene_build_dirs: list[str] = []
        scene_build_root = os.path.join(build_dir, "scene_builds")

        for plugin_path in plugin_sources:
            plugin_name = os.path.splitext(os.path.basename(plugin_path))[0]
            library_name = plugin_name.removeprefix("plugin_") + ".so"
            plugin_build_dir = os.path.join(scene_build_root, os.path.splitext(library_name)[0])
            os.makedirs(plugin_build_dir, exist_ok=True)
            rel_plugin_path = os.path.relpath(plugin_path, source_dir)

            cmd = (
                f"cd {source_dir} && "
                f"{self.nim_path} compile --os:linux --cpu:{cpu} --app:lib "
                f"--compileOnly --genScript --nimcache:{plugin_build_dir} "
                f"--out:{os.path.join(plugin_build_dir, library_name)} "
                f"{debug_options} {rel_plugin_path} 2>&1"
            )
            status, out, err = await exec_local_command(
                self.db,
                self.redis,
                self.frame,
                cmd,
                log_command=False,
                log_output=False,
            )
            if status != 0:
                await self._log_nim_compile_failure(source_dir, out or "", err or "")
                raise Exception(f"Failed to generate compiled scene sources for {library_name}")

            shutil.copy(nimbase_path, os.path.join(plugin_build_dir, "nimbase.h"))
            script_candidates = glob(os.path.join(plugin_build_dir, "compile_*.sh"))
            if not script_candidates:
                raise Exception(f"Compile script missing for {library_name}")
            compiler_flags, linker_flags = self._parse_compile_script(
                script_candidates[0],
                output_name=library_name,
            )
            linker_flags = self._plugin_linker_flags(linker_flags)
            self._write_c_build_makefile(
                source_dir=source_dir,
                target_path=os.path.join(plugin_build_dir, "Makefile"),
                executable=os.path.join("..", "..", "scenes", library_name),
                compiler_flags=compiler_flags,
                linker_flags=linker_flags,
            )
            scene_build_dirs.append(os.path.relpath(plugin_build_dir, build_dir))

        return scene_build_dirs

    async def _generate_compiled_driver_build_dirs(
        self,
        *,
        source_dir: str,
        build_dir: str,
        cpu: str,
        debug_options: str,
        nimbase_path: str,
        driver_ids: Iterable[str] | None = None,
        waveshare_variant: str | None = None,
    ) -> list[str]:
        plugin_sources = sorted(glob(os.path.join(source_dir, "src", "driver_plugins", "plugin_*.nim")))
        if driver_ids is not None:
            selected_modules = {driver_module_name_from_id(driver_id) for driver_id in driver_ids}
            plugin_sources = [
                plugin_path
                for plugin_path in plugin_sources
                if os.path.splitext(os.path.basename(plugin_path))[0].removeprefix("plugin_") in selected_modules
            ]
        if not plugin_sources:
            return []

        os.makedirs(os.path.join(build_dir, "drivers"), exist_ok=True)
        driver_build_dirs: list[str] = []
        driver_build_root = os.path.join(build_dir, "driver_builds")

        for plugin_path in plugin_sources:
            plugin_name = os.path.splitext(os.path.basename(plugin_path))[0]
            library_name = plugin_name.removeprefix("plugin_") + ".so"
            plugin_build_dir = os.path.join(driver_build_root, os.path.splitext(library_name)[0])
            os.makedirs(plugin_build_dir, exist_ok=True)
            rel_plugin_path = os.path.relpath(plugin_path, source_dir)

            cmd = (
                f"cd {source_dir} && "
                f"{self.nim_path} compile --os:linux --cpu:{cpu} --app:lib "
                f"--compileOnly --genScript --nimcache:{plugin_build_dir} "
                f"--out:{os.path.join(plugin_build_dir, library_name)} "
                f"{debug_options} {rel_plugin_path} 2>&1"
            )
            status, out, err = await exec_local_command(
                self.db,
                self.redis,
                self.frame,
                cmd,
                log_command=False,
                log_output=False,
            )
            if status != 0:
                await self._log_nim_compile_failure(source_dir, out or "", err or "")
                raise Exception(f"Failed to generate compiled driver sources for {library_name}")

            shutil.copy(nimbase_path, os.path.join(plugin_build_dir, "nimbase.h"))
            if library_name.startswith("waveshare") and waveshare_variant:
                self._copy_waveshare_build_support_files(source_dir, plugin_build_dir, waveshare_variant)
            script_candidates = glob(os.path.join(plugin_build_dir, "compile_*.sh"))
            if not script_candidates:
                raise Exception(f"Compile script missing for {library_name}")
            compiler_flags, linker_flags = self._parse_compile_script(
                script_candidates[0],
                output_name=library_name,
            )
            linker_flags = self._plugin_linker_flags(linker_flags)
            self._write_c_build_makefile(
                source_dir=source_dir,
                target_path=os.path.join(plugin_build_dir, "Makefile"),
                executable=os.path.join("..", "..", "drivers", library_name),
                compiler_flags=compiler_flags,
                linker_flags=linker_flags,
            )
            driver_build_dirs.append(os.path.relpath(plugin_build_dir, build_dir))

        return driver_build_dirs

    def _copy_waveshare_build_support_files(
        self,
        source_dir: str,
        destination_dir: str,
        variant: str,
    ) -> None:
        variant_folder = get_variant_folder(variant)

        util_files = ["DEV_Config.c", "DEV_Config.h"]
        if variant_folder != "it8951":
            util_files.insert(0, "Debug.h")

        if variant in [
            "EPD_2in9b", "EPD_2in9c", "EPD_2in13b", "EPD_2in13c",
            "EPD_4in2b", "EPD_4in2c", "EPD_5in83b", "EPD_5in83c",
            "EPD_7in5b", "EPD_7in5c"
        ]:
            c_file = re.sub(r"[bc]", "bc", variant)
            variant_files = [f"{variant}.nim", f"{c_file}.c", f"{c_file}.h"]
        elif variant == "EPD_10in3":
            variant_files = [f"{variant}.nim", "IT8951.c", "IT8951.h", "IT8951.nim"]
        elif variant == "EPD_7in3e":
            variant_files = [f"{variant}.nim"]
        else:
            variant_files = [f"{variant}.nim", f"{variant}.c", f"{variant}.h"]

        waveshare_files = list(dict.fromkeys(util_files + variant_files))
        for filename in waveshare_files:
            shutil.copy(
                os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, filename),
                os.path.join(destination_dir, filename),
            )

    async def make_local_modifications(
        self,
        source_dir: str,
        *,
        drivers_override: dict[str, Driver] | None = None,
    ):
        frame = self.frame
        use_compiled_plugins = uses_compiled_module_plugins(frame)
        shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
        os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)
        shutil.rmtree(os.path.join(source_dir, "src", "driver_plugins"), ignore_errors=True)
        os.makedirs(os.path.join(source_dir, "src", "driver_plugins"), exist_ok=True)

        # find all apps
        os.makedirs(os.path.join(source_dir, "src", "apps"), exist_ok=True)
        for app_dir in glob(os.path.join(source_dir, "src", "apps", "*", "*")):
            config_path = os.path.join(app_dir, "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r") as f:
                    config = json.load(f)
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
                module_name = scene_module_name(scene.get("id", "default"))
                scene_source = write_scene_nim(frame, scene)
                with open(os.path.join(source_dir, "src", "scenes", f"scene_{module_name}.nim"), "w") as f:
                    f.write(scene_source)
                if use_compiled_plugins:
                    plugin_source = write_scene_plugin_nim(scene, is_default=bool(scene.get("default", False)))
                    with open(os.path.join(source_dir, "src", "scenes", f"plugin_{module_name}.nim"), "w") as pf:
                        pf.write(plugin_source)
            except Exception as e:
                await self.log("stderr",
                        f"Error writing scene \"{scene.get('name','')}\" "
                        f"({scene.get('id','default')}): {e}")
                raise

        with open(os.path.join(source_dir, "src", "scenes", "scenes.nim"), "w") as f:
            source = write_scenes_nim(frame, compile_into_binary=not use_compiled_plugins)
            f.write(source)

        drivers = drivers_for_frame(frame) if drivers_override is None else drivers_override
        with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as f:
            source = write_drivers_nim(drivers, use_compiled_plugins=use_compiled_plugins)
            f.write(source)

        if use_compiled_plugins:
            for driver in loadable_drivers(drivers):
                module_name = driver_module_name_from_id(driver.name if not driver.variant else f"{driver.name}/{driver.variant}")
                plugin_source = write_driver_plugin_nim(driver)
                with open(os.path.join(source_dir, "src", "driver_plugins", f"plugin_{module_name}.nim"), "w") as pf:
                    pf.write(plugin_source)

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
        arch: str,
        *,
        build_binary: bool = True,
        build_scene_ids: Iterable[str] | None = None,
        build_driver_ids: Iterable[str] | None = None,
        build_all_scenes: bool = True,
        drivers_override: dict[str, Driver] | None = None,
    ) -> str:
        db = self.db
        redis = self.redis
        frame = self.frame
        build_id = self.build_id
        nim_path = self.nim_path
        temp_dir = self.temp_dir

        drivers = drivers_for_frame(frame) if drivers_override is None else drivers_override
        use_compiled_plugins = uses_compiled_module_plugins(frame)
        if inkyPython := drivers.get('inkyPython'):
            vendor_folder = inkyPython.vendor_folder or ""
            self._copy_vendor_tree(source_dir, build_dir, vendor_folder)

        if inkyHyperPixel2r := drivers.get('inkyHyperPixel2r'):
            vendor_folder = inkyHyperPixel2r.vendor_folder or ""
            self._copy_vendor_tree(source_dir, build_dir, vendor_folder)

        cpu = await self.arch_to_nim_cpu(arch)
        debug_options = "--lineTrace:on" if frame.debug else ""
        selected_scene_ids = tuple(build_scene_ids or ())
        selected_driver_ids = tuple(build_driver_ids or ())
        build_scenes = use_compiled_plugins and (build_all_scenes or bool(selected_scene_ids))
        build_drivers = use_compiled_plugins and bool(selected_driver_ids)

        if build_binary or build_scenes:
            setup_command = f"cd {source_dir} && nimble assets -y && nimble setup"
            status, out, err = await exec_local_command(
                db,
                redis,
                frame,
                setup_command,
                log_command=False,
                log_output=False,
            )
            if status != 0:
                raise Exception(
                    "Failed to prepare Nim build sources\n"
                    f"stderr: {err or ''}\nstdout: {out or ''}"
                )

        nimbase_path = find_nimbase_file(nim_path)
        if not nimbase_path:
            raise Exception("nimbase.h not found")

        scene_build_dirs: list[str] = []
        driver_build_dirs: list[str] = []
        if build_binary:
            cmd = (
                f"cd {source_dir} && "
                f"{nim_path} compile --os:linux --cpu:{cpu} "
                f"--compileOnly --genScript --nimcache:{build_dir} "
                f"{debug_options} src/frameos.nim 2>&1"
            )

            status, out, err = await exec_local_command(
                db,
                redis,
                frame,
                cmd,
                log_command=False,
                log_output=False,
            )
            if status != 0:
                await self._log_nim_compile_failure(source_dir, out or "", err or "")
                raise Exception("Failed to generate frameos sources")

            shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

        if build_scenes:
            scene_build_dirs = await self._generate_compiled_scene_build_dirs(
                source_dir=source_dir,
                build_dir=build_dir,
                cpu=cpu,
                debug_options=debug_options,
                nimbase_path=nimbase_path,
                scene_ids=None if build_all_scenes else selected_scene_ids,
            )

        if build_drivers:
            waveshare_driver = drivers.get("waveshare")
            driver_build_dirs = await self._generate_compiled_driver_build_dirs(
                source_dir=source_dir,
                build_dir=build_dir,
                cpu=cpu,
                debug_options=debug_options,
                nimbase_path=nimbase_path,
                driver_ids=selected_driver_ids,
                waveshare_variant=waveshare_driver.variant if waveshare_driver else None,
            )

        if build_binary:
            script_path = os.path.join(build_dir, "compile_frameos.sh")
            compiler_flags, linker_flags = self._parse_compile_script(
                script_path,
                output_name="frameos",
            )
            linker_flags = self._dedupe_preserve_order(
                linker_flags
                + ["quickjs/libquickjs.a"]
            )
            self._write_c_build_makefile(
                source_dir=source_dir,
                target_path=os.path.join(build_dir, "Makefile"),
                executable="frameos",
                compiler_flags=compiler_flags,
                linker_flags=linker_flags,
                compiled_scene_dirs=scene_build_dirs if use_compiled_plugins and build_all_scenes else None,
            )

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
