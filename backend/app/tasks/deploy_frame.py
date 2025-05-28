from datetime import datetime, timezone
import json
import os
import random
import re
import shutil
import string
import tempfile
from typing import Any, Optional

import asyncssh

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.codegen.drivers_nim import write_drivers_nim
from app.codegen.scene_nim import write_scene_nim, write_scenes_nim
from app.drivers.devices import drivers_for_frame
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.models import get_apps_from_scenes
from app.models.assets import sync_assets
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection, exec_local_command
from app.models.apps import get_one_app_sources

from .utils import find_nim_v2, find_nimbase_file

async def deploy_frame(id: int, redis: Redis):
    await redis.enqueue_job("deploy_frame", id=id)

class FrameDeployer:
    ## This entire file is a big refactor in progress.
    def __init__(self, db: Session, redis: Redis, frame: Frame, nim_path: str, temp_dir: str, ssh: asyncssh.SSHClientConnection):
        self.db = db
        self.redis = redis
        self.frame = frame
        self.nim_path = nim_path
        self.temp_dir = temp_dir
        self.ssh = ssh
        self.build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))

    def has_agent_connection(self) -> bool:
        return self.frame.network and self.frame.network.get('agentConnection', False) and len(str(self.frame.network.get('agentSharedSecret', ''))) > 0

    async def exec_command(
        self,
        command: str,
        output: Optional[list[str]] = None,
        log_output: bool = True,
        raise_on_error: bool = True
    ) -> int:
        return await exec_command(
            self.db, self.redis, self.frame, self.ssh,
            command, output=output, log_output=log_output, raise_on_error=raise_on_error
        )

    async def log(self, type: str, line: str, timestamp: Optional[datetime] = None):
        await log(self.db, self.redis, int(self.frame.id), type=type, line=line, timestamp=timestamp)


