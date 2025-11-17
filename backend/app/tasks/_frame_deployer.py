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
from typing import Optional
from gzip import compress

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.apps import get_one_app_sources
from app.models.frame import Frame, get_frame_json, get_interpreted_scenes_json
from app.models.log import new_log as log
from app.utils.local_exec import exec_local_command
from app.utils.remote_exec import upload_file, run_command
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.drivers.devices import drivers_for_frame
from app.models import get_apps_from_scenes
from app.codegen.drivers_nim import write_drivers_nim
from app.codegen.scene_nim import write_scene_nim, write_scenes_nim
from app.tasks.utils import find_nimbase_file
from app.models.settings import get_settings_dict
from app.codegen.apps_nim import write_apps_nim
from app.codegen.app_loader_nim import write_app_loader_nim

BYTES_PER_MB   = 1_048_576
DEFAULT_CHUNK  = 25 * BYTES_PER_MB

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

    async def _store_paths_missing(self, paths: list[str]) -> list[str]:
        """
        Return *only* those paths that are **missing** from /nix/store on the
        frame.  All paths are checked in a single SSH exec.
        """
        if not paths:
            return []

        # Quote every path once; the remote loop echoes the missing ones.
        joined = " ".join(shlex.quote(p) for p in paths)
        script = "for p; do [ -e \"$p\" ] || echo \"$p\"; done"
        out: list[str] = []
        await self.exec_command(
            f"bash -s -- {joined} <<'EOF'\n{script}\nEOF",
            output=out,
            raise_on_error=False,
            log_command=f"bash -s -- **SKIPPED** <<'EOF'\n{script}\nEOF",
            log_output=False,
        )
        # Every line produced by the loop is a missing store path.
        return [p.strip() for p in out if p.strip()]

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

    async def nix_upload_path_and_deps(
        self: "FrameDeployer",
        path: str,
        max_chunk_size: int = DEFAULT_CHUNK,
    ) -> int: # return number of uploaded items
        """
        Export the full runtime closure of *path* and import it on the target
        machine, but bundle the nar streams so that at most `max_chunk_size`
        bytes are transferred per upload (≈25 MiB by default).

        The implementation relies on
        - `nix path-info --json` to get the *narSize* of every path once,
        - `nix-store --export …` to export many store paths into one .nar file,
        - `nix-store --import` on the device to unpack an entire chunk.

        Limitations:
        - OOMS with very large closures (500MB+ on a pi zero 2)
        """
        await self.log("stdout", f"- Collecting runtime closure for {path}")

        # 1. Get complete closure
        status, paths_out, err = await exec_local_command(
            self.db, self.redis, self.frame, f"nix-store -qR {path}", log_output=False
        )
        if status:
            raise RuntimeError(f"Failed to collect closure: {err}")

        runtime_paths = (paths_out or "").strip().splitlines()
        await self.log("stdout", f"  → {len(runtime_paths)} store paths")

        # 2. Filter out paths that are already present on the device
        missing = await self._store_paths_missing(runtime_paths)
        if not missing:
            await self.log("stdout", "  → No missing store paths, skipping upload")
            return 0
        await self.log(
            "stdout",
            f"  → {len(missing)} paths need upload; bundling in ≤{max_chunk_size // BYTES_PER_MB} MiB chunks"
        )

        # 3. Query nar sizes once for all paths
        cmd = ["nix", "path-info", "--json", *missing]
        status, size_json, err = await exec_local_command(
            self.db, self.redis, self.frame, " ".join(cmd), log_output=False
        )
        if status:
            raise RuntimeError(f"nix path-info failed: {err}")

        size_info: dict[str, int] = {}
        info = json.loads(size_json or "{}")

        if isinstance(info, dict):
            # `info` maps path → metadata
            for p, meta in info.items():
                # prefer `narSize` (current), fall back to legacy `nar`
                size_info[p] = int(meta.get("narSize") or meta.get("nar") or 0)
        else:  # older nix (<2.4) returned a list
            for meta in info:                          # type: ignore[arg-type]
                size_info[meta["path"]] = int(meta.get("narSize") or meta.get("nar") or 0)

        # 4. Greedily pack paths up to ~max_chunk_size each
        chunks: list[list[str]] = []
        current: list[str] = []
        current_size = 0
        for p in missing:
            nar_size = size_info.get(p, 0)
            # start new chunk if adding would overflow (but always put at least one)
            if current and current_size + nar_size > max_chunk_size:
                chunks.append(current)
                current, current_size = [], 0
            current.append(p)
            current_size += nar_size
        if current:
            chunks.append(current)

        await self.log("stdout", f"  → Uploading in {len(chunks)} chunk(s)")

        remote_tmp = f"/tmp/frameos_import_{self.build_id}"
        await self.exec_command(f"mkdir -p {remote_tmp}")

        try:
            for i, chunk in enumerate(chunks, 1):
                with tempfile.TemporaryDirectory() as tmpdir:
                    nar_local = Path(tmpdir) / f"chunk_{i}.nar"
                    export_cmd = f"nix-store --export {' '.join(shlex.quote(p) for p in chunk)} > {nar_local}"
                    status, _, err = await exec_local_command(
                        self.db, self.redis, self.frame, export_cmd
                    )
                    if status:
                        raise RuntimeError(f"Export failed for chunk {i}: {err}")

                    # 5. Ship and import the chunk
                    remote_nar = f"{remote_tmp}/chunk_{i}.nar"
                    with open(nar_local, "rb") as fh:
                        await upload_file(
                            self.db, self.redis, self.frame, remote_nar, fh.read()
                        )

                    await self.exec_command(
                        f"sudo nix-store --import < {remote_nar} && rm {remote_nar}"
                    )
                    await self.log(
                        "stdout",
                        f"🍀 imported chunk {i}/{len(chunks)} 🍀 "
                        f"({len(chunk)} paths, {math.ceil(nar_local.stat().st_size/BYTES_PER_MB)} MiB)"
                    )
        finally:
            await self.exec_command(f"rm -rf {remote_tmp}")

        return len(missing)

    async def get_hostname(self) -> str:
        hostname_out: list[str] = []
        await self.exec_command("hostname", hostname_out)
        target_host = hostname_out[0].strip() or "frame-unknown"
        return target_host

    async def get_distro(self) -> str:
        distro_out: list[str] = []
        await self.exec_command(
            "bash -c '"
            "if [ -e /etc/nixos/version ]; then echo nixos ; "
            "elif [ -f /etc/rpi-issue ] || grep -q \"^ID=raspbian\" /etc/os-release ; then echo raspios ; "
            "else . /etc/os-release ; echo ${ID:-unknown} ; "
            "fi'",
            distro_out
        )
        distro = distro_out[0].strip().lower()
        return distro if distro else "unknown"

    async def get_distro_version(self) -> str:
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
            log_output=False,
        )
        version = version_out[0].strip().lower() if version_out else ""
        return version or "unknown"

    async def get_total_memory_mb(self) -> int:
        mem_output: list[str] = []
        await self.exec_command(
            "grep MemTotal /proc/meminfo | awk '{print $2}'",
            mem_output,
        )
        kib = int(mem_output[0].strip()) if mem_output else 0 # kB from the kernel
        total_memory = kib // 1024 # MiB
        return total_memory

    async def get_cpu_architecture(self) -> str:
        uname_output: list[str] = []
        await self.exec_command("uname -m", uname_output)
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
            if frame.debug:
                await self.log("stdout", f"Generated scenes.nim (showing because debug=true):\n{source}")

        drivers = drivers_for_frame(frame)
        with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as f:
            source = write_drivers_nim(drivers)
            f.write(source)
            if frame.debug:
                await self.log("stdout", f"Generated drivers.nim:\n{source}")

        if drivers.get("waveshare"):
            with open(os.path.join(source_dir, "src", "drivers", "waveshare", "driver.nim"), "w") as wf:
                source = write_waveshare_driver_nim(drivers)
                wf.write(source)
                if frame.debug:
                    await self.log("stdout", f"Generated waveshare driver:\n{source}")

        await self._update_flake_with_frame_settings(source_dir)

    async def _update_flake_with_frame_settings(self, src: str) -> None:
        def q(val: str) -> str:
            return json.dumps(str(val))

        drivers = drivers_for_frame(self.frame)
        all_settings = get_settings_dict(self.db)
        frame_nix = self.frame.nix or {}
        hostname = frame_nix.get("hostname") or f"frame{self.frame.id}"
        timezone = frame_nix.get("timezone") or "UTC"
        platform  = frame_nix.get("platform") or "pi-zero2"

        ### nixos/modules/overrides.nix
        lines: list[str] = ["{ lib, pkgs, self, ... }:", "{"]
        lines.extend([
            f"  networking.hostName = {q(hostname)};",
            f"  time.timeZone       = {q(timezone)};",
        ])

        # ssh and user/pass
        ssh_pass = (self.frame.ssh_pass or "")
        ssh_port = int(self.frame.ssh_port or 22)
        if ssh_port != 22:
            lines.append(f"  services.openssh.port = {ssh_port};")
        if ssh_pass:
            lines.append(f"  users.users.frame.password = {q(ssh_pass)};")
        if key := all_settings.get("ssh_keys", {}).get("default_public"):
            lines.append(
                f"  users.users.frame.openssh.authorizedKeys.keys = [ {q(key)} ];")

        # reboot
        reboot_cfg = self.frame.reboot or {}
        if reboot_cfg.get("enabled", "true") == "true":
            reboot_cron = reboot_cfg.get("crontab", "4 0 * * *")
            cron_parts = reboot_cron.split(" ")
            # only hours and minutes are supported
            cron_hour = cron_parts[0]
            cron_minute = cron_parts[1]
            if not cron_hour.isdigit() or not cron_minute.isdigit() or \
               not (0 <= int(cron_hour) < 24) or not (0 <= int(cron_minute) < 60):
                cron_hour = "04"
                cron_minute = "00"
            if len(cron_hour) < 2:
                cron_hour = "0" + cron_hour
            if len(cron_minute) < 2:
                cron_minute = "0" + cron_minute

            reboot_calendar = f"*-*-* {cron_hour}:{cron_minute}:00"
            reboot_type = reboot_cfg.get("type", "frameos")  # frameos | raspberry
            cron_cmd = ("systemctl restart frameos.service" if reboot_type == "frameos" else "shutdown -r now")

            lines.extend([
                "",
                "  # Nightly reboot (cron)",
                "  systemd.timers.frameosReboot = {",
                "    wantedBy  = [ \"timers.target\" ];",
                "    after     = [ \"network.target\" ];",
                "    timerConfig = { OnCalendar = " + q(reboot_calendar) + "; Persistent = true; };",
                "  };",
                "  systemd.services.frameosReboot = {",
                "    serviceConfig.ExecStart = \"" + cron_cmd + "\";",
                "  };",
            ])

        # network / wifi
        network_cfg = self.frame.network or {}
        wifi_ssid  = (network_cfg.get("wifiSSID") or "").rstrip()
        wifi_pass  = (network_cfg.get("wifiPassword") or "").rstrip()
        if wifi_ssid and wifi_pass:
            lines.extend([
                "",
                "  # Wi-Fi configuration (NetworkManager)",
                "  environment.etc.\"NetworkManager/system-connections/frameos-default.nmconnection\" = {",
                "    user  = \"root\"; group = \"root\"; mode = \"0600\";",
                "    text  = ''",
                "      [connection]",
                "      id=frameos-default",
                "      uuid=d96b6096-93a5-4c39-9f5c-6bb64bb97f7b",
                "      type=wifi",
                "      interface-name=wlan0",
                "      autoconnect=true",
                "      [wifi]",
                f"      ssid={wifi_ssid}",
                "      mode=infrastructure",
                "      [wifi-security]",
                "      key-mgmt=wpa-psk",
                f"      psk={wifi_pass}",
                "      [ipv4]",
                "      method=auto",
                "      never-default=false",
                "      [ipv6]",
                "      method=auto",
                "    '';",
                "  };"
            ])

        # nixpkgs
        if extra_nixpkgs := self.get_nixpkgs():
            lines.extend([
                "",
                "  # Extra packages requested by apps (config.json → nixpkgs)",
                "  environment.systemPackages = lib.mkAfter (with pkgs; ["
            ])
            for pkg in sorted(extra_nixpkgs):
                lines.append(f"    {pkg}")
            lines.extend([
                "  ]);"
            ])

        # ─── Vendor blobs for Inky/Pimoroni drivers (not fully working yet)
        vendor_pkgs: list[str] = []
        vendor_tmpfiles: list[str] = []

        if drivers.get("inkyPython"):
            vendor_pkgs.append("self.packages.${pkgs.system}.inkyPython")
            vendor_tmpfiles.append(
                "C /srv/frameos/vendor/inkyPython 0755 frame users - ${self.packages.${pkgs.system}.inkyPython}"
            )

        if drivers.get("inkyHyperPixel2r"):
            vendor_pkgs.append("self.packages.${pkgs.system}.inkyHyperPixel2r")
            vendor_tmpfiles.append(
                "C /srv/frameos/vendor/inkyHyperPixel2r 0755 frame users - ${self.packages.${pkgs.system}.inkyHyperPixel2r}"
            )

        if vendor_pkgs:
            lines.extend([
                "",
                "  # Runtime blobs for Inky / HyperPixel",
                "  environment.systemPackages = lib.mkAfter (with pkgs; [",
            ])
            for p in vendor_pkgs:
                lines.append(f"    {p}")
            lines.extend([
                "  ]);",
                "",
                "  systemd.tmpfiles.rules = lib.mkAfter [",
            ])
            for rule in vendor_tmpfiles:
                lines.append(f"    {q(rule)}")
            lines.append("  ];")

        lines.append("}")

        ### nixos/modules/overrides.nix (new file)

        nixos_mod_dir = os.path.join(src, "nixos", "modules")
        override_path = os.path.join(nixos_mod_dir, "overrides.nix")
        with open(override_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

        ### nixos/modules/hardware/pi-xxxx.nix (add overlays)

        overlay_modules: list[str] = []
        if drivers.get("i2c"):
            overlay_modules.append("i2c")
        if drivers.get("spi"):
            # TODO: figure out what do we need here for which device
            # overlay_modules.append("spi0-0cs-low")
            # overlay_modules.append("spi0-1cs")
            overlay_modules.append("spi0-2cs")
        elif drivers.get("noSpi"):
            if self.frame.device == "waveshare.EPD_13in3e":
                overlay_modules.append("spi0-0cs-low")
        if overlay_modules:
            hw_file = os.path.join(nixos_mod_dir, "hardware", f"{platform}.nix")
            with open(hw_file, "r", encoding="utf-8") as fh:
                hw_src = fh.read()

            # find the placeholder *once* and replace the whole list
            new_overlays = "\n        ".join(
                f"(import ./overlays/{m}.nix)" for m in overlay_modules
            )
            hw_src = re.sub(
                r"#\!\- IMPORT OVERLAYS HERE \-!\#[\s\S]*?\n",
                new_overlays + "\n",
                hw_src,
                flags=re.M,
            )
            with open(hw_file, "w", encoding="utf-8") as fh:
                fh.write(hw_src)

        ### nixos/modules/custom.nix (new file)
        if frame_nix.get("customModule"):
            custom_module_path = os.path.join(nixos_mod_dir, "custom.nix")
            with open(custom_module_path, "w", encoding="utf-8") as fh:
                fh.write(frame_nix["customModule"] + "\n")

        ### nixos/modules/frameos.nix (find/replace)

        assets_path = (self.frame.assets_path or "/srv/assets").rstrip("/")
        if assets_path != "/srv/assets" and json.dumps(assets_path) == '"' + assets_path + '"':
            frameos_nix_path = os.path.join(nixos_mod_dir, "frameos.nix")
            with open(frameos_nix_path, "r", encoding="utf-8") as fh:
                frameos_nix = fh.read()
            frameos_nix = frameos_nix.replace("/srv/assets", assets_path)
            with open(frameos_nix_path, "w", encoding="utf-8") as fh:
                fh.write(frameos_nix)

        ### flake.nix (find/replace)

        flake_path = os.path.join(src, "flake.nix")
        with open(flake_path, "r", encoding="utf-8") as fh:
            flake = fh.read()
        flake = flake.replace("self.nixosModules.hardware.pi-zero2", f"self.nixosModules.hardware.{platform}")
        with open(flake_path, "w", encoding="utf-8") as fh:
            fh.write(flake)

    def create_local_source_folder(self, temp_dir: str, source_root: str | None = None) -> str:
        source_dir = os.path.join(temp_dir, "frameos")
        os.makedirs(source_dir, exist_ok=True)
        base = Path(source_root or "../frameos").resolve()
        shutil.copytree(base, source_dir, dirs_exist_ok=True)
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
            "- Generating C sources from Nim sources.",
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
            lines = (out or "").split("\n")
            filtered = [ln for ln in lines if ln.strip()]
            if filtered:
                last_line = filtered[-1]
                match = re.match(r'^(.*\.nim)\((\d+), (\d+)\),?.*', last_line)
                if match:
                    fn = match.group(1)
                    line_nr = int(match.group(2))
                    column = int(match.group(3))
                    source_abs = os.path.realpath(source_dir)
                    final_path = os.path.realpath(os.path.join(source_dir, fn))
                    if os.path.commonprefix([final_path, source_abs]) == source_abs:
                        rel_fn = final_path[len(source_abs) + 1:]
                        with open(final_path, "r") as of:
                            all_lines = of.readlines()
                        await self.log("stdout", f"Error in {rel_fn}:{line_nr}:{column}")
                        await self.log("stdout", f"Line {line_nr}: {all_lines[line_nr - 1]}")
                        await self.log("stdout", f".......{'.'*(column - 1 + len(str(line_nr)))}^")
                    else:
                        await self.log("stdout", f"Error in {fn}:{line_nr}:{column}")

            raise Exception("Failed to generate frameos sources")

        nimbase_path = find_nimbase_file(nim_path)
        if not nimbase_path:
            raise Exception("nimbase.h not found")

        shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

        if waveshare := drivers.get('waveshare'):
            if waveshare.variant:
                variant_folder = get_variant_folder(waveshare.variant)

                if variant_folder == "it8951":
                    util_files = ["DEV_Config.c", "DEV_Config.h"]
                else:
                    util_files = ["Debug.h", "DEV_Config.c", "DEV_Config.h"]

                for uf in util_files:
                    shutil.copy(
                        os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, uf),
                        os.path.join(build_dir, uf)
                    )

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

                for vf in variant_files:
                    shutil.copy(
                        os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, vf),
                        os.path.join(build_dir, vf)
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

            # add quickjs lib. this was just removed in the step above, but we know it's needed
            linker_flags += ["quickjs/libquickjs.a"]

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
        extra_nixpkgs: set[str] = set()

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
                            extra_nixpkgs.add(pkg)

        return sorted(extra_nixpkgs)

    def get_apt_packages(self: "FrameDeployer") -> list[str]:
        apt_pkgs = self._get_pkgs_from_apps("apt")
        if not apt_pkgs:
            return []
        return sorted(set(apt_pkgs))

    def get_nixpkgs(self: "FrameDeployer") -> list[str]:
        nix_pkgs = self._get_pkgs_from_apps("nixpkgs")
        if not nix_pkgs:
            return []
        return sorted(set(nix_pkgs))