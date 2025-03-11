from datetime import datetime, timezone
import json
import hashlib
import os
import random
import re
import shutil
import string
import subprocess
import tempfile
from typing import Any, Optional

import asyncssh
from packaging import version
import platform

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


async def deploy_frame(id: int, redis: Redis):
    """Queue a job to deploy a frame by ID."""
    await redis.enqueue_job("deploy_frame", id=id)


async def deploy_frame_task(ctx: dict[str, Any], id: int):
    """
    Main deployment logic for building, packaging, and deploying
    the Nim (FrameOS) application onto a target device via SSH.
    """
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

        # We do not want to persist these fields if successful.
        frame_dict = frame.to_dict()
        frame_dict.pop("last_successful_deploy", None)
        frame_dict.pop("last_successful_deploy_at", None)

        frame.status = 'deploying'
        await update_frame(db, redis, frame)

        build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
        await log(db, redis, id, "stdout", f"Deploying frame {frame.name} with build id {build_id}")

        nim_path = find_nim_v2()
        ssh = await get_ssh_connection(db, redis, frame)

        async def install_if_necessary(pkg: str, raise_on_error=True) -> int:
            """
            Installs package `pkg` on the remote device if it's not already installed.
            """
            cmd = f"dpkg -l | grep -q \"^ii  {pkg}\" || sudo apt-get install -y {pkg}"
            return await exec_command(db, redis, frame, ssh, cmd, raise_on_error=raise_on_error)

        # 1. Detect target architecture on the remote device.
        await log(db, redis, id, "stdout", "- Getting target architecture")
        uname_output: list[str] = []
        await exec_command(db, redis, frame, ssh, "uname -m", uname_output)
        arch = "".join(uname_output).strip()

        # Simplify arch -> "arm64", "arm", "amd64", "i386" ...
        cpu = get_target_cpu(arch)

        # Check total memory (for Pi Zero, etc.) so we can stop the service during local (on-device) compile
        total_memory = 0
        try:
            mem_output: list[str] = []
            await exec_command(db, redis, frame, ssh, "free -m", mem_output)
            # mem_output[0]: "              total        used        free      shared  buff/cache   available"
            # mem_output[1]: "Mem:            991         223         ... etc."
            # We'll parse line 1
            total_memory = int(mem_output[1].split()[1])
        except Exception as e:
            await log(db, redis, id, "stderr", str(e))
        low_memory = total_memory < 512

        drivers = drivers_for_frame(frame)

        # 2. Build or cross-compile locally, then package up the result
        with tempfile.TemporaryDirectory() as temp_dir:
            await log(db, redis, id, "stdout", "- Copying build folders")
            build_dir, source_dir = create_build_folders(temp_dir, build_id)

            await log(db, redis, id, "stdout", "- Applying local modifications")
            await make_local_modifications(db, redis, frame, source_dir)

            await log(db, redis, id, "stdout", "- Creating build archive")

            # Decide if we can cross-compile for the target
            do_cross_compile = False
            cross_compiler = get_cross_compiler_for_cpu(cpu)
            if cross_compiler:
                response_code, _, _ = await exec_local_command(db, redis, frame, f"{cross_compiler} --version", generate_log=False)
                if response_code == 0:
                    do_cross_compile = True

            # 2A. Generate Nim -> C code. This always happens locally (we need the C code).
            archive_path = await create_local_build_archive(
                db, redis, frame,
                build_dir, build_id, nim_path, source_dir, temp_dir, cpu
            )

            # 2B. If cross-compiling is possible, actually produce final `frameos` locally.
            if do_cross_compile:
                await log(db, redis, id, "stdout", f"- Cross compiling for {cpu} using {cross_compiler}")
                cmd = f"cd {build_dir} && make clean && make CC={cross_compiler} -j$(nproc)"
                status, out, err = await exec_local_command(db, redis, frame, cmd)
                if status != 0:
                    raise Exception("Cross-compilation failed. See logs for details.")

                # Re-create the tar AFTER the final binary is present
                # We remove the old one, then tar again so it has `frameos` in it.
                os.remove(archive_path)
                archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
                zip_base = os.path.join(temp_dir, f"build_{build_id}")
                shutil.make_archive(zip_base, 'gztar', temp_dir, f"build_{build_id}")

            # 3. On low-memory devices, stop FrameOS if we must compile there
            #    i.e. we do NOT have cross_compiled.
            if not do_cross_compile and low_memory:
                await log(db, redis, id, "stdout", "- Low memory device, stopping FrameOS for compilation")
                await exec_command(db, redis, frame, ssh, "sudo service frameos stop", raise_on_error=False)

            # 4. Install build dependencies on device (only if we plan to compile on device)
            if not do_cross_compile:
                await install_if_necessary("build-essential")

            await install_if_necessary("ntp")  # Keep time in sync

            if drivers.get("evdev"):
                await install_if_necessary("libevdev-dev")

            # 4A. Install liblgpio if needed (for waveshare or gpioButton).
            if drivers.get("waveshare") or drivers.get("gpioButton"):
                check_lgpio = await exec_command(
                    db, redis, frame, ssh,
                    '[[ -f "/usr/local/include/lgpio.h" || -f "/usr/include/lgpio.h" ]] && exit 0 || exit 1',
                    raise_on_error=False
                )
                if check_lgpio != 0:
                    # Try installing liblgpio-dev
                    if await install_if_necessary("liblgpio-dev", raise_on_error=False) != 0:
                        await log(db, redis, id, "stdout", "--> Could not find liblgpio-dev. Installing from source.")
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
                        await exec_command(db, redis, frame, ssh, command)

            # 5. Check for app dependencies (APT packages declared in config.json)
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
                            elif node.get('type') == 'source':
                                json_config = node.get('sources', {}).get('config.json')
                                if json_config:
                                    config = json.loads(json_config)
                            if config and config.get('apt'):
                                for dep in config['apt']:
                                    all_deps.add(dep)
                        except Exception as e:
                            await log(db, redis, id, "stderr", f"Error parsing node: {e}")
                except Exception as e:
                    await log(db, redis, id, "stderr", f"Error parsing scene: {e}")

            for dep in all_deps:
                await install_if_necessary(dep)

            # Ensure /srv/frameos on device
            await exec_command(db, redis, frame, ssh,
                               "if [ ! -d /srv/frameos/ ]; then "
                               "  sudo mkdir -p /srv/frameos/ && sudo chown $(whoami):$(whoami) /srv/frameos/; "
                               "fi")

            await exec_command(db, redis, frame, ssh, "mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
            await log(db, redis, id, "stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")

            # 6. Upload the local tarball to the device
            await asyncssh.scp(
                archive_path,
                (ssh, f"/srv/frameos/build/build_{build_id}.tar.gz"),
                recurse=False
            )

            # 7. If we haven't cross-compiled locally, compile on the device
            await exec_command(
                db, redis, frame, ssh,
                f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz"
            )

            if not do_cross_compile:
                # device-based compile
                await exec_command(
                    db, redis, frame, ssh,
                    f"cd /srv/frameos/build/build_{build_id} && "
                    "PARALLEL_MEM=$(awk '/MemTotal/{printf \"%.0f\\n\", $2/1024/250}' /proc/meminfo) && "
                    "PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && "
                    "make -j$PARALLEL"
                )

            # 8. Move final binary into a release folder
            await exec_command(db, redis, frame, ssh, f"mkdir -p /srv/frameos/releases/release_{build_id}")
            await exec_command(
                db, redis, frame, ssh,
                f"cp /srv/frameos/build/build_{build_id}/frameos /srv/frameos/releases/release_{build_id}/frameos"
            )

            # 9. Upload frame.json to the new release
            frame_json_data = (json.dumps(get_frame_json(db, frame), indent=4) + "\n").encode('utf-8')
            with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmpf:
                local_json_path = tmpf.name
                tmpf.write(frame_json_data)

            await asyncssh.scp(
                local_json_path,
                (ssh, f"/srv/frameos/releases/release_{build_id}/frame.json"),
                recurse=False
            )
            os.remove(local_json_path)
            await log(db, redis, id, "stdout", f"> add /srv/frameos/releases/release_{build_id}/frame.json")

            # 10. Vendor steps for certain drivers
            if inkyPython := drivers.get("inkyPython"):
                await exec_command(db, redis, frame, ssh,
                                   f"mkdir -p /srv/frameos/vendor && "
                                   f"cp -r /srv/frameos/build/build_{build_id}/vendor/inkyPython /srv/frameos/vendor/")
                await install_if_necessary("python3-pip")
                await install_if_necessary("python3-venv")
                await exec_command(db, redis, frame, ssh,
                                   f"cd /srv/frameos/vendor/{inkyPython.vendor_folder} && "
                                   "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                                   "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                                   "(echo '> env/bin/pip3 install -r requirements.txt' && "
                                   "env/bin/pip3 install -r requirements.txt && "
                                   "sha256sum requirements.txt > requirements.txt.sha256sum))")

            if inkyHyperPixel2r := drivers.get("inkyHyperPixel2r"):
                await exec_command(db, redis, frame, ssh,
                                   f"mkdir -p /srv/frameos/vendor && "
                                   f"cp -r /srv/frameos/build/build_{build_id}/vendor/inkyHyperPixel2r /srv/frameos/vendor/")
                await install_if_necessary("python3-dev")
                await install_if_necessary("python3-pip")
                await install_if_necessary("python3-venv")
                await exec_command(db, redis, frame, ssh,
                                   f"cd /srv/frameos/vendor/{inkyHyperPixel2r.vendor_folder} && "
                                   "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                                   "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                                   "(echo '> env/bin/pip3 install -r requirements.txt' && "
                                   "env/bin/pip3 install -r requirements.txt && "
                                   "sha256sum requirements.txt > requirements.txt.sha256sum))")

            # 11. Upload and enable frameos.service
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

            await exec_command(db, redis, frame, ssh,
                               f"mkdir -p /srv/frameos/state && ln -s /srv/frameos/state "
                               f"/srv/frameos/releases/release_{build_id}/state")
            await exec_command(db, redis, frame, ssh,
                               f"sudo cp /srv/frameos/releases/release_{build_id}/frameos.service "
                               f"/etc/systemd/system/frameos.service")
            await exec_command(db, redis, frame, ssh, "sudo chown root:root /etc/systemd/system/frameos.service")
            await exec_command(db, redis, frame, ssh, "sudo chmod 644 /etc/systemd/system/frameos.service")

            # 12. Link new release to /srv/frameos/current
            await exec_command(db, redis, frame, ssh,
                               f"rm -rf /srv/frameos/current && "
                               f"ln -s /srv/frameos/releases/release_{build_id} /srv/frameos/current")

            # 13. Sync assets (upload new or changed files in /assets)
            await sync_assets(db, redis, frame, ssh)

            # Clean old builds
            await exec_command(db, redis, frame, ssh,
                               "cd /srv/frameos/build && ls -dt1 build_* | tail -n +11 | xargs rm -rf")
            await exec_command(db, redis, frame, ssh,
                               "cd /srv/frameos/build/cache && find . -type f \\( -atime +0 -a -mtime +0 \\) | xargs rm -rf")
            await exec_command(db, redis, frame, ssh,
                               "cd /srv/frameos/releases && "
                               "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" "
                               "| tail -n +11 | xargs rm -rf")

        # 14. Additional device config if needed
        boot_config = "/boot/config.txt"
        if await exec_command(db, redis, frame, ssh, "test -f /boot/firmware/config.txt", raise_on_error=False) == 0:
            boot_config = "/boot/firmware/config.txt"

        if drivers.get("i2c"):
            # Ensure i2c is enabled
            await exec_command(db, redis, frame, ssh,
                               f'grep -q "^dtparam=i2c_vc=on$" {boot_config} '
                               f'|| echo "dtparam=i2c_vc=on" | sudo tee -a {boot_config}')
            await exec_command(db, redis, frame, ssh,
                               'command -v raspi-config > /dev/null && '
                               'sudo raspi-config nonint get_i2c | grep -q "1" && { '
                               '  sudo raspi-config nonint do_i2c 0; echo "I2C enabled"; '
                               '} || echo "I2C already enabled"')

        if drivers.get("spi"):
            await exec_command(db, redis, frame, ssh, 'sudo raspi-config nonint do_spi 0')
        elif drivers.get("noSpi"):
            await exec_command(db, redis, frame, ssh, 'sudo raspi-config nonint do_spi 1')

        # On low memory devices, disable some apt timers
        if low_memory:
            await exec_command(
                db, redis, frame, ssh,
                "sudo systemctl mask apt-daily-upgrade && "
                "sudo systemctl mask apt-daily && "
                "sudo systemctl disable apt-daily.service apt-daily.timer apt-daily-upgrade.timer apt-daily-upgrade.service"
            )

        # Reboot or auto-restart logic
        if frame.reboot and frame.reboot.get('enabled') == 'true':
            cron_schedule = frame.reboot.get('crontab', '0 0 * * *')
            if frame.reboot.get('type') == 'raspberry':
                crontab = f"{cron_schedule} root /sbin/shutdown -r now"
            else:
                crontab = f"{cron_schedule} root systemctl restart frameos.service"
            await exec_command(db, redis, frame, ssh, f"echo '{crontab}' | sudo tee /etc/cron.d/frameos-reboot")
        else:
            await exec_command(db, redis, frame, ssh, "sudo rm -f /etc/cron.d/frameos-reboot")

        # Possibly append lines to the Pi boot config and require a reboot
        must_reboot = False
        if drivers.get("bootconfig"):
            for line in drivers["bootconfig"].lines:
                cmd = f'grep -q "^{line}" {boot_config}'
                if await exec_command(db, redis, frame, ssh, cmd, raise_on_error=False) != 0:
                    # not found in boot_config, so append
                    await exec_command(
                        db, redis, frame, ssh,
                        f'echo "{line}" | sudo tee -a {boot_config}',
                        log_output=False
                    )
                    must_reboot = True

        # Enable & start the service
        await exec_command(db, redis, frame, ssh, "sudo systemctl daemon-reload")
        await exec_command(db, redis, frame, ssh, "sudo systemctl enable frameos.service")

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)

        # Reboot if boot config changed
        if must_reboot:
            await update_frame(db, redis, frame)
            await log(db, redis, int(frame.id), "stdinfo", "Deployed! Rebooting device after boot config changes")
            await exec_command(db, redis, frame, ssh, "sudo reboot")
        else:
            await exec_command(db, redis, frame, ssh, "sudo systemctl restart frameos.service")
            await exec_command(db, redis, frame, ssh, "sudo systemctl status frameos.service")
            await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
    finally:
        if ssh is not None:
            await remove_ssh_connection(db, redis, ssh, frame)