async def deploy_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    frame = db.get(Frame, id)
    if not frame:
        raise Exception("Frame not found")

    try:
        if not frame.scenes or len(frame.scenes) == 0:
            raise Exception("You must have at least one installed scene to deploy.")

        if frame.status == 'deploying':
            raise Exception("Already deploying. Request again to force redeploy.")

        frame_dict = frame.to_dict() # persisted as frame.last_successful_deploy if successful
        if "last_successful_deploy" in frame_dict:
            del frame_dict["last_successful_deploy"]
        if "last_successful_deploy_at" in frame_dict:
            del frame_dict["last_successful_deploy_at"]

        frame.status = 'deploying'
        await update_frame(db, redis, frame)

        nim_path = find_nim_v2()
        ssh = await get_ssh_connection(db, redis, frame)

        async def install_if_necessary(pkg: str, raise_on_error=True) -> int:
            search_strings = ["run apt-get update", "404 Not Found", "failed to fetch", "Unable to fetch some archives"]
            output: list[str] = []
            response = await self.exec_command(
                f"dpkg -l | grep -q \"^ii  {pkg} \" || sudo apt-get install -y {pkg}",
                raise_on_error=False,
                output=output
            )
            if response != 0:
                combined_output = "".join(output)
                if any(s in combined_output for s in search_strings):
                    await self.log("stdout", f"- Installing {pkg} failed. Trying to update apt.")
                    response = await self.exec_command(
                        "sudo apt-get update && sudo apt-get install -y " + pkg,
                        raise_on_error=raise_on_error
                    )
                    if response != 0: # we propably raised above
                        await self.log("stdout", f"- Installing {pkg} failed again.")
            return response

        with tempfile.TemporaryDirectory() as temp_dir:
            self = FrameDeployer(db=db, redis=redis, frame=frame, nim_path=nim_path, temp_dir=temp_dir, ssh=ssh)
            build_id = self.build_id
            await self.log("stdout", f"Deploying frame {frame.name} with build id {self.build_id}")

            await self.log("stdout", "- Getting target architecture")
            uname_output: list[str] = []
            await self.exec_command("uname -m", uname_output)
            arch = "".join(uname_output).strip()
            if arch in ("aarch64", "arm64"):
                cpu = "arm64"
            elif arch in ("armv6l", "armv7l"):
                cpu = "arm"
            elif arch == "i386":
                cpu = "i386"
            else:
                cpu = "amd64"

            total_memory = 0
            try:
                mem_output: list[str] = []
                await self.exec_command("free -m", mem_output)
                total_memory = int(mem_output[1].split()[1])  # line 1 => "Mem:  ... 991  ..."
            except Exception as e:
                await self.log("stderr", str(e))
            low_memory = total_memory < 512

            drivers = drivers_for_frame(frame)

            # 1. Create build tar.gz locally
            await self.log("stdout", "- Copying build folders")
            build_dir, source_dir = create_build_folders(temp_dir, build_id)
            await self.log("stdout", "- Applying local modifications")
            await make_local_modifications(self, source_dir)
            await self.log("stdout", "- Creating build archive")
            archive_path = await create_local_build_archive(self, build_dir, source_dir, cpu)

            if low_memory:
                await self.log("stdout", "- Low memory device, stopping FrameOS for compilation")
                await self.exec_command("sudo service frameos stop", raise_on_error=False)

            # 2. Remote steps
            await install_if_necessary("ntp")
            await install_if_necessary("build-essential")
            await install_if_necessary("hostapd")

            if drivers.get("evdev"):
                await install_if_necessary("libevdev-dev")

            if drivers.get("waveshare") or drivers.get("gpioButton"):
                check_lgpio = await self.exec_command(
                    '[[ -f "/usr/local/include/lgpio.h" || -f "/usr/include/lgpio.h" ]] && exit 0 || exit 1',
                    raise_on_error=False
                )
                if check_lgpio != 0:
                    # Try installing liblgpio-dev
                    if await install_if_necessary("liblgpio-dev", raise_on_error=False) != 0:
                        await self.log("stdout", "--> Could not find liblgpio-dev. Installing from source.")
                        command = (
                            "if [ ! -f /usr/local/include/lgpio.h ]; then "
                            "  rm -rf /tmp/lgpio-install && "
                            "  mkdir -p /tmp/lgpio-install && "
                            "  cd /tmp/lgpio-install && "
                            "  wget -q -O v0.2.2.tar.gz https://github.com/joan2937/lg/archive/refs/tags/v0.2.2.tar.gz && "
                            "  tar -xzf v0.2.2.tar.gz && "
                            "  cd lg-0.2.2 && "
                            "  make && "
                            "  sudo make install && "
                            "  sudo rm -rf /tmp/lgpio-install; "
                            "fi"
                        )
                        await self.exec_command(command)

            # Any app dependencies
            all_deps = set()
            for scene in frame.scenes:
                try:
                    for node in scene.get('nodes', []):
                        try:
                            config: Optional[dict[str, str]] = None
                            if node.get('type') == 'app':
                                app = node.get('data', {}).get('keyword')
                                if app:
                                    json_config = get_one_app_sources(app).get('config.json')
                                    if json_config:
                                        config = json.loads(json_config)
                            if node.get('type') == 'source':
                                json_config = node.get('sources', {}).get('config.json')
                                if json_config:
                                    config = json.loads(json_config)
                            if config:
                                if config.get('apt'):
                                    for dep in config['apt']:
                                        all_deps.add(dep)
                        except Exception as e:
                            await self.log("stderr", f"Error parsing node: {e}")
                except Exception as e:
                    await self.log("stderr", f"Error parsing scene: {e}")
            for dep in all_deps:
                await install_if_necessary(dep)

            # Ensure /srv/frameos
            await self.exec_command(
                "if [ ! -d /srv/frameos/ ]; then "
                "  sudo mkdir -p /srv/frameos/ && sudo chown $(whoami):$(whoami) /srv/frameos/; "
                "fi"
            )

            await self.exec_command("mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
            await self.log("stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")

            # 3. Upload the local tarball
            await asyncssh.scp(
                archive_path,
                (ssh, f"/srv/frameos/build/build_{build_id}.tar.gz"),
                recurse=False
            )

            # Unpack & compile on device
            await self.exec_command(f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz")
            await self.exec_command(
                f"cd /srv/frameos/build/build_{build_id} && "
                "PARALLEL_MEM=$(awk '/MemTotal/{printf \"%.0f\\n\", $2/1024/250}' /proc/meminfo) && "
                "PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && "
                "make -j$PARALLEL"
            )

            await self.exec_command(f"mkdir -p /srv/frameos/releases/release_{build_id}")
            await self.exec_command(
                f"cp /srv/frameos/build/build_{build_id}/frameos "
                f"/srv/frameos/releases/release_{build_id}/frameos"
            )

            # 4. Upload frame.json using a TEMP FILE approach
            frame_json_data = (json.dumps(get_frame_json(db, frame), indent=4) + "\n").encode('utf-8')
            with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmpf:
                local_json_path = tmpf.name
                tmpf.write(frame_json_data)
            await asyncssh.scp(
                local_json_path, (ssh, f"/srv/frameos/releases/release_{build_id}/frame.json"),
                recurse=False
            )
            os.remove(local_json_path)  # remove local temp file
            await self.log("stdout", f"> add /srv/frameos/releases/release_{build_id}/frame.json")

            # Driver-specific vendor steps
            if inkyPython := drivers.get("inkyPython"):
                await self.exec_command(
                    f"mkdir -p /srv/frameos/vendor && "
                    f"cp -r /srv/frameos/build/build_{build_id}/vendor/inkyPython /srv/frameos/vendor/"
                )
                await install_if_necessary("python3-pip")
                await install_if_necessary("python3-venv")
                await self.exec_command(
                    f"cd /srv/frameos/vendor/{inkyPython.vendor_folder} && "
                    "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                    "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                    "(echo '> env/bin/pip3 install -r requirements.txt' && "
                    "env/bin/pip3 install -r requirements.txt && "
                    "sha256sum requirements.txt > requirements.txt.sha256sum))"
                )

            if inkyHyperPixel2r := drivers.get("inkyHyperPixel2r"):
                await self.exec_command(
                    f"mkdir -p /srv/frameos/vendor && "
                    f"cp -r /srv/frameos/build/build_{build_id}/vendor/inkyHyperPixel2r /srv/frameos/vendor/"
                )
                await install_if_necessary("python3-dev")
                await install_if_necessary("python3-pip")
                await install_if_necessary("python3-venv")
                await self.exec_command(
                    f"cd /srv/frameos/vendor/{inkyHyperPixel2r.vendor_folder} && "
                    "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                    "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                    "(echo '> env/bin/pip3 install -r requirements.txt' && "
                    "env/bin/pip3 install -r requirements.txt && "
                    "sha256sum requirements.txt > requirements.txt.sha256sum))"
                )

            # 5. Upload frameos.service with a TEMP FILE approach
            with open("../frameos/frameos.service", "r") as f:
                service_contents = f.read().replace("%I", frame.ssh_user)
            service_data = service_contents.encode('utf-8')
            with tempfile.NamedTemporaryFile(suffix=".service", delete=False) as tmpservice:
                local_service_path = tmpservice.name
                tmpservice.write(service_data)
            await asyncssh.scp(
                local_service_path,
                (ssh, f"/srv/frameos/releases/release_{build_id}/frameos.service"),
                recurse=False
            )
            os.remove(local_service_path)

            await self.exec_command(
                f"mkdir -p /srv/frameos/state && ln -s /srv/frameos/state "
                f"/srv/frameos/releases/release_{build_id}/state"
            )
            await self.exec_command(
                f"sudo cp /srv/frameos/releases/release_{build_id}/frameos.service "
                f"/etc/systemd/system/frameos.service"
            )
            await self.exec_command("sudo chown root:root /etc/systemd/system/frameos.service")
            await self.exec_command("sudo chmod 644 /etc/systemd/system/frameos.service")

            # 6. Link new release
            await self.exec_command(
                f"rm -rf /srv/frameos/current && "
                f"ln -s /srv/frameos/releases/release_{build_id} /srv/frameos/current"
            )

            # Figure out the difference between /srv/assets and the local assets folder
            await sync_assets(db, redis, frame, ssh)

            # Clean old builds
            await self.exec_command("cd /srv/frameos/build && ls -dt1 build_* | tail -n +11 | xargs rm -rf")
            await self.exec_command("cd /srv/frameos/build/cache && find . -type f \\( -atime +0 -a -mtime +0 \\) | xargs rm -rf")
            await self.exec_command(
                "cd /srv/frameos/releases && "
                "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" "
                "| tail -n +11 | xargs rm -rf"
            )

        boot_config = "/boot/config.txt"
        if await self.exec_command("test -f /boot/firmware/config.txt", raise_on_error=False) == 0:
            boot_config = "/boot/firmware/config.txt"

        # Additional device config
        if drivers.get("i2c"):
            await self.exec_command(
                'grep -q "^dtparam=i2c_vc=on$" ' + boot_config + ' '
                '|| echo "dtparam=i2c_vc=on" | sudo tee -a ' + boot_config
            )
            await self.exec_command(
                'command -v raspi-config > /dev/null && '
                'sudo raspi-config nonint get_i2c | grep -q "1" && { '
                '  sudo raspi-config nonint do_i2c 0; echo "I2C enabled"; '
                '} || echo "I2C already enabled"'
            )

        if drivers.get("spi"):
            await self.exec_command('sudo raspi-config nonint do_spi 0')
        elif drivers.get("noSpi"):
            await self.exec_command('sudo raspi-config nonint do_spi 1')

        if low_memory:
            await self.exec_command(
                "sudo systemctl mask apt-daily-upgrade && "
                "sudo systemctl mask apt-daily && "
                "sudo systemctl disable apt-daily.service apt-daily.timer apt-daily-upgrade.timer apt-daily-upgrade.service"
            )

        if frame.reboot and frame.reboot.get('enabled') == 'true':
            cron_schedule = frame.reboot.get('crontab', '0 0 * * *')
            if frame.reboot.get('type') == 'raspberry':
                crontab = f"{cron_schedule} root /sbin/shutdown -r now"
            else:
                crontab = f"{cron_schedule} root systemctl restart frameos.service"
            await self.exec_command(                               f"echo '{crontab}' | sudo tee /etc/cron.d/frameos-reboot")
        else:
            await self.exec_command("sudo rm -f /etc/cron.d/frameos-reboot")

        must_reboot = False
        if drivers.get("bootconfig"):
            for line in drivers["bootconfig"].lines:
                if await self.exec_command(                                      f'grep -q "^{line}" ' + boot_config, raise_on_error=False) != 0:
                    await self.exec_command(command=f'echo "{line}" | sudo tee -a ' + boot_config, log_output=False)
                    must_reboot = True

        await self.exec_command("sudo systemctl daemon-reload")
        await self.exec_command("sudo systemctl enable frameos.service")
        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)

        if must_reboot:
            await update_frame(db, redis, frame)
            await self.log("stdinfo", "Deployed! Rebooting device after boot config changes")
            await self.exec_command("sudo reboot")
        else:
            await self.exec_command("sudo systemctl restart frameos.service")
            await self.exec_command("sudo systemctl status frameos.service")
            await update_frame(db, redis, frame)

    except Exception as e:
        await self.log("stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
    finally:
        if ssh is not None:
            await remove_ssh_connection(db, redis, ssh, frame)


def create_build_folders(temp_dir, build_id):
    build_dir = os.path.join(temp_dir, f"build_{build_id}")
    source_dir = os.path.join(temp_dir, "frameos")
    os.makedirs(source_dir, exist_ok=True)
    shutil.copytree("../frameos", source_dir, dirs_exist_ok=True)
    os.makedirs(build_dir, exist_ok=True)
    return build_dir, source_dir


async def make_local_modifications(self: FrameDeployer, source_dir: str):
    frame = self.frame
    shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
    os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

    for node_id, sources in get_apps_from_scenes(list(frame.scenes)).items():
        app_id = "nodeapp_" + node_id.replace('-', '_')
        app_dir = os.path.join(source_dir, "src", "apps", app_id)
        os.makedirs(app_dir, exist_ok=True)
        for filename, code in sources.items():
            with open(os.path.join(app_dir, filename), "w") as f:
                f.write(code)

    for scene in frame.scenes:
        try:
            scene_source = write_scene_nim(frame, scene)
            safe_id = re.sub(r'\W+', '', scene.get('id', 'default'))
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
            await self.log("stdout", f"Generated scenes.nim:\n{source}")

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


async def create_local_build_archive(
    self: FrameDeployer,
    build_dir: str,
    source_dir: str,
    cpu: str
):
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

    await self.log("stdout",
              "- No cross compilation. Generating source code for compilation on frame.")

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
            else:
                variant_files = [f"{waveshare.variant}.nim", f"{waveshare.variant}.c", f"{waveshare.variant}.h"]

            for vf in variant_files:
                shutil.copy(
                    os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, vf),
                    os.path.join(build_dir, vf)
                )

    with open(os.path.join(build_dir, "Makefile"), "w") as mk:
        script_path = os.path.join(build_dir, "compile_frameos.sh")
        linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"]
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

        with open(os.path.join(source_dir, "tools", "nimc.Makefile"), "r") as mf_in:
            lines_make = mf_in.readlines()
        for ln in lines_make:
            if ln.startswith("LIBS = "):
                ln = "LIBS = -L. " + " ".join(linker_flags) + "\n"
            if ln.startswith("CFLAGS = "):
                ln = "CFLAGS = " + " ".join([f for f in compiler_flags if f != '-c']) + "\n"
            mk.write(ln)

    archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
    zip_base = os.path.join(temp_dir, f"build_{build_id}")
    shutil.make_archive(zip_base, 'gztar', temp_dir, f"build_{build_id}")
    return archive_path