def get_target_cpu(arch: str) -> str:
    """
    Map 'uname -m' output to something Nim expects in --cpu
    and that we can match with cross compilers.
    """
    if arch in ("aarch64", "arm64"):
        return "arm64"
    elif arch in ("armv6l", "armv7l"):
        return "arm"
    elif arch == "i386":
        return "i386"
    # Fallback
    return "amd64"


def get_cross_compiler_for_cpu(cpu: str) -> Optional[str]:
    """
    Return the cross-compiler command for a given CPU,
    or None if there's no well-known cross-compiler for that CPU.
    """
    if cpu == "arm64":
        return "aarch64-linux-gnu-gcc"
    elif cpu == "arm":
        return "arm-linux-gnueabihf-gcc"
    return None


def find_nim_v2():
    """
    Locate a Nim executable >= 2.0.0.
    Raises an exception if not found or if version < 2.0.0.
    """
    nim_path = find_nim_executable()
    if not nim_path:
        raise Exception("Nim executable not found")
    nim_version = get_nim_version(nim_path)
    if not nim_version or nim_version < version.parse("2.0.0"):
        raise Exception("Nim 2.0.0 or higher is required")
    return nim_path


def create_build_folders(temp_dir, build_id):
    """
    Create local build directories to store Nim source + build artifacts.
    Returns (build_dir, source_dir).
    """
    build_dir = os.path.join(temp_dir, f"build_{build_id}")
    source_dir = os.path.join(temp_dir, "frameos")
    os.makedirs(source_dir, exist_ok=True)
    shutil.copytree("../frameos", source_dir, dirs_exist_ok=True)
    os.makedirs(build_dir, exist_ok=True)
    return build_dir, source_dir


async def make_local_modifications(db: Session, redis: Redis,
                                   frame: Frame, source_dir: str):
    """
    Write out scene, app, driver code into the Nim sources
    according to the current frame config.
    """
    shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
    os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

    for node_id, sources in get_apps_from_scenes(list(frame.scenes)).items():
        app_id = "nodeapp_" + node_id.replace('-', '_')
        app_dir = os.path.join(source_dir, "src", "apps", app_id)
        os.makedirs(app_dir, exist_ok=True)
        for filename, code in sources.items():
            with open(os.path.join(app_dir, filename), "w") as f:
                f.write(code)

    # Write out each scene as scene_{id}.nim
    for scene in frame.scenes:
        try:
            scene_source = write_scene_nim(frame, scene)
            safe_id = re.sub(r'\W+', '', scene.get('id', 'default'))
            with open(os.path.join(source_dir, "src", "scenes", f"scene_{safe_id}.nim"), "w") as f:
                f.write(scene_source)
        except Exception as e:
            await log(db, redis, int(frame.id), "stderr",
                      f"Error writing scene \"{scene.get('name','')}\" "
                      f"({scene.get('id','default')}): {e}")
            raise

    # scenes.nim aggregator
    with open(os.path.join(source_dir, "src", "scenes", "scenes.nim"), "w") as f:
        source = write_scenes_nim(frame)
        f.write(source)
        if frame.debug:
            await log(db, redis, int(frame.id), "stdout", f"Generated scenes.nim:\n{source}")

    # drivers.nim
    drivers = drivers_for_frame(frame)
    with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as f:
        source = write_drivers_nim(drivers)
        f.write(source)
        if frame.debug:
            await log(db, redis, int(frame.id), "stdout", f"Generated drivers.nim:\n{source}")

    # waveshare driver if needed
    if drivers.get("waveshare"):
        with open(os.path.join(source_dir, "src", "drivers", "waveshare", "driver.nim"), "w") as wf:
            source = write_waveshare_driver_nim(drivers)
            wf.write(source)
            if frame.debug:
                await log(db, redis, int(frame.id), "stdout", f"Generated waveshare driver:\n{source}")


def compile_line_md5(input_str: str) -> str:
    """
    Hash of compile command line, ignoring certain flags
    (used in caching logic).
    """
    words = []
    ignore_next = False
    for word in input_str.split(' '):
        if word == '-I':
            ignore_next = True
        elif ignore_next or word.startswith("-I"):
            pass
        else:
            words.append(word)
    return hashlib.md5(" ".join(words).encode()).hexdigest()


async def create_local_build_archive(
    db: Session,
    redis: Redis,
    frame: Frame,
    build_dir: str,
    build_id: str,
    nim_path: str,
    source_dir: str,
    temp_dir: str,
    cpu: str
) -> str:
    """
    Run Nim to generate the C files (and Makefile scaffolding),
    then create a tar.gz of the build directory.
    Returns path to the .tar.gz.
    """
    drivers = drivers_for_frame(frame)
    # Copy vendor code if needed
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

    await log(db, redis, int(frame.id), "stdout", "- Generating source code for compilation.")

    debug_options = "--lineTrace:on" if frame.debug else ""
    cmd = (
        f"cd {source_dir} && nimble assets -y && nimble setup && "
        f"{nim_path} compile --os:linux --cpu:{cpu} "
        f"--compileOnly --genScript --nimcache:{build_dir} "
        f"{debug_options} src/frameos.nim 2>&1"
    )

    status, out, err = await exec_local_command(db, redis, frame, cmd)
    if status != 0:
        # Attempt to parse the last Nim error line for context
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
                    await log(db, redis, int(frame.id), "stdout",
                              f"Error in {rel_fn}:{line_nr}:{column}")
                    if 0 < line_nr <= len(all_lines):
                        line_text = all_lines[line_nr - 1]
                        await log(db, redis, int(frame.id), "stdout", f"Line {line_nr}: {line_text}")
                        caret_prefix = "......." + ('.' * (column - 1 + len(str(line_nr))))
                        await log(db, redis, int(frame.id), "stdout", f"{caret_prefix}^")
                else:
                    await log(db, redis, int(frame.id), "stdout",
                              f"Error in {fn}:{line_nr}:{column}")
        raise Exception("Failed to generate frameos sources")

    # Copy nimbase.h into build_dir
    nimbase_path = find_nimbase_file(nim_path)
    if not nimbase_path:
        raise Exception("nimbase.h not found")
    shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

    # If waveshare, copy the variant C/h files
    if waveshare := drivers.get('waveshare'):
        if waveshare.variant:
            variant_folder = get_variant_folder(waveshare.variant)
            util_files = ["Debug.h", "DEV_Config.c", "DEV_Config.h"]
            for uf in util_files:
                shutil.copy(
                    os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, uf),
                    os.path.join(build_dir, uf)
                )

            # color e-paper variants need bc-based filenames
            # e.g. EPD_2in9b -> EPD_2in9bc.(c/h)
            if waveshare.variant in [
                "EPD_2in9b", "EPD_2in9c", "EPD_2in13b", "EPD_2in13c",
                "EPD_4in2b", "EPD_4in2c", "EPD_5in83b", "EPD_5in83c",
                "EPD_7in5b", "EPD_7in5c"
            ]:
                c_file = re.sub(r'[bc]', 'bc', waveshare.variant)
                variant_files = [f"{waveshare.variant}.nim", f"{c_file}.c", f"{c_file}.h"]
            else:
                variant_files = [
                    f"{waveshare.variant}.nim",
                    f"{waveshare.variant}.c",
                    f"{waveshare.variant}.h"
                ]

            for vf in variant_files:
                shutil.copy(
                    os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, vf),
                    os.path.join(build_dir, vf)
                )

    # Generate a Makefile from the Nim-generated compile_frameos.sh + nimc.Makefile template
    with open(os.path.join(build_dir, "Makefile"), "w") as mk:
        script_path = os.path.join(build_dir, "compile_frameos.sh")
        linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"]
        compiler_flags: list[str] = []
        if os.path.isfile(script_path):
            with open(script_path, "r") as sc:
                lines_sc = sc.readlines()
            for line in lines_sc:
                if " -o frameos " in line and " -l" in line:
                    # This line typically has -o frameos -lpthread -lm etc.
                    linker_flags = [
                        fl.strip() for fl in line.split(' ')
                        if fl.startswith('-') and fl != '-o'
                    ]
                elif " -c " in line and not compiler_flags:
                    # Nim's compile command for each .c
                    compiler_flags = [
                        fl for fl in line.split(' ')
                        if fl.startswith('-') and not fl.startswith('-I')
                        and fl not in ['-o', '-c', '-D']
                    ]

        # Base Makefile template
        with open(os.path.join(source_dir, "tools", "nimc.Makefile"), "r") as mf_in:
            lines_make = mf_in.readlines()

        for ln in lines_make:
            if ln.startswith("LIBS = "):
                ln = "LIBS = -L. " + " ".join(linker_flags) + "\n"
            if ln.startswith("CFLAGS = "):
                # remove '-c' if present
                cf = [f for f in compiler_flags if f != '-c']
                ln = "CFLAGS = " + " ".join(cf) + "\n"
            mk.write(ln)

    # Finally, tar up the build directory (which includes .c, .h, Makefile, etc.)
    archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
    zip_base = os.path.join(temp_dir, f"build_{build_id}")
    shutil.make_archive(zip_base, 'gztar', temp_dir, f"build_{build_id}")
    return archive_path


def find_nim_executable():
    """
    Try 'nim' in PATH, else guess common install paths on each OS.
    """
    common_paths = {
        'Windows': [
            'C:\\Program Files\\Nim\\bin\\nim.exe',
            'C:\\Nim\\bin\\nim.exe'
        ],
        'Darwin': [
            '/opt/homebrew/bin/nim',
            '/usr/local/bin/nim'
        ],
        'Linux': [
            '/usr/bin/nim',
            '/usr/local/bin/nim',
            '/opt/nim/bin/nim',
        ]
    }
    if is_executable_in_path('nim'):
        return 'nim'
    os_type = platform.system()
    for path in common_paths.get(os_type, []):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def is_executable_in_path(executable: str):
    """
    Check if `executable` is callable from PATH.
    """
    try:
        subprocess.run([executable, '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except FileNotFoundError:
        return False


def get_nim_version(executable_path: str):
    """
    Return a parsed packaging.version.Version for nim --version.
    """
    try:
        result = subprocess.run([executable_path, '--version'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        # Typically: Nim Compiler Version 2.2.0 [MacOSX: arm64]
        output = result.stdout.split('\n')[0]
        # e.g. "Nim Compiler Version 2.2.0"
        parts = output.split()
        # The version is usually parts[3], but let's be defensive
        for p in parts:
            if re.match(r'^\d+(\.\d+){1,2}', p):
                return version.parse(p)
        return None
    except Exception as e:
        print(f"Error getting Nim version: {e}")
        return None


def find_nimbase_file(nim_executable: str):
    """
    Attempt to find nimbase.h in Nim's lib directory,
    scanning possible locations on each OS.
    """
    nimbase_paths: list[str] = []

    # Nim 2.x 'nim dump' can yield Nim paths in stderr
    try:
        nim_dump_output = subprocess.run(
            [nim_executable, "dump"], text=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        ).stderr
        # Collect lines that reference 'lib'
        nimbase_paths.extend(line for line in nim_dump_output.splitlines() if 'lib' in line)
    except subprocess.CalledProcessError as e:
        print(f"Error running 'nim dump': {e}")

    os_type = platform.system()
    if os_type == 'Darwin':
        nimbase_paths.append('/usr/local/lib/nim')
    elif os_type == 'Linux':
        nimbase_paths.append('/usr/lib/nim')
        nimbase_paths.append('/opt/nim/lib')
    elif os_type == 'Windows':
        nimbase_paths.append('C:\\Nim\\lib')

    # Also check Homebrew Cellar for Nim
    if os_type == 'Darwin':
        base_dir = '/opt/homebrew/Cellar/nim/'
        if os.path.exists(base_dir):
            for verdir in os.listdir(base_dir):
                nb_file = os.path.join(base_dir, verdir, 'nim', 'lib', 'nimbase.h')
                if os.path.isfile(nb_file):
                    return nb_file

    # See if any path leads to nimbase.h
    for path in nimbase_paths:
        nb_file = os.path.join(path, 'nimbase.h')
        if os.path.isfile(nb_file):
            return nb_file

    return None
